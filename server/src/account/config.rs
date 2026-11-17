use anyhow::{Context, bail};
use openidconnect::{IssuerUrl, core::CoreProviderMetadata};
use std::{env, sync::Arc, time::Duration};
use tokio::sync::Mutex;

pub struct AuthConfig {
    pub admin_path: String,
    pub public_origin: Option<String>,
    pub allowed_origins: Vec<String>,
    pub issuer: String,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub session_hours: i64,
    pub oidc_http: reqwest::Client,
    pub metadata: Mutex<Option<(std::time::Instant, CoreProviderMetadata)>>,
}
impl AuthConfig {
    pub fn from_env() -> anyhow::Result<Arc<Self>> {
        let path = validate_path(&env::var("ADMIN_PATH").unwrap_or_else(|_| "/admin".into()))?;
        let public_origin = env::var("PUBLIC_BASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .map(|s| validate_origin(&s))
            .transpose()?;
        let allowed_origins =
            validate_allowed_origins(&env::var("ALLOWED_ORIGINS").unwrap_or_default())?;
        let client_id = env::var("OIDC_CLIENT_ID")
            .ok()
            .filter(|s| !s.trim().is_empty());
        let client_secret = env::var("OIDC_CLIENT_SECRET")
            .ok()
            .filter(|s| !s.is_empty());
        if client_id.is_some() && (client_secret.is_none() || public_origin.is_none()) {
            bail!("OIDC_CLIENT_ID requires OIDC_CLIENT_SECRET and PUBLIC_BASE_URL");
        }
        let issuer =
            env::var("OIDC_ISSUER_URL").unwrap_or_else(|_| "https://accounts.google.com".into());
        let url = reqwest::Url::parse(&issuer).context("Invalid OIDC_ISSUER_URL")?;
        if url.scheme() != "https"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            bail!("OIDC issuer must be an HTTPS URL without credentials, query or fragment");
        }
        Ok(Arc::new(Self {
            admin_path: path,
            public_origin,
            allowed_origins,
            issuer,
            client_id,
            client_secret,
            session_hours: env::var("SESSION_HOURS")
                .ok()
                .and_then(|n| n.parse().ok())
                .unwrap_or(24)
                .clamp(1, 168),
            oidc_http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(12))
                .build()?,
            metadata: Mutex::new(None),
        }))
    }
    pub fn path(&self, suffix: &str) -> String {
        format!("{}{}", self.admin_path, suffix)
    }
    pub fn secure(&self) -> bool {
        self.public_origin
            .as_deref()
            .is_some_and(|s| s.starts_with("https://"))
    }
    pub fn callback(&self) -> String {
        format!(
            "{}{}",
            self.public_origin.as_deref().unwrap_or(""),
            self.path("/auth/oidc/callback")
        )
    }
    pub async fn provider(&self) -> anyhow::Result<CoreProviderMetadata> {
        let mut cache = self.metadata.lock().await;
        if let Some((at, data)) = &*cache {
            if at.elapsed() < Duration::from_secs(900) {
                return Ok(data.clone());
            }
        }
        let provider = CoreProviderMetadata::discover_async(
            IssuerUrl::new(self.issuer.clone())?,
            &self.oidc_http,
        )
        .await?;
        for endpoint in [
            Some(provider.authorization_endpoint().url()),
            provider.token_endpoint().map(|u| u.url()),
            Some(provider.jwks_uri().url()),
        ]
        .into_iter()
        .flatten()
        {
            if endpoint.scheme() != "https" {
                bail!("OIDC endpoints must use HTTPS");
            }
        }
        *cache = Some((std::time::Instant::now(), provider.clone()));
        Ok(provider)
    }
}
pub fn validate_path(value: &str) -> anyhow::Result<String> {
    let value = value.trim_end_matches('/');
    if !value.starts_with('/')
        || value.len() < 2
        || value.len() > 128
        || value.split('/').skip(1).any(|p| {
            p.is_empty()
                || p == "."
                || p == ".."
                || !p
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        })
        || matches!(value.split('/').nth(1), Some("api" | "ws"))
    {
        bail!(
            "ADMIN_PATH must be a non-root path such as /console, using letters, digits, - and _"
        );
    }
    Ok(value.into())
}
pub fn validate_origin(value: &str) -> anyhow::Result<String> {
    let u = reqwest::Url::parse(value)?;
    let local = matches!(u.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (u.scheme() != "https" && !(u.scheme() == "http" && local))
        || u.host_str().is_none()
        || u.path() != "/"
        || u.query().is_some()
        || u.fragment().is_some()
        || !u.username().is_empty()
        || u.password().is_some()
    {
        bail!(
            "PUBLIC_BASE_URL must be an HTTPS origin, e.g. https://logs.example.com (HTTP is allowed on localhost)"
        );
    }
    Ok(u.origin().ascii_serialization())
}

pub fn validate_allowed_origins(value: &str) -> anyhow::Result<Vec<String>> {
    let mut origins = Vec::new();
    for value in value.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        if value.contains('*') {
            bail!("ALLOWED_ORIGINS does not accept wildcards");
        }
        let origin = validate_origin(value)
            .context("ALLOWED_ORIGINS entries must be HTTPS origins without paths or wildcards")?;
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    Ok(origins)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_are_not_urls_or_router_patterns() {
        for p in [
            "/",
            "//console",
            "/api/private",
            "/a/../b",
            "/a%2fb",
            "/x?next=a",
            "/x/:id",
            "/x/*rest",
        ] {
            assert!(validate_path(p).is_err(), "{p}");
        }
        assert_eq!(validate_path("/ops/console/").unwrap(), "/ops/console");
    }
    #[test]
    fn public_origin_is_explicit() {
        assert!(validate_origin("https://logs.example.com").is_ok());
        assert!(validate_origin("http://localhost:4188").is_ok());
        for s in [
            "http://example.com",
            "https://example.com/console",
            "https://a:b@example.com",
            "https://example.com?x=1",
        ] {
            assert!(validate_origin(s).is_err());
        }
    }

    #[test]
    fn allowed_origins_are_explicit_normalized_and_deduplicated() {
        assert_eq!(
            validate_allowed_origins(
                " https://origin.example.com, https://NEXUS.example.com:443/,https://nexus.example.com,, "
            )
            .unwrap(),
            ["https://origin.example.com", "https://nexus.example.com"]
        );
        assert!(validate_allowed_origins(" ").unwrap().is_empty());
        for invalid in [
            "*",
            "https://*.example.com",
            "http://nexus.example.com",
            "https://nexus.example.com/admin",
            "https://user:pass@nexus.example.com",
            "https://nexus.example.com?x=1",
        ] {
            assert!(validate_allowed_origins(invalid).is_err(), "{invalid}");
        }
    }
}

#[cfg(test)]
mod origin_tests {
    use super::*;
    use axum::http::{HeaderMap, header};
    #[test]
    fn same_host_proxy_and_explicit_origins() {
        let mut config = AuthConfig {
            admin_path: "/admin".into(),
            public_origin: None,
            allowed_origins: Vec::new(),
            issuer: "https://accounts.google.com".into(),
            client_id: None,
            client_secret: None,
            session_hours: 24,
            oidc_http: reqwest::Client::new(),
            metadata: Mutex::new(None),
        };
        let mut h = HeaderMap::new();
        h.insert(header::HOST, "logs.example.com".parse().unwrap());
        for value in ["http://logs.example.com", "https://logs.example.com"] {
            h.insert(header::ORIGIN, value.parse().unwrap());
            assert!(crate::account::origin_allowed(&config, &h));
        }
        for value in [
            "null",
            "https://evil.example",
            "https://logs.example.com.evil.test",
            "https://logs.example.com/",
        ] {
            h.insert(header::ORIGIN, value.parse().unwrap());
            assert!(!crate::account::origin_allowed(&config, &h));
        }
        config.public_origin = Some("https://logs.example.com".into());
        h.insert(header::ORIGIN, "http://logs.example.com".parse().unwrap());
        assert!(!crate::account::origin_allowed(&config, &h));
        h.insert(header::ORIGIN, "https://logs.example.com".parse().unwrap());
        assert!(crate::account::origin_allowed(&config, &h));
        // Reproduce the upgrade regression: the page/GET APIs work on the
        // proxy alias, but the original single-origin policy rejects its WS.
        config.public_origin = Some("https://origin.example.com".into());
        h.insert(header::HOST, "origin.example.com".parse().unwrap());
        h.insert(header::ORIGIN, "https://nexus.example.com".parse().unwrap());
        assert!(!crate::account::origin_allowed(&config, &h));
        config.allowed_origins = validate_allowed_origins("https://nexus.example.com").unwrap();
        assert!(crate::account::origin_allowed(&config, &h));
        h.insert(header::ORIGIN, "https://origin.example.com".parse().unwrap());
        assert!(crate::account::origin_allowed(&config, &h));
        for origin in [
            "https://evil.example",
            "https://nexus.example.com.evil.example",
            "https://nexus.example.com:8443",
            "http://nexus.example.com",
            "null",
        ] {
            h.insert(header::ORIGIN, origin.parse().unwrap());
            h.insert("x-forwarded-host", "nexus.example.com".parse().unwrap());
            assert!(!crate::account::origin_allowed(&config, &h), "{origin}");
        }
        // An explicit list also works without OIDC/PUBLIC_BASE_URL, and does
        // not fall back to trusting arbitrary Host/forwarded headers.
        config.public_origin = None;
        h.insert(header::HOST, "evil.example".parse().unwrap());
        h.insert(header::ORIGIN, "https://evil.example".parse().unwrap());
        assert!(!crate::account::origin_allowed(&config, &h));
        h.insert(header::ORIGIN, "https://nexus.example.com".parse().unwrap());
        assert!(crate::account::origin_allowed(&config, &h));
    }
}
