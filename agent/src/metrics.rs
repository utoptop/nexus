use crate::{
    Result,
    config::Config,
    protocol::NodeMetrics,
    store::Store,
    transport::{self, Outcome},
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::watch;

type Counters = BTreeMap<String, (u64, u64)>;

#[derive(Serialize, Deserialize, Default)]
struct Accounting {
    boot_id: String,
    counters: Counters,
    pending_rx: u64,
    pending_tx: u64,
}

impl Accounting {
    fn sample(&mut self, boot_id: String, counters: Counters) -> Result<()> {
        if self.boot_id == boot_id {
            for (interface, (rx, tx)) in &counters {
                if let Some((old_rx, old_tx)) = self.counters.get(interface) {
                    // Interface counter reset: count the new epoch, never underflow.
                    let rx_delta = if rx >= old_rx { rx - old_rx } else { *rx };
                    let tx_delta = if tx >= old_tx { tx - old_tx } else { *tx };
                    self.pending_rx = self
                        .pending_rx
                        .checked_add(rx_delta)
                        .ok_or("RX counter overflow")?;
                    self.pending_tx = self
                        .pending_tx
                        .checked_add(tx_delta)
                        .ok_or("TX counter overflow")?;
                }
            }
        }
        self.boot_id = boot_id;
        self.counters = counters;
        Ok(())
    }
    fn payload(&self) -> NodeMetrics {
        // 3.2 counts speed*2 rather than cumulative totals. Retain all unacknowledged
        // bytes; the legacy wire fields are two-second equivalents, NOT catch-up
        // instantaneous speeds. Carry odd byte remainders into the next report.
        let cap = i64::MAX as u64 / 2;
        NodeMetrics {
            rx_bytes_total: self
                .counters
                .values()
                .fold(0u64, |sum, c| sum.saturating_add(c.0)),
            tx_bytes_total: self
                .counters
                .values()
                .fold(0u64, |sum, c| sum.saturating_add(c.1)),
            rx_speed_bps: (self.pending_rx / 2).min(cap),
            tx_speed_bps: (self.pending_tx / 2).min(cap),
        }
    }
    fn acknowledge(&mut self, payload: &NodeMetrics) -> Result<()> {
        self.pending_rx = self
            .pending_rx
            .checked_sub(payload.rx_speed_bps * 2)
            .ok_or("invalid RX acknowledgement")?;
        self.pending_tx = self
            .pending_tx
            .checked_sub(payload.tx_speed_bps * 2)
            .ok_or("invalid TX acknowledgement")?;
        Ok(())
    }
}

fn network_stats(contents: &str, selected: &[String]) -> Result<Counters> {
    let mut result = BTreeMap::new();
    for line in contents.lines().skip(2) {
        let Some((name, fields)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        let include = if selected.is_empty() {
            name != "lo"
                && !["docker", "veth", "br-", "wg", "tun", "tap"]
                    .iter()
                    .any(|prefix| name.starts_with(prefix))
        } else {
            selected.iter().any(|iface| iface == name)
        };
        if !include {
            continue;
        }
        let fields: Vec<_> = fields.split_whitespace().collect();
        if fields.len() < 9 {
            return Err(format!("truncated network statistics for {name}").into());
        }
        result.insert(name.to_owned(), (fields[0].parse()?, fields[8].parse()?));
    }
    if result.is_empty() {
        return Err("no monitored network interfaces in /proc/net/dev".into());
    }
    Ok(result)
}

async fn sample_loop(
    config: Arc<Config>,
    store: Store,
    sampled: watch::Sender<u64>,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let mut interval = tokio::time::interval(Duration::from_secs(2));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut failures = 0u64;
    let mut sequence = 0u64;
    loop {
        tokio::select! {_=crate::stopped(&mut stop)=>return Ok(()),_=interval.tick()=>{}}
        let read = async {
            let (contents, boot_id) = tokio::try_join!(
                tokio::fs::read_to_string("/proc/net/dev"),
                tokio::fs::read_to_string("/proc/sys/kernel/random/boot_id")
            )?;
            Ok::<_, crate::Error>((
                network_stats(&contents, &config.interfaces)?,
                boot_id.trim().to_owned(),
            ))
        }
        .await;
        let (counters, boot_id) = match read {
            Ok(sample) => {
                failures = 0;
                sample
            }
            Err(error) => {
                failures += 1;
                if failures == 1 || failures.is_multiple_of(30) {
                    eprintln!("metrics sampling unavailable: {error}; previous baseline retained");
                }
                continue;
            }
        };
        store
            .access(move |db| {
                let mut accounting =
                    Store::read_state::<Accounting>(db, "metrics")?.unwrap_or_default();
                accounting.sample(boot_id, counters)?;
                Store::save_state(db, "metrics", &accounting)
            })
            .await?;
        sequence = sequence.saturating_add(1);
        let _ = sampled.send(sequence);
    }
}

async fn send_loop(
    config: Arc<Config>,
    client: reqwest::Client,
    store: Store,
    ready: watch::Receiver<bool>,
    mut sampled: watch::Receiver<u64>,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let mut attempt = 0;
    loop {
        tokio::select! {
            _ = crate::stopped(&mut stop) => break,
            changed = sampled.changed() => if changed.is_err() { break; },
        }
        // Send after a committed sample, avoiding a race between independent timers.
        if *sampled.borrow_and_update() < 2 {
            continue;
        }
        if !*ready.borrow() {
            continue;
        }
        let payload = store
            .access(|db| {
                Ok(Store::read_state::<Accounting>(db, "metrics")?.map(|state| state.payload()))
            })
            .await?;
        let Some(payload) = payload else {
            continue;
        };
        match transport::post(
            &client,
            &config,
            &config.metrics_url,
            rmp_serde::to_vec_named(&payload)?,
            attempt,
        )
        .await
        {
            Outcome::Accepted => {
                store
                    .access(move |db| {
                        let mut accounting = Store::read_state::<Accounting>(db, "metrics")?
                            .ok_or("missing metric baseline")?;
                        accounting.acknowledge(&payload)?;
                        Store::save_state(db, "metrics", &accounting)
                    })
                    .await?;
                attempt = 0;
            }
            Outcome::Retry { delay, .. } => {
                attempt = attempt.saturating_add(1);
                if !crate::pause(delay, &mut stop).await {
                    break;
                }
            }
        }
    }
    Ok(())
}

pub async fn run(
    config: Arc<Config>,
    client: reqwest::Client,
    store: Store,
    ready: watch::Receiver<bool>,
    stop: watch::Receiver<bool>,
) -> Result<()> {
    let (sampled_tx, sampled_rx) = watch::channel(0);
    tokio::try_join!(
        sample_loop(config.clone(), store.clone(), sampled_tx, stop.clone()),
        send_loop(config, client, store, ready, sampled_rx, stop)
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn counters(rx: u64, tx: u64) -> Counters {
        BTreeMap::from([("eth0".into(), (rx, tx))])
    }
    #[test]
    fn outage_and_concurrent_samples_preserve_all_even_bytes() {
        let mut state = Accounting::default();
        state.sample("boot".into(), counters(100, 100)).unwrap();
        state.sample("boot".into(), counters(201, 205)).unwrap();
        let failed = state.payload();
        assert_eq!(failed.rx_speed_bps, 50);
        // Failed report: do not acknowledge. Next report includes it.
        state.sample("boot".into(), counters(302, 310)).unwrap();
        let sent = state.payload();
        assert_eq!(sent.rx_speed_bps * 2, 202);
        assert_eq!(sent.tx_speed_bps * 2, 210);
        // Sampling may continue while this request is in flight.
        state.sample("boot".into(), counters(305, 315)).unwrap();
        state.acknowledge(&sent).unwrap();
        assert_eq!((state.pending_rx, state.pending_tx), (3, 5));
        let sent = state.payload();
        state.acknowledge(&sent).unwrap();
        assert_eq!((state.pending_rx, state.pending_tx), (1, 1));
    }
    #[test]
    fn reboot_and_interface_reset_do_not_create_huge_deltas() {
        let mut state = Accounting::default();
        state.sample("boot".into(), counters(100, 100)).unwrap();
        state.sample("boot".into(), counters(110, 120)).unwrap();
        state.sample("new-boot".into(), counters(1, 2)).unwrap();
        assert_eq!((state.pending_rx, state.pending_tx), (10, 20));
        state.sample("new-boot".into(), counters(5, 8)).unwrap();
        state.sample("new-boot".into(), counters(2, 3)).unwrap();
        assert_eq!((state.pending_rx, state.pending_tx), (16, 29));
    }
    #[test]
    fn truncated_proc_data_is_an_error_and_interfaces_can_be_selected() {
        assert!(network_stats("header\nheader\neth0: 1 2 3 4 5 6 7 8", &[]).is_err());
        let proc = "header\nheader\neth0: 100 0 0 0 0 0 0 0 200\nlo: 999 0 0 0 0 0 0 0 999\neth1: 300 0 0 0 0 0 0 0 400\n";
        assert_eq!(
            network_stats(proc, &["eth1".into()]).unwrap(),
            BTreeMap::from([("eth1".into(), (300, 400))])
        );
        assert_eq!(network_stats(proc, &[]).unwrap().len(), 2);
    }
    #[tokio::test]
    async fn accounting_survives_agent_restart() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = crate::store::test_config(dir.path());
        let store = Store::open(&cfg).unwrap();
        store
            .access(|db| {
                let mut state = Accounting::default();
                state.sample("boot".into(), counters(100, 100))?;
                state.sample("boot".into(), counters(200, 200))?;
                Store::save_state(db, "metrics", &state)
            })
            .await
            .unwrap();
        drop(store);
        let store = Store::open(&cfg).unwrap();
        let payload = store
            .access(|db| {
                let mut state: Accounting = Store::read_state(db, "metrics")?.unwrap();
                state.sample("boot".into(), counters(300, 300))?;
                Ok(state.payload())
            })
            .await
            .unwrap();
        assert_eq!(payload.rx_speed_bps * 2, 200);
    }
}
