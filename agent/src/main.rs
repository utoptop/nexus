mod collector;
mod config;
mod docker;
mod metrics;
mod protocol;
mod store;
mod transport;

use std::{sync::Arc, time::Duration};
use tokio::sync::{mpsc, watch};

type Error = Box<dyn std::error::Error + Send + Sync>;
type Result<T> = std::result::Result<T, Error>;

fn main() -> Result<()> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()?
        .block_on(run())
}

async fn run() -> Result<()> {
    let Some((path, check)) = config::arguments()? else {
        return Ok(());
    };
    let config = Arc::new(config::Config::load(&path)?);
    if check {
        println!("Nexus Agent configuration is valid");
        return Ok(());
    }
    let store = store::Store::open(&config)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .pool_idle_timeout(Duration::from_secs(120))
        .build()?;
    let (stop_tx, stop_rx) = watch::channel(false);
    let (ready_tx, ready_rx) = watch::channel(false);
    let (tx, rx) = mpsc::channel(1024);
    eprintln!(
        "nexus-agent {}: node={}, queue={}",
        env!("CARGO_PKG_VERSION"),
        config.node_ip,
        config.state_dir.display()
    );

    // Collection starts before the handshake. The disk queue absorbs server outages.
    let mut collector = tokio::spawn(collector::run(
        config.clone(),
        store.clone(),
        tx,
        stop_rx.clone(),
    ));
    let mut writer = tokio::spawn(store::write_loop(store.clone(), rx, stop_rx.clone()));
    let mut sender = tokio::spawn(transport::send_loop(
        config.clone(),
        client.clone(),
        store.clone(),
        ready_tx,
        stop_rx.clone(),
    ));
    let mut metrics = tokio::spawn(metrics::run(config, client, store, ready_rx, stop_rx));
    let failure = tokio::select! {
        signal = shutdown_signal() => { signal?; None }
        result = &mut collector => Some(format!("collector stopped: {result:?}")),
        result = &mut writer => Some(format!("queue writer stopped: {result:?}")),
        result = &mut sender => Some(format!("sender stopped: {result:?}")),
        result = &mut metrics => Some(format!("metrics stopped: {result:?}")),
    };
    let _ = stop_tx.send(true);
    // Unacknowledged events stay on disk. Commit buffered observations on shutdown.
    let shutdown = async {
        if !collector.is_finished() {
            let _ = (&mut collector).await;
        }
        if !writer.is_finished() {
            let _ = (&mut writer).await;
        }
        if !sender.is_finished() {
            let _ = (&mut sender).await;
        }
        if !metrics.is_finished() {
            let _ = (&mut metrics).await;
        }
    };
    if tokio::time::timeout(Duration::from_secs(15), shutdown)
        .await
        .is_err()
    {
        eprintln!(
            "shutdown deadline reached; uncommitted logs will replay from Docker checkpoints"
        );
        collector.abort();
        writer.abort();
        sender.abort();
        metrics.abort();
    }
    if let Some(error) = failure {
        return Err(error.into());
    }
    Ok(())
}

async fn shutdown_signal() -> Result<()> {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! { result = tokio::signal::ctrl_c() => result?, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    Ok(())
}

async fn stopped(stop: &mut watch::Receiver<bool>) {
    if *stop.borrow() {
        return;
    }
    let _ = stop.wait_for(|value| *value).await;
}

async fn pause(duration: Duration, stop: &mut watch::Receiver<bool>) -> bool {
    tokio::select! { _ = stopped(stop) => false, _ = tokio::time::sleep(duration) => true }
}
