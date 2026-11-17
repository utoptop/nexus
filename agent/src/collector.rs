use crate::{
    Result,
    config::Config,
    docker::Docker,
    protocol::parse_line,
    store::{Cursor, Observation, Store},
};
use futures_util::TryStreamExt;
use std::{
    collections::HashMap,
    io,
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, BufReader},
    sync::{mpsc, watch},
    task::JoinSet,
};
use tokio_util::io::StreamReader;
const MAX_LINE_BYTES: usize = 64 * 1024;

pub async fn run(
    config: Arc<Config>,
    store: Store,
    tx: mpsc::Sender<Observation>,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let start: i64 = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)?
        .as_nanos()
        .try_into()?;
    let docker = Docker::new(config.docker_socket.clone());
    let mut monitors: HashMap<String, watch::Sender<bool>> = HashMap::new();
    let mut tasks = JoinSet::new();
    let mut scan = tokio::time::interval(Duration::from_secs(10));
    scan.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            _=crate::stopped(&mut stop)=>break,
            result=tasks.join_next(),if !tasks.is_empty()=>{
                let (id,result)=result.ok_or("missing collector task")??; monitors.remove(&id); result?;
            }
            _=scan.tick()=>{
                let targets=match docker.discover(&config.targets).await {
                    Ok(targets)=>targets,
                    Err(error)=>{eprintln!("Docker discovery: {error}");continue;}
                };
                if targets.is_empty(){eprintln!("no matching containers; rescanning in 10 seconds");}
                for id in targets {
                    if monitors.contains_key(&id){continue;}
                    let (cancel,cancelled)=watch::channel(false);monitors.insert(id.clone(),cancel);
                    let (store,tx,node_ip,docker)=(store.clone(),tx.clone(),config.node_ip.clone(),docker.clone());
                    tasks.spawn(async move {let result=monitor(&docker,&id,&node_ip,store,tx,start,cancelled).await;(id,result)});
                }
            }
        }
    }
    for cancel in monitors.values() {
        let _ = cancel.send(true);
    }
    while let Some(result) = tasks.join_next().await {
        result?.1?;
    }
    Ok(())
}

async fn monitor(
    docker: &Docker,
    id: &str,
    node_ip: &str,
    store: Store,
    tx: mpsc::Sender<Observation>,
    start: i64,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let out_source: Arc<str> = format!("{id}/stdout").into();
    let err_source: Arc<str> = format!("{id}/stderr").into();
    while !*stop.borrow() {
        let out = store.cursor(out_source.to_string(), start).await?;
        let err = store.cursor(err_source.to_string(), start).await?;
        let since = since_arg(out.timestamp.min(err.timestamp));
        let session = async {
            let (body, tty) = docker.logs(id, &since).await?;
            let reader = StreamReader::new(body.map_err(io::Error::other));
            let streams = [
                LogStream::new(out_source.clone(), out),
                LogStream::new(err_source.clone(), err),
            ];
            read_logs(reader, tty, streams, node_ip, &tx).await
        };
        let result =
            tokio::select! {_=crate::stopped(&mut stop)=>return Ok(()),result=session=>result};
        if let Err(error) = result {
            eprintln!("log stream {}: {error}", &id[..12]);
        }
        if !crate::pause(Duration::from_secs(5), &mut stop).await {
            break;
        }
        if docker.discover(id).await.is_ok_and(|ids| ids.is_empty()) {
            return Ok(());
        }
    }
    Ok(())
}

fn since_arg(timestamp: i64) -> String {
    let nanos = timestamp.saturating_sub(1).max(0);
    format!("{}.{:09}", nanos / 1_000_000_000, nanos % 1_000_000_000)
}

struct Replay {
    resume: Cursor,
    current: Cursor,
    replayed: i64,
}
impl Replay {
    fn new(resume: Cursor) -> Self {
        Self {
            resume,
            current: resume,
            replayed: 0,
        }
    }
    fn next(&mut self, timestamp: i64) -> Option<Cursor> {
        if timestamp < self.resume.timestamp {
            return None;
        }
        if timestamp == self.resume.timestamp {
            self.replayed += 1;
            if self.replayed <= self.resume.ordinal {
                return None;
            }
            self.current = Cursor {
                timestamp,
                ordinal: self.replayed,
            };
        } else if timestamp == self.current.timestamp {
            self.current.ordinal += 1;
        } else {
            self.current = Cursor {
                timestamp,
                ordinal: 1,
            };
        }
        Some(self.current)
    }
}

