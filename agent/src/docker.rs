//! Read-only Docker Engine HTTP API over a Unix socket; no Docker CLI processes.
use crate::Result;
use hyper::{Body, Request, Response, body::HttpBody};
use serde::Deserialize;
use std::{collections::HashSet, path::PathBuf, sync::Arc, time::Duration};
use tokio::net::UnixStream;

#[derive(Clone)]
pub struct Docker {
    socket: Arc<PathBuf>,
}

#[derive(Deserialize)]
struct Container {
    #[serde(rename = "Id")]
    id: String,
    #[serde(rename = "Names", default)]
    names: Vec<String>,
    #[serde(rename = "Image", default)]
    image: String,
}

impl Docker {
    pub fn new(socket: PathBuf) -> Self {
        Self {
            socket: Arc::new(socket),
        }
    }

    async fn request(&self, path: &str) -> Result<Response<Body>> {
        let request = Request::builder()
            .uri(path)
            .header("Host", "localhost")
            .header("Connection", "close")
            .body(Body::empty())?;
        // Only connection/headers are timed out; a healthy log stream can be idle.
        tokio::time::timeout(Duration::from_secs(5), async {
            let stream = UnixStream::connect(self.socket.as_ref()).await?;
            let (mut sender, connection) = hyper::client::conn::handshake(stream).await?;
            tokio::spawn(async move {
                let _ = connection.await;
            });
            Ok::<_, crate::Error>(sender.send_request(request).await?)
        })
        .await?
    }

    async fn json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        let response = self.request(path).await?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("Docker API {path}: HTTP {status}").into());
        }
        let bytes = tokio::time::timeout(Duration::from_secs(5), async {
            let mut body = response.into_body();
            let mut bytes = Vec::new();
            while let Some(chunk) = body.data().await {
                let chunk = chunk?;
                if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                    return Err::<_, crate::Error>("Docker metadata exceeds 2 MiB".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        })
        .await??;
        Ok(serde_json::from_slice(&bytes)?)
    }

    pub async fn discover(&self, targets: &str) -> Result<HashSet<String>> {
        let auto = targets.trim().is_empty() || targets.trim().eq_ignore_ascii_case("auto");
        // These stable read-only endpoints are deliberately unversioned so a newer
        // daemon's minimum API version cannot strand an otherwise compatible agent.
        let containers: Vec<Container> = self
            .json(if auto {
                "/containers/json"
            } else {
                "/containers/json?all=1"
            })
            .await?;
        Ok(containers
            .into_iter()
            .filter(|c| {
                if auto {
                    let image = c.image.to_ascii_lowercase();
                    image.contains("haproxy")
                        || image.contains("nginx")
                        || c.names.iter().any(|name| {
                            let name = name.to_ascii_lowercase();
                            name.contains("haproxy") || name.contains("nginx")
                        })
                } else {
                    targets
                        .split(',')
                        .map(str::trim)
                        .filter(|t| !t.is_empty())
                        .any(|target| {
                            c.id.starts_with(target)
                                || c.names
                                    .iter()
                                    .any(|name| name.trim_start_matches('/') == target)
                        })
                }
            })
            .filter(|c| valid_id(&c.id))
            .map(|c| c.id)
            .collect())
    }

    pub async fn logs(&self, id: &str, since: &str) -> Result<(Body, bool)> {
        if !valid_id(id) {
            return Err("invalid container ID".into());
        }
        #[derive(Deserialize)]
        struct Info {
            #[serde(rename = "Config")]
            config: Tty,
        }
        #[derive(Deserialize)]
        struct Tty {
            #[serde(rename = "Tty", default)]
            tty: bool,
        }
        let info: Info = self.json(&format!("/containers/{id}/json")).await?;
        let response = self
            .request(&format!(
                "/containers/{id}/logs?stdout=1&stderr=1&follow=1&timestamps=1&since={since}"
            ))
            .await?;
        if !response.status().is_success() {
            return Err(format!("Docker logs: HTTP {}", response.status()).into());
        }
        Ok((response.into_body(), info.config.tty))
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}
