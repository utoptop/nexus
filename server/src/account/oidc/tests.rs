use super::*;
use chrono::{Duration, Utc};
use openidconnect::{
    Audience, EndUserEmail, IssuerUrl, PrivateSigningKey, StandardClaims, SubjectIdentifier,
    core::{
        CoreIdToken, CoreIdTokenClaims, CoreIdTokenVerifier, CoreJsonWebKeySet,
        CoreJwsSigningAlgorithm, CoreProviderMetadata, CoreRsaPrivateSigningKey,
    },
};
fn key() -> CoreRsaPrivateSigningKey {
    CoreRsaPrivateSigningKey::from_pem(
        include_str!("../../../tests/fixtures/oidc-test-only.pem"),
        None,
    )
    .unwrap()
}
fn signed(issuer: &str, aud: &str, nonce: &str, expires: i64, issued: i64) -> CoreIdToken {
    let claims = CoreIdTokenClaims::new(
        IssuerUrl::new(issuer.into()).unwrap(),
        vec![Audience::new(aud.into())],
        Utc::now() + Duration::seconds(expires),
        Utc::now() + Duration::seconds(issued),
        StandardClaims::new(SubjectIdentifier::new("google-subject-123".into()))
            .set_email(Some(EndUserEmail::new("same-email@example.test".into())))
            .set_email_verified(Some(true)),
        Default::default(),
    )
    .set_nonce(Some(Nonce::new(nonce.into())));
    CoreIdToken::new(
        claims,
        &key(),
        CoreJwsSigningAlgorithm::RsaSsaPkcs1V15Sha256,
        None,
        None,
    )
    .unwrap()
}
#[test]
fn rejects_bad_oidc_claims_and_signatures() {
    let issuer = "https://accounts.google.com";
    let verifier = CoreIdTokenVerifier::new_public_client(
        ClientId::new("qa-client".into()),
        IssuerUrl::new(issuer.into()).unwrap(),
        CoreJsonWebKeySet::new(vec![key().as_verification_key()]),
    );
    let nonce = Nonce::new("nonce".into());
    assert!(
        verified_claims(
            &signed(issuer, "qa-client", "nonce", 300, 0),
            &verifier,
            &nonce
        )
        .is_ok()
    );
    for token in [
        signed(issuer, "wrong-client", "nonce", 300, 0),
        signed("https://evil.example", "qa-client", "nonce", 300, 0),
        signed(issuer, "qa-client", "wrong", 300, 0),
        signed(issuer, "qa-client", "nonce", -300, 0),
        signed(issuer, "qa-client", "nonce", 300, 300),
    ] {
        assert!(verified_claims(&token, &verifier, &nonce).is_err());
    }
    let token = signed(issuer, "qa-client", "nonce", 300, 0).to_string();
    let mut parts: Vec<String> = token.split('.').map(str::to_owned).collect();
    let replacement = if &parts[2][..1] == "A" { "B" } else { "A" };
    parts[2].replace_range(0..1, replacement);
    let token: CoreIdToken = parts.join(".").parse().unwrap();
    assert!(verified_claims(&token, &verifier, &nonce).is_err());
}
#[tokio::test]
#[ignore = "requires disposable NEXUS_TEST_DATABASE_URL"]
async fn oidc_roundtrip_browser_binding_replay_and_pending_approval() {
    use arc_swap::ArcSwap;
    use moka::future::Cache;
    use std::collections::VecDeque;
    use std::sync::{Arc, atomic::AtomicU64};
    use tokio::sync::{Mutex, Semaphore, broadcast, mpsc};
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(4)
        .connect(&std::env::var("NEXUS_TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let token = Arc::new(Mutex::new(String::new()));
    let token_copy = token.clone();
    let router=axum::Router::new().route("/token",post(move|Form(p):Form<std::collections::HashMap<String,String>>|{let t=token_copy.clone();async move{assert_eq!(p.get("code_verifier").map(String::as_str),Some("verifier"));assert_eq!(p.get("grant_type").map(String::as_str),Some("authorization_code"));Json(serde_json::json!({"access_token":"test-access","token_type":"Bearer","id_token":t.lock().await.clone()}))}}));
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let metadata:CoreProviderMetadata=serde_json::from_value(serde_json::json!({"issuer":issuer,"authorization_endpoint":format!("{issuer}/authorize"),"token_endpoint":format!("{issuer}/token"),"jwks_uri":format!("{issuer}/jwks"),"response_types_supported":["code"],"subject_types_supported":["public"],"id_token_signing_alg_values_supported":["RS256"]})).unwrap();
    let metadata = metadata.set_jwks(CoreJsonWebKeySet::new(vec![key().as_verification_key()]));
    let auth = Arc::new(AuthConfig {
        admin_path: "/qa/console".into(),
        public_origin: Some("http://localhost".into()),
        allowed_origins: Vec::new(),
        issuer: issuer.clone(),
        client_id: Some("qa-client".into()),
        client_secret: Some("qa-secret".into()),
        session_hours: 1,
        turnstile: crate::config::Turnstile::default(),
        oidc_http: reqwest::Client::new(),
        metadata: Mutex::new(Some((std::time::Instant::now(), metadata))),
    });
    let (tx, _) = broadcast::channel(1);
    let (metrics_tx, _) = broadcast::channel(1);
    let (ws_tx, _) = mpsc::channel(1);
    let (log_tx, _) = mpsc::channel(1);
    let (op_tx, _) = mpsc::channel(1);
    let state = AppState {
        config: Arc::new(crate::config::Config::default()),
        db: db.clone(),
        auth,
        server_loc: Arc::new(ArcSwap::from_pointee(crate::models::ServerLocation {
            lat: 0.,
            lon: 0.,
            city: String::new(),
        })),
        tx,
        ingest_slots: Arc::new(Semaphore::new(1)),
        metrics_tx,
        ws_tx,
        http_client: reqwest::Client::new(),
        geo_cache: Cache::new(1),
        log_tx,
        geo_db: Arc::new(ArcSwap::from_pointee(None)),
        node_activity_cache: Cache::new(1),
        ip_lookup_mode: Arc::new(ArcSwap::from_pointee(crate::models::IpLookupMode::HttpApi)),
        op_tx,
        admin_sessions: Arc::new(Mutex::new(VecDeque::new())),
        next_session_id: Arc::new(AtomicU64::new(1)),
    };
    let binding = "a".repeat(64);
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        format!("oidc_binding={binding}").parse().unwrap(),
    );
    for pass in 0..2 {
        let csrf = format!("state-{pass}");
        sqlx::query("INSERT INTO oidc_login_attempts(state_hash,browser_hash,nonce,pkce_verifier,expires_at) VALUES($1,$2,'nonce','verifier',CURRENT_TIMESTAMP+INTERVAL '5 minutes')").bind(token_hash(&csrf)).bind(token_hash(&binding)).execute(&db).await.unwrap();
        let q = || Callback {
            state: Some(csrf.clone()),
            code: Some("code".into()),
            error: None,
        };
        *token.lock().await = signed(&issuer, "qa-client", "nonce", 300, 0).to_string();
        assert!(complete(&state, &HeaderMap::new(), q()).await.is_err());
        let response = complete(&state, &headers, q()).await.unwrap();
        if pass == 0 {
            assert!(
                response.headers()[header::LOCATION]
                    .to_str()
                    .unwrap()
                    .ends_with("error=pending")
            );
            assert!(!response.headers().contains_key(header::SET_COOKIE));
            sqlx::query("UPDATE app_users SET status='active' WHERE id=(SELECT user_id FROM oidc_identities WHERE issuer=$1 AND subject='google-subject-123')").bind(&issuer).execute(&db).await.unwrap();
        } else {
            assert_eq!(response.headers()[header::LOCATION], "/qa/console");
            assert!(response.headers().contains_key(header::SET_COOKIE));
        }
        assert!(
            complete(&state, &headers, q()).await.is_err(),
            "state must be single use"
        );
    }
    let id: i64 = sqlx::query_scalar("SELECT user_id FROM oidc_identities WHERE issuer=$1")
        .bind(&issuer)
        .fetch_one(&db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM app_users WHERE id=$1")
        .bind(id)
        .execute(&db)
        .await
        .unwrap();
    server.abort();
}
