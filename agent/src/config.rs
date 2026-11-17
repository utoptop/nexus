use crate::Result;
use reqwest::{Url, header::HeaderValue};
use serde::Deserialize;
use std::{
    net::IpAddr,
    path::{Path, PathBuf},
};

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
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path).map_err(|_| {
            format!(
                "Cannot read configuration {} (use --config PATH)",
                path.display()
            )
        })?;
        Self::parse(&text, path.parent().unwrap_or(Path::new(".")))
    }
    fn parse(text: &str, base: &Path) -> Result<Self> {
        let file: FileConfig = toml::from_str(text).map_err(|e: toml::de::Error| {
            let line = text[..e.span().map_or(0, |s| s.start).min(text.len())].bytes().filter(|b| *b == b'\n').count()+1;
            format!("Invalid configuration near line {line}: check TOML syntax, field names and value types")
        })?;
        let server_url = Url::parse(required("server_url", &file.server_url)?)?;
        let metrics_url = if file.metrics_url.is_empty() {
            metrics_url(&server_url)?
        } else {
            Url::parse(file.metrics_url.trim())?
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
        let mut authorization = HeaderValue::from_str(&format!(
            "Bearer {}",
            required("auth_token", &file.auth_token)?
        ))?;
        authorization.set_sensitive(true);
        let node_ip = required("node_ip", &file.node_ip)?
            .parse::<IpAddr>()?
            .to_string();
        if file.monitor_containers.is_empty()
            || file.monitor_containers.iter().any(|s| s.trim().is_empty())
        {
            return Err(
                "monitor_containers must contain auto or one or more container names".into(),
            );
        }
        if file.monitor_containers.len() > 1 && file.monitor_containers.iter().any(|s| s == "auto")
        {
            return Err("monitor_containers cannot mix auto with explicit names".into());
        }
        let relative = |p: PathBuf| if p.is_absolute() { p } else { base.join(p) };
        Ok(Self {
            server_url,
            metrics_url,
            authorization,
            node_ip,
            batch_size: number("batch_size", file.batch_size, 1, 2000)?,
            docker_socket: relative(file.docker_socket),
            targets: file.monitor_containers.join(","),
            state_dir: relative(file.state_dir),
            queue_max_events: number("queue_max_events", file.queue_max_events, 2000, 10_000_000)?,
            queue_max_bytes: number(
                "queue_max_bytes",
                file.queue_max_bytes,
                1024 * 1024,
                16 * 1024 * 1024 * 1024,
            )?,
            interfaces: file
                .network_interfaces
                .iter()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
        })
    }
}

fn required<'a>(name: &str, value: &'a str) -> Result<&'a str> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{name} must be set").into());
    }
    Ok(value)
}

fn number(name: &str, value: usize, min: usize, max: usize) -> Result<usize> {
    if !(min..=max).contains(&value) {
        return Err(format!("{name} must be in {min}..={max}").into());
    }
    Ok(value)
}

fn metrics_url(server: &Url) -> Result<Url> {
    let prefix = server
        .path()
        .strip_suffix("/track_batch")
        .ok_or("server_url must end in /track_batch, or set metrics_url explicitly")?;
    let mut result = server.clone();
    result.set_path(&format!("{prefix}/node/metrics"));
    Ok(result)
}

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct FileConfig {
    server_url: String,
    metrics_url: String,
    auth_token: String,
    node_ip: String,
    batch_size: usize,
    monitor_containers: Vec<String>,
    state_dir: PathBuf,
    queue_max_events: usize,
    queue_max_bytes: usize,
    network_interfaces: Vec<String>,
    docker_socket: PathBuf,
}
impl Default for FileConfig {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            metrics_url: String::new(),
            auth_token: String::new(),
            node_ip: String::new(),
            batch_size: 500,
            monitor_containers: vec!["auto".into()],
            state_dir: "/var/lib/nexus-agent".into(),
            queue_max_events: 50_000,
            queue_max_bytes: 64 * 1024 * 1024,
            network_interfaces: Vec::new(),
            docker_socket: "/var/run/docker.sock".into(),
        }
    }
}

pub fn arguments() -> Result<Option<(PathBuf, bool)>> {
    let mut args = std::env::args_os().skip(1);
    let mut path = PathBuf::from("nexus-agent.toml");
    let mut check = false;
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--config") => path = args.next().ok_or("--config requires a path")?.into(),
            Some("--check-config") => check = true,
            Some("--version") => {
                println!("nexus-agent {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            Some("--help" | "-h") => {
                println!(
                    "nexus-agent [--config PATH] [--check-config]\nDefault file: nexus-agent.toml. Application environment variables and .env are not loaded."
                );
                return Ok(None);
            }
            _ => return Err("Unknown argument; use --help".into()),
        }
    }
    Ok(Some((path, check)))
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
    #[test]
    fn reads_typed_config_and_resolves_paths() {
        let text = "server_url='https://example.com/api/track_batch'\nauth_token='test'\nnode_ip='1.1.1.1'\nstate_dir='queue'\nmonitor_containers=['haproxy-main','nginx-main']\nnetwork_interfaces=['eth0']";
        let config = Config::parse(text, Path::new("/config")).unwrap();
        assert_eq!(config.state_dir, PathBuf::from("/config/queue"));
        assert_eq!(config.targets, "haproxy-main,nginx-main");
        assert_eq!(config.interfaces, vec!["eth0"]);
        assert!(Config::parse(&format!("{text}\nbatch_size=0"), Path::new(".")).is_err());
        let error = Config::parse(
            &format!("{text}\nunknown='secret-do-not-print'"),
            Path::new("."),
        )
        .err()
        .unwrap()
        .to_string();
        assert!(!error.contains("secret-do-not-print"));
        assert!(Config::parse("", Path::new(".")).is_err());
    }
}