struct LogStream {
    source: Arc<str>,
    replay: Replay,
    line: Vec<u8>,
    truncated: bool,
    rejected: u64,
}
impl LogStream {
    fn new(source: Arc<str>, cursor: Cursor) -> Self {
        Self {
            source,
            replay: Replay::new(cursor),
            line: Vec::with_capacity(512),
            truncated: false,
            rejected: 0,
        }
    }
    async fn feed(
        &mut self,
        mut bytes: &[u8],
        node_ip: &str,
        tx: &mpsc::Sender<Observation>,
    ) -> Result<()> {
        while !bytes.is_empty() {
            let newline = bytes.iter().position(|&c| c == b'\n');
            let take = newline.map_or(bytes.len(), |index| index + 1);
            let keep = take.min(MAX_LINE_BYTES - self.line.len());
            self.line.extend_from_slice(&bytes[..keep]);
            self.truncated |= take > keep;
            if newline.is_some() {
                self.flush(node_ip, tx).await?;
            }
            bytes = &bytes[take..];
        }
        Ok(())
    }
    async fn flush(&mut self, node_ip: &str, tx: &mpsc::Sender<Observation>) -> Result<()> {
        let line = String::from_utf8_lossy(&self.line);
        let parsed = line.split_once(' ').and_then(|(stamp, body)| {
            chrono::DateTime::parse_from_rfc3339(stamp)
                .ok()?
                .timestamp_nanos_opt()
                .map(|ns| (ns, body))
        });
        if let Some((timestamp, body)) = parsed {
            if let Some(cursor) = self.replay.next(timestamp) {
                let parsed = if self.truncated {
                    Err("log line exceeds 64 KiB")
                } else {
                    parse_line(body.trim_end_matches(['\r', '\n']), node_ip)
                };
                let item = match parsed {
                    Ok(item) => item,
                    Err(reason) => {
                        self.rejected += 1;
                        if self.rejected == 1 || self.rejected.is_multiple_of(100) {
                            eprintln!(
                                "invalid logs from {}: count={}, reason={reason}",
                                self.source, self.rejected
                            );
                        }
                        None
                    }
                };
                tx.send(Observation {
                    source: self.source.clone(),
                    cursor,
                    item,
                })
                .await
                .map_err(|_| "queue writer stopped")?;
            }
        } else if !line.trim().is_empty() {
            eprintln!(
                "Docker diagnostic ({}): {}",
                self.source,
                line.chars().take(200).collect::<String>()
            );
        }
        self.line.clear();
        self.truncated = false;
        Ok(())
    }
}

