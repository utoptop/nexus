use crate::Result;
use reqwest::{Url, header::HeaderValue};
use std::{env, net::IpAddr, path::PathBuf};

#[derive(Clone)]
pub struct Config {
    pub server_url: Url,
    pub metrics_url: Url,
    pub authorization: HeaderValue,
    pub node_ip: String,
    pub batch_size: usize,
    pub targets: String,
    pub state_dir: PathBuf,
    pub queue_max_events: usize,
    pub queue_max_bytes: usize,
    pub interfaces: Vec<String>,
    pub docker_socket: PathBuf,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let server_url = Url::parse(&required("SERVER_URL")?)?;
        let metrics_url = match env::var("METRICS_URL") {
            Ok(value) => Url::parse(value.trim())?,
            Err(_) => metrics_url(&server_url)?,
        };
        for url in [&server_url, &metrics_url] {
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
            {
                return Err("API URL must be http(s), without credentials or fragment".into());
            }
        }
        let mut authorization =
            HeaderValue::from_str(&format!("Bearer {}", required("AUTH_TOKEN")?))?;
        authorization.set_sensitive(true);
        let node_ip = required("NODE_IP")?.parse::<IpAddr>()?.to_string();
        Ok(Self {
            server_url,
            metrics_url,
            authorization,
            node_ip,
            batch_size: number("BATCH_SIZE", 500, 1, 2000)?,
            docker_socket: env::var_os("DOCKER_SOCKET")
                .map(PathBuf::from)
                .unwrap_or_else(|| "/var/run/docker.sock".into()),
            targets: env::var("MONITOR_CONTAINERS").unwrap_or_else(|_| "auto".into()),
            state_dir: env::var_os("STATE_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| "./data".into()),
            queue_max_events: number("QUEUE_MAX_EVENTS", 50_000, 2000, 10_000_000)?,
            queue_max_bytes: number(
                "QUEUE_MAX_BYTES",
                64 * 1024 * 1024,
                1024 * 1024,
                16 * 1024 * 1024 * 1024,
            )?,
            interfaces: env::var("NETWORK_INTERFACES")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
        })
    }
}

fn required(name: &str) -> Result<String> {
    let value = env::var(name).unwrap_or_default().trim().to_owned();
    if value.is_empty() {
        return Err(format!("{name} must be set").into());
    }
    Ok(value)
}

fn number(name: &str, default: usize, min: usize, max: usize) -> Result<usize> {
    let value = match env::var(name) {
        Ok(value) => value.parse()?,
        Err(_) => default,
    };
    if !(min..=max).contains(&value) {
        return Err(format!("{name} must be in {min}..={max}").into());
    }
    Ok(value)
}

fn metrics_url(server: &Url) -> Result<Url> {
    let prefix = server
        .path()
        .strip_suffix("/track_batch")
        .ok_or("SERVER_URL must end in /track_batch, or set METRICS_URL explicitly")?;
    let mut result = server.clone();
    result.set_path(&format!("{prefix}/node/metrics"));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn derives_only_the_url_path() {
        let url = Url::parse("https://example.com/prefix/api/track_batch?q=/track_batch").unwrap();
        assert_eq!(
            metrics_url(&url).unwrap().as_str(),
            "https://example.com/prefix/api/node/metrics?q=/track_batch"
        );
        assert!(metrics_url(&Url::parse("https://example.com/other").unwrap()).is_err());
    }
}
