use super::config::AuthConfig;
use serde::Deserialize;
use std::time::Duration;

const SITEVERIFY: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

#[derive(Deserialize)]
struct Verification {
    success: bool,
    action: Option<String>,
}

pub async fn verify(config: &AuthConfig, token: Option<&str>) -> bool {
    verify_at(config, token, SITEVERIFY).await
}

// The endpoint is fixed in production. Tests inject only a local fake verifier.
async fn verify_at(config: &AuthConfig, token: Option<&str>, endpoint: &str) -> bool {
    if !config.turnstile.enabled {
        return true;
    }
    let Some(token) = token.filter(|s| !s.trim().is_empty() && s.len() <= 2048) else {
        return false;
    };
    let result = config
        .oidc_http
        .post(endpoint)
        .timeout(Duration::from_secs(config.turnstile.timeout_seconds))
        .form(&[
            ("secret", config.turnstile.secret_key.as_str()),
            ("response", token),
        ])
        .send()
        .await;
    match result {
        Ok(response) if response.status().is_success() => response
            .json::<Verification>()
            .await
            .is_ok_and(|r| r.success && r.action.as_deref() == Some("login")),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, extract::Form, http::StatusCode, response::IntoResponse, routing::post};
    use std::{
        collections::HashMap,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    fn config(enabled: bool) -> Arc<AuthConfig> {
        let mut config = crate::config::Config::default();
        config.turnstile = crate::config::Turnstile {
            enabled,
            site_key: "test-site".into(),
            secret_key: "test-secret".into(),
            timeout_seconds: 1,
        };
        AuthConfig::from_config(&config).unwrap()
    }

    #[tokio::test]
    async fn switch_and_verification_fail_closed() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let app = Router::new().route(
            "/",
            post(move |Form(p): Form<HashMap<String, String>>| {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(p.get("secret").unwrap(), "test-secret");
                    match p.get("response").map(String::as_str) {
                        Some("ok") => {
                            (StatusCode::OK, r#"{"success":true,"action":"login"}"#).into_response()
                        }
                        Some("wrong-action") => {
                            (StatusCode::OK, r#"{"success":true,"action":"signup"}"#)
                                .into_response()
                        }
                        Some("missing-action") => {
                            (StatusCode::OK, r#"{"success":true}"#).into_response()
                        }
                        Some("bad-status") => (
                            StatusCode::BAD_GATEWAY,
                            r#"{"success":true,"action":"login"}"#,
                        )
                            .into_response(),
                        Some("bad-json") => (StatusCode::OK, "not json").into_response(),
                        Some("timeout") => {
                            tokio::time::sleep(Duration::from_secs(2)).await;
                            (StatusCode::OK, r#"{"success":true,"action":"login"}"#).into_response()
                        }
                        _ => (
                            StatusCode::OK,
                            r#"{"success":false,"error-codes":["timeout-or-duplicate"]}"#,
                        )
                            .into_response(),
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        assert!(verify_at(&config(false), None, &endpoint).await);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let config = config(true);
        assert!(!verify_at(&config, None, &endpoint).await);
        assert!(!verify_at(&config, Some(&"x".repeat(2049)), &endpoint).await);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(verify_at(&config, Some("ok"), &endpoint).await);
        for token in [
            "expired",
            "wrong-action",
            "missing-action",
            "bad-status",
            "bad-json",
            "timeout",
        ] {
            assert!(!verify_at(&config, Some(token), &endpoint).await, "{token}");
        }
        server.abort();
        assert!(!verify_at(&config, Some("ok"), &endpoint).await);
    }

    #[test]
    fn disabled_login_page_does_not_load_cloudflare_or_expose_saved_keys() {
        super::super::ui::load(std::path::Path::new("templates/assets")).unwrap();
        let disabled = super::super::ui::login_html(&config(false), None, "csrf");
        assert!(!disabled.contains("challenges.cloudflare.com"));
        assert!(!disabled.contains("test-site"));
        let enabled = super::super::ui::login_html(&config(true), None, "csrf");
        assert!(enabled.contains("challenges.cloudflare.com/turnstile/v0/api.js"));
        assert!(enabled.contains("data-action=\"login\""));
        assert!(enabled.contains("test-site"));
        assert!(!enabled.contains("test-secret"));
    }
}