async fn read_logs<R: AsyncRead + Unpin>(
    reader: R,
    tty: bool,
    mut streams: [LogStream; 2],
    node_ip: &str,
    tx: &mpsc::Sender<Observation>,
) -> Result<()> {
    let mut reader = BufReader::new(reader);
    let mut chunk = [0u8; 8192];
    if tty {
        loop {
            let count = reader.read(&mut chunk).await?;
            if count == 0 {
                break;
            }
            streams[0].feed(&chunk[..count], node_ip, tx).await?;
        }
    } else {
        loop {
            let mut header = [0u8; 8];
            if reader.read(&mut header[..1]).await? == 0 {
                break;
            }
            reader.read_exact(&mut header[1..]).await?;
            if header[1..4] != [0, 0, 0] || !(1..=2).contains(&header[0]) {
                return Err("invalid Docker log multiplex header".into());
            }
            let index = usize::from(header[0] - 1);
            let mut remaining = u32::from_be_bytes(header[4..].try_into()?) as usize;
            while remaining > 0 {
                let take = remaining.min(chunk.len());
                reader.read_exact(&mut chunk[..take]).await?;
                streams[index].feed(&chunk[..take], node_ip, tx).await?;
                remaining -= take;
            }
        }
    }
    for stream in &mut streams {
        if !stream.line.is_empty() {
            stream.flush(node_ip, tx).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
async fn read_stream<R: AsyncRead + Unpin>(
    mut reader: R,
    source: &str,
    cursor: Cursor,
    node_ip: &str,
    tx: &mpsc::Sender<Observation>,
) -> Result<()> {
    let mut stream = LogStream::new(source.into(), cursor);
    let mut chunk = [0; 4096];
    loop {
        let n = reader.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        stream.feed(&chunk[..n], node_ip, tx).await?;
    }
    if !stream.line.is_empty() {
        stream.flush(node_ip, tx).await?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn multiplexed_fragments_and_oversize_lines_keep_streams_separate() {
        let stamp = "2026-11-17T00:00:00.000000001Z";
        let make_frame = |kind: u8, body: &[u8]| {
            let mut frame = vec![kind, 0, 0, 0];
            frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
            frame.extend_from_slice(body);
            frame
        };
        let first = format!("{stamp} TRACK_L7|8.8.8.8|alpha");
        let error = format!("{stamp} TRACK_L7|9.9.9.9|beta\n");
        let large = format!(
            "{stamp} {}\n{stamp} TRACK_L7|8.8.4.4|gamma\n",
            "x".repeat(MAX_LINE_BYTES * 2)
        );
        let mut bytes = make_frame(1, first.as_bytes());
        bytes.extend(make_frame(2, error.as_bytes()));
        bytes.extend(make_frame(1, b"\n"));
        bytes.extend(make_frame(1, large.as_bytes()));
        let (tx, mut rx) = mpsc::channel(10);
        let cursor = Cursor {
            timestamp: 0,
            ordinal: 0,
        };
        read_logs(
            bytes.as_slice(),
            false,
            [
                LogStream::new("out".into(), cursor),
                LogStream::new("err".into(), cursor),
            ],
            "1.1.1.1",
            &tx,
        )
        .await
        .unwrap();
        drop(tx);
        let mut domains = Vec::new();
        while let Some(observation) = rx.recv().await {
            if let Some(item) = observation.item {
                domains.push(item.domain);
            }
        }
        domains.sort();
        assert_eq!(domains, vec!["alpha", "beta", "gamma"]);
    }
    #[tokio::test]
    async fn tty_stream_uses_stdout_cursor_without_mux_headers() {
        let bytes = b"2026-11-17T00:00:00Z TRACK_L7|8.8.8.8|tty\n";
        let (tx, mut rx) = mpsc::channel(10);
        let cursor = Cursor {
            timestamp: 0,
            ordinal: 0,
        };
        read_logs(
            bytes.as_slice(),
            true,
            [
                LogStream::new("out".into(), cursor),
                LogStream::new("err".into(), cursor),
            ],
            "1.1.1.1",
            &tx,
        )
        .await
        .unwrap();
        let event = rx.recv().await.unwrap();
        assert_eq!(&*event.source, "out");
        assert_eq!(event.item.unwrap().domain, "tty");
    }
    #[test]
    fn replay_keeps_new_events_at_same_timestamp() {
        let mut replay = Replay::new(Cursor {
            timestamp: 100,
            ordinal: 2,
        });
        assert!(replay.next(99).is_none());
        assert!(replay.next(100).is_none());
        assert!(replay.next(100).is_none());
        assert_eq!(
            replay.next(100),
            Some(Cursor {
                timestamp: 100,
                ordinal: 3
            })
        );
        assert_eq!(
            replay.next(101),
            Some(Cursor {
                timestamp: 101,
                ordinal: 1
            })
        );
        assert_eq!(since_arg(1_000_000_001), "1.000000000");
    }
    #[tokio::test]
    async fn reads_both_streams_and_resumes_without_duplicate_events() {
        let stamp = "2026-11-17T00:00:00.000000001Z";
        let timestamp = chrono::DateTime::parse_from_rfc3339(stamp)
            .unwrap()
            .timestamp_nanos_opt()
            .unwrap();
        let out = format!("{stamp} TRACK_L7|8.8.8.8|a\n{stamp} TRACK_L7|8.8.4.4|b\n");
        let err = format!("{stamp} TRACK_L7|9.9.9.9|c\n");
        let (tx, mut rx) = mpsc::channel(10);
        tokio::try_join!(
            read_stream(
                out.as_bytes(),
                "out",
                Cursor {
                    timestamp,
                    ordinal: 1
                },
                "1.1.1.1",
                &tx
            ),
            read_stream(
                err.as_bytes(),
                "err",
                Cursor {
                    timestamp,
                    ordinal: 0
                },
                "1.1.1.1",
                &tx
            )
        )
        .unwrap();
        drop(tx);
        let mut domains = Vec::new();
        while let Some(item) = rx.recv().await {
            domains.push(item.item.unwrap().domain);
        }
        domains.sort();
        assert_eq!(domains, vec!["b", "c"]);
    }
}
