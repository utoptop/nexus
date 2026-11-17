use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use sqlx::postgres::PgConnectOptions;
use std::{
    path::{Path, PathBuf},
    str::FromStr,
};

#[derive(Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub server: Server,
    pub database: Database,
    pub auth: Auth,
    pub oidc: Oidc,
    pub turnstile: Turnstile,
    pub map: Map,
    pub limits: Limits,
}

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Server {
    pub listen_addr: String,
    pub log_filter: String,
    pub frontend_asset_dir: PathBuf,
    pub geoip_database: PathBuf,
}
impl Default for Server {
    fn default() -> Self {
        Self {
            listen_addr: "0.0.0.0:3000".into(),
            log_filter: "info".into(),
            frontend_asset_dir: "/app/templates/assets".into(),
            geoip_database: "/app/GeoLite2-City.mmdb".into(),
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Database {
    pub url: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub name: String,
    pub password_file: Option<PathBuf>,
    pub max_connections: u32,
}
impl Default for Database {
    fn default() -> Self {
        Self {
            url: String::new(),
            host: "db".into(),
            port: 5432,
            user: "nexus".into(),
            name: "nexus".into(),
            password_file: None,
            max_connections: 24,
        }
    }
}
impl Database {
    pub fn connect_options(&self) -> Result<PgConnectOptions> {
        if !self.url.is_empty() {
            ensure!(
                self.password_file.is_none(),
                "database.url and database.password_file are mutually exclusive"
            );
            // SQLx errors can include fragments of the connection URL. Do not log credentials.
            return PgConnectOptions::from_str(&self.url)
                .map_err(|_| anyhow::anyhow!("Invalid database.url"));
        }
        let path = self
            .password_file
            .as_ref()
            .context("Set database.password_file or database.url")?;
        let password =
            std::fs::read_to_string(path).context("Cannot read database.password_file")?;
        let password = password.trim_end_matches(['\r', '\n']);
        ensure!(
            !password.is_empty(),
            "database.password_file must not be empty"
        );
        ensure!(
            !self.host.trim().is_empty()
                && !self.user.trim().is_empty()
                && !self.name.trim().is_empty()
                && self.port > 0,
            "database host, user, name and port must be set"
        );
        Ok(PgConnectOptions::new()
            .host(&self.host)
            .port(self.port)
            .username(&self.user)
            .database(&self.name)
            .password(password))
    }
}

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Auth {
    pub admin_path: String,
    pub public_base_url: String,
    pub allowed_origins: Vec<String>,
    pub session_hours: i64,
    pub initial_username: String,
    pub initial_password: String,
}
impl Default for Auth {
    fn default() -> Self {
        Self {
            admin_path: "/admin".into(),
            public_base_url: String::new(),
            allowed_origins: Vec::new(),
            session_hours: 24,
            initial_username: "admin".into(),
            initial_password: String::new(),
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Oidc {
    pub issuer_url: String,
    pub client_id: String,
    pub client_secret: String,
}
impl Default for Oidc {
    fn default() -> Self {
        Self {
            issuer_url: "https://accounts.google.com".into(),
            client_id: String::new(),
            client_secret: String::new(),
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Turnstile {
    pub enabled: bool,
    pub site_key: String,
    pub secret_key: String,
    pub timeout_seconds: u64,
}
impl Default for Turnstile {
    fn default() -> Self {
        Self {
            enabled: false,
            site_key: String::new(),
            secret_key: String::new(),
            timeout_seconds: 10,
        }
    }
}
impl Turnstile {
    pub fn validate(&self) -> Result<()> {
        if self.enabled {
            ensure!(
                !self.site_key.trim().is_empty() && !self.secret_key.trim().is_empty(),
                "turnstile.enabled requires both turnstile.site_key and turnstile.secret_key"
            );
        }
        range("turnstile.timeout_seconds", self.timeout_seconds, 1, 30)
    }
}

#[derive(Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Map {
    pub api_key: String,
    pub tile_url: String,
}

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Limits {
    pub geo_cache_mb: u64,
    pub ingest_concurrency: usize,
    pub live_queue_capacity: usize,
    pub log_queue_capacity: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            geo_cache_mb: 16,
            ingest_concurrency: 64,
            live_queue_capacity: 8192,
            log_queue_capacity: 16384,
        }
    }
}

fn range<T: PartialOrd>(name: &str, value: T, min: T, max: T) -> Result<()> {
    ensure!(
        value >= min && value <= max,
        "{name} is outside its supported range"
    );
    Ok(())
}
impl Config {
    pub fn parse(text: &str) -> Result<Self> {
        let config: Self = toml::from_str(text).map_err(|e: toml::de::Error| {
            let line = text[..e.span().map_or(0, |s| s.start).min(text.len())].bytes().filter(|b| *b == b'\n').count() + 1;
            anyhow::anyhow!("Invalid configuration near line {line}: check TOML syntax, field names and value types")
        })?;
        config
            .server
            .listen_addr
            .parse::<std::net::SocketAddr>()
            .context("Invalid server.listen_addr")?;
        tracing_subscriber::EnvFilter::try_new(&config.server.log_filter)
            .map_err(|_| anyhow::anyhow!("Invalid server.log_filter"))?;
        range(
            "database.max_connections",
            config.database.max_connections,
            4,
            128,
        )?;
        range("auth.session_hours", config.auth.session_hours, 1, 168)?;
        range("limits.geo_cache_mb", config.limits.geo_cache_mb, 1, 256)?;
        range(
            "limits.ingest_concurrency",
            config.limits.ingest_concurrency,
            4,
            512,
        )?;
        range(
            "limits.live_queue_capacity",
            config.limits.live_queue_capacity,
            512,
            65536,
        )?;
        range(
            "limits.log_queue_capacity",
            config.limits.log_queue_capacity,
            1024,
            131072,
        )?;
        config.turnstile.validate()?;
        ensure!(
            !config.auth.initial_username.trim().is_empty()
                && config.auth.initial_username.len() <= 64,
            "auth.initial_username must contain 1–64 bytes"
        );
        if !config.auth.initial_password.is_empty() {
            ensure!(
                crate::account::valid_password(&config.auth.initial_password),
                "auth.initial_password must contain 12–1024 bytes"
            );
        }
        Ok(config)
    }
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| {
            format!(
                "Cannot read configuration {} (use --config PATH)",
                path.display()
            )
        })?;
        let mut config = Self::parse(&text)?;
        let base = path.parent().unwrap_or(Path::new("."));
        for p in [
            &mut config.server.frontend_asset_dir,
            &mut config.server.geoip_database,
        ] {
            if p.is_relative() {
                *p = base.join(&*p);
            }
        }
        if let Some(p) = &mut config.database.password_file {
            if p.is_relative() {
                *p = base.join(&*p);
            }
        }
        Ok(config)
    }
}

pub fn arguments() -> Result<Option<(PathBuf, bool)>> {
    let mut args = std::env::args_os().skip(1);
    let mut path = PathBuf::from("nexus.toml");
    let mut check = false;
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--config") => path = args.next().context("--config requires a path")?.into(),
            Some("--check-config") => check = true,
            Some("--version") => {
                println!("nexus {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            Some("--help" | "-h") => {
                println!(
                    "nexus [--config PATH] [--check-config]\nDefault file: nexus.toml. Application environment variables and .env are not loaded."
                );
                return Ok(None);
            }
            _ => bail!("Unknown argument; use --help"),
        }
    }
    Ok(Some((path, check)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_switches_and_rejects_typos_without_leaking_values() {
        assert!(!Config::parse("").unwrap().turnstile.enabled);
        assert!(Config::parse("[turnstile]\nenabled=true\nsite_key='site'").is_err());
        assert!(
            Config::parse("[turnstile]\nenabled=true\nsite_key='site'\nsecret_key='secret'")
                .is_ok()
        );
        assert!(Config::parse("[turnstile]\nenabled=false\nsite_key='saved-key'").is_ok());
        let error = Config::parse("[turnstile]\nenabeld='do-not-print-me'")
            .err()
            .unwrap()
            .to_string();
        assert!(!error.contains("do-not-print-me"));
        assert!(Config::parse("[limits]\ngeo_cache_mb=0").is_err());
        assert!(Config::parse("[auth]\nsession_hours=0").is_err());
    }
    #[test]
    fn database_url_and_password_file_cannot_silently_override_each_other() {
        let db = Database {
            url: "postgres://nexus:secret@db/nexus".into(),
            password_file: Some("password".into()),
            ..Database::default()
        };
        assert!(db.connect_options().is_err());
    }
}
