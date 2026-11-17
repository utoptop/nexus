use crate::{
    Result,
    config::Config,
    store::{Batch, Store},
};
use reqwest::{Client, StatusCode, Url, header::RETRY_AFTER};
use std::{
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::sync::watch;

#[derive(Debug)]
pub enum Outcome {
    Accepted,
    Retry {
        delay: Duration,
        status: Option<StatusCode>,
    },
}

pub async fn post(
    client: &Client,
    config: &Config,
    url: &Url,
    payload: Vec<u8>,
    attempt: u32,
) -> Outcome {
    match client
        .post(url.clone())
        .header("Authorization", config.authorization.clone())
        .header("X-Node-IP", &config.node_ip)
        .header("Content-Type", "application/msgpack")
        .body(payload)
        .send()
        .await
    {
        Ok(mut response) => {
            let status = response.status();
            let retry_after = response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|h| h.to_str().ok())
                .and_then(retry_after);
            // Consume small response bodies for connection reuse. The status is the ACK;
            // a truncated ACK body must not itself trigger duplicate ingestion.
            let mut size = 0;
            while let Ok(Some(chunk)) = response.chunk().await {
                size += chunk.len();
                if size >= 4096 {
                    break;
                }
            }
            if status.is_success() {
                return Outcome::Accepted;
            }
            let permanent = status.is_client_error()
                && status != StatusCode::TOO_MANY_REQUESTS
                && status != StatusCode::REQUEST_TIMEOUT
                && status != StatusCode::PAYLOAD_TOO_LARGE;
            let delay = retry_after.unwrap_or_else(|| {
                if permanent {
                    Duration::from_secs(60)
                } else {
                    backoff(attempt)
                }
            });
            eprintln!("upload rejected: HTTP {status}; data retained, retry in {delay:?}");
            Outcome::Retry {
                delay,
                status: Some(status),
            }
        }
        Err(error) => {
            let delay = backoff(attempt);
            eprintln!(
                "upload failed: {}; data retained, retry in {delay:?}",
                error.without_url()
            );
            Outcome::Retry {
                delay,
                status: None,
            }
        }
    }
}

fn backoff(attempt: u32) -> Duration {
    let jitter = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_millis() as u64
        % 500;
    Duration::from_millis((1u64 << attempt.min(6)).min(60) * 1000 + jitter)
}

fn retry_after(value: &str) -> Option<Duration> {
    value
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
        .or_else(|| {
            httpdate::parse_http_date(value)
                .ok()
                .map(|date| date.duration_since(SystemTime::now()).unwrap_or_default())
        })
        .map(|duration| duration.max(Duration::from_millis(100)))
}

pub async fn upload_batch(
    client: &Client,
    config: &Config,
    store: &Store,
    batch: Batch,
    attempt: u32,
) -> Result<Outcome> {
    let outcome = post(client, config, &config.server_url, batch.payload, attempt).await;
    if matches!(outcome, Outcome::Accepted) {
        store.acknowledge(batch.last_id).await?;
    }
    Ok(outcome)
}

pub async fn send_loop(
    config: Arc<Config>,
    client: Client,
    store: Store,
    ready: watch::Sender<bool>,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let mut attempt = 0;
    // Empty batches retain the 3.2 registration contract, without blocking collection.
    while !*stop.borrow() {
        let empty: Vec<crate::protocol::TrackItem> = Vec::new();
        match post(
            &client,
            &config,
            &config.server_url,
            rmp_serde::to_vec_named(&empty)?,
            attempt,
        )
        .await
        {
            Outcome::Accepted => {
                let _ = ready.send(true);
                break;
            }
            Outcome::Retry { delay, .. } => {
                attempt = attempt.saturating_add(1);
                if !crate::pause(delay, &mut stop).await {
                    return Ok(());
                }
            }
        }
    }
    attempt = 0;
    let mut limit = config.batch_size;
    while !*stop.borrow() {
        let Some(batch) = store.batch(limit).await? else {
            if !crate::pause(Duration::from_secs(1), &mut stop).await {
                break;
            }
            continue;
        };
        let count = batch.count;
        match upload_batch(&client, &config, &store, batch, attempt).await? {
            Outcome::Accepted => {
                attempt = 0;
            }
            Outcome::Retry { delay, status } => {
                attempt = attempt.saturating_add(1);
                if status == Some(StatusCode::PAYLOAD_TOO_LARGE) && count > 1 {
                    limit = (count / 2).max(1);
                    eprintln!("reducing batch size to {limit} after HTTP 413");
                }
                if !crate::pause(delay, &mut stop).await {
                    break;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    pub async fn mock(status: &str, extra: &str) -> (Url, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/api/track_batch", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let response =
            format!("HTTP/1.1 {status}\r\n{extra}Content-Length: 0\r\nConnection: close\r\n\r\n");
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0; 4096];
            let header_end = loop {
                let n = stream.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let headers = String::from_utf8_lossy(&bytes[..header_end]).to_lowercase();
            assert!(headers.contains("authorization: bearer test-token"));
            assert!(headers.contains("content-type: application/msgpack"));
            assert!(headers.contains("x-node-ip: 1.1.1.1"));
            let len: usize = headers
                .lines()
                .find_map(|l| l.strip_prefix("content-length: "))
                .unwrap()
                .parse()
                .unwrap();
            while bytes.len() < header_end + len {
                let n = stream.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
            }
            stream.write_all(response.as_bytes()).await.unwrap();
            bytes[header_end..].to_vec()
        });
        (url, task)
    }
    #[tokio::test]
    async fn failures_retain_durable_batch_until_success() {
        use crate::{
            protocol::TrackItem,
            store::{Cursor, Observation, test_config},
        };
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = test_config(dir.path());
        let store = Store::open(&cfg).unwrap();
        store.cursor("c/out".into(), 0).await.unwrap();
        store
            .enqueue(vec![Observation {
                source: "c/out".into(),
                cursor: Cursor {
                    timestamp: 1,
                    ordinal: 1,
                },
                item: Some(TrackItem {
                    ip: "8.8.8.8".into(),
                    domain: "x".into(),
                }),
            }])
            .await
            .unwrap();
        let client = Client::builder().no_proxy().build().unwrap();
        for status in [
            "503 Service Unavailable",
            "401 Unauthorized",
            "413 Payload Too Large",
            "429 Too Many Requests",
            "200 OK",
        ] {
            let (url, server) = mock(status, "Retry-After: 2\r\n").await;
            cfg.server_url = url;
            let result = upload_batch(
                &client,
                &cfg,
                &store,
                store.batch(100).await.unwrap().unwrap(),
                0,
            )
            .await
            .unwrap();
            if status.starts_with("200") {
                assert!(matches!(result, Outcome::Accepted));
                assert!(store.batch(100).await.unwrap().is_none());
            } else {
                assert!(
                    matches!(result,Outcome::Retry {delay,..} if delay==Duration::from_secs(2))
                );
                assert_eq!(store.batch(100).await.unwrap().unwrap().count, 1);
            }
            let items: Vec<TrackItem> = rmp_serde::from_slice(&server.await.unwrap()).unwrap();
            assert_eq!(items.len(), 1);
        }
    }
    #[test]
    fn handles_both_retry_after_formats() {
        assert_eq!(retry_after("3"), Some(Duration::from_secs(3)));
        let date = httpdate::fmt_http_date(SystemTime::now() + Duration::from_secs(10));
        let delay = retry_after(&date).unwrap();
        assert!(delay >= Duration::from_secs(8) && delay <= Duration::from_secs(10));
        assert!(retry_after("bad").is_none());
    }
}
