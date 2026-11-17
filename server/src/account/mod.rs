pub mod config;
mod oidc;
mod ui;
mod users;
mod turnstile;

use crate::{error::AppError, models::AppState};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Form, Query, Request, State},
    http::{HeaderMap, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use config::AuthConfig;
use moka::future::Cache;
use ring::{pbkdf2, rand::SecureRandom};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{num::NonZeroU32, sync::LazyLock};
use subtle::ConstantTimeEq;

static LOGIN_ATTEMPTS: LazyLock<Cache<String, u32>> = LazyLock::new(|| {
    Cache::builder()
        .max_capacity(10000)
        .time_to_live(std::time::Duration::from_secs(900))
        .build()
});
static PASSWORD_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
pub fn hash_password(password: &str) -> String {
    let mut salt = [0; 16];
    ring::rand::SystemRandom::new().fill(&mut salt).unwrap();
    let mut hash = [0; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(600000).unwrap(),
        &salt,
        password.as_bytes(),
        &mut hash,
    );
    format!(
        "pbkdf2$sha256$600000${}${}",
        hex::encode(salt),
        hex::encode(hash)
    )
}
pub fn verify_password(password: &str, hash: &str) -> bool {
    let p: Vec<_> = hash.split('$').collect();
    if p.len() == 5 && p[0] == "pbkdf2" && p[1] == "sha256" {
        if let (Ok(n), Ok(salt), Ok(digest)) =
            (p[2].parse::<u32>(), hex::decode(p[3]), hex::decode(p[4]))
        {
            if (10000..=2000000).contains(&n) && salt.len() >= 16 && digest.len() == 32 {
                return pbkdf2::verify(
                    pbkdf2::PBKDF2_HMAC_SHA256,
                    NonZeroU32::new(n).unwrap(),
                    &salt,
                    password.as_bytes(),
                    &digest,
                )
                .is_ok();
            }
        }
        return false;
    }
    hash.as_bytes().ct_eq(password.as_bytes()).into()
}
pub fn generate_secure_token(n: usize) -> String {
    let mut bytes = vec![0; n];
    ring::rand::SystemRandom::new().fill(&mut bytes).unwrap();
    hex::encode(bytes)
}
pub fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}
pub async fn password_hash(password: String) -> Result<String, AppError> {
    let slot = PASSWORD_SLOTS
        .acquire()
        .await
        .map_err(|_| AppError::Internal("Password worker unavailable".into()))?;
    let result = tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|_| AppError::Internal("Password worker failed".into()))?;
    drop(slot);
    Ok(result)
}
async fn password_matches(password: String, hash: String) -> bool {
    let Ok(slot) = PASSWORD_SLOTS.acquire().await else {
        return false;
    };
    let result = tokio::task::spawn_blocking(move || verify_password(&password, &hash))
        .await
        .unwrap_or(false);
    drop(slot);
    result
}
pub fn valid_password(password: &str) -> bool {
    (12..=1024).contains(&password.len())
}
pub fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|p| p.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v)
}
pub fn session_cookie(config: &AuthConfig, name: &str, value: &str, age: i64) -> String {
    format!(
        "{name}={value}; Path={}; HttpOnly; SameSite=Lax; Max-Age={age}{}",
        config.admin_path,
        if config.secure() { "; Secure" } else { "" }
    )
}

#[derive(Clone, Serialize, sqlx::FromRow)]
pub struct Principal {
    pub id: i64,
    pub username: Option<String>,
    pub display_name: String,
    pub email: Option<String>,
    pub role: String,
    pub csrf_token: String,
    #[serde(skip)]
    pub session_hash: String,
}
pub async fn authenticate(headers: &HeaderMap, db: &sqlx::PgPool) -> Option<Principal> {
    let token = cookie(headers, "iplogger_session")?;
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    sqlx::query_as("SELECT u.id,u.username,u.display_name,u.email,u.role,s.csrf_token,s.token_hash AS session_hash FROM user_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>CURRENT_TIMESTAMP AND u.status='active' AND s.auth_version=u.auth_version").bind(token_hash(token)).fetch_optional(db).await.ok().flatten()
}
pub async fn is_authenticated(headers: &HeaderMap, db: &sqlx::PgPool) -> bool {
    authenticate(headers, db).await.is_some()
}
pub fn deny(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({"error":message}))).into_response()
}
pub fn login_redirect(config: &AuthConfig, error: &str) -> Response {
    Redirect::to(&format!("{}?error={}", config.path("/login"), error)).into_response()
}
pub async fn issue_session(
    state: &AppState,
    user_id: i64,
    version: Option<i64>,
) -> Result<String, AppError> {
    let token = generate_secure_token(32);
    let result=sqlx::query("INSERT INTO user_sessions(token_hash,user_id,csrf_token,expires_at,auth_version) SELECT $1,id,$3,CURRENT_TIMESTAMP+make_interval(hours=>$4),auth_version FROM app_users WHERE id=$2 AND status='active' AND ($5::BIGINT IS NULL OR auth_version=$5)").bind(token_hash(&token)).bind(user_id).bind(generate_secure_token(32)).bind(state.auth.session_hours as i32).bind(version).execute(&state.db).await?;
    if result.rows_affected() != 1 {
        return Err(AppError::Internal("Account changed during login".into()));
    }
    sqlx::query("DELETE FROM user_sessions WHERE token_hash IN (SELECT token_hash FROM user_sessions WHERE user_id=$1 ORDER BY created_at DESC,token_hash DESC OFFSET 20)").bind(user_id).execute(&state.db).await?;
    sqlx::query("UPDATE app_users SET last_login_at=CURRENT_TIMESTAMP WHERE id=$1")
        .bind(user_id)
        .execute(&state.db)
        .await?;
    Ok(session_cookie(
        &state.auth,
        "iplogger_session",
        &token,
        state.auth.session_hours * 3600,
    ))
}
pub async fn revoke_sessions(state: &AppState, user_id: i64) -> Result<(), AppError> {
    sqlx::query("DELETE FROM user_sessions WHERE user_id=$1")
        .bind(user_id)
        .execute(&state.db)
        .await?;
    let sessions = state.admin_sessions.lock().await;
    for (_, uid, tx) in sessions.iter() {
        if *uid == user_id {
            let _ = tx.try_send(());
        }
    }
    Ok(())
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/login", get(login_page).post(local_login))
        .route("/logout", post(logout))
        .route("/auth/oidc/start", get(oidc::start))
        .route("/auth/oidc/link", post(oidc::link))
        .route("/auth/oidc/callback", get(oidc::callback))
        .route("/users", get(ui::users_page))
        .route("/api/me", get(users::me))
        .route("/api/me/password", post(users::change_password))
        .route("/api/users", get(users::list).post(users::create))
        .route("/api/users/:id", axum::routing::patch(users::update))
        .route("/api/users/:id/password", post(users::reset_password))
        .route(
            "/api/users/:id/sessions",
            get(users::sessions).delete(users::revoke),
        )
}

// Explicit deployment origins cover proxy aliases without trusting forwarded
// headers. Keep the legacy same-host rule only when no origins are configured.
pub fn origin_allowed(config: &AuthConfig, headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    if config.public_origin.is_some() || !config.allowed_origins.is_empty() {
        return config.public_origin.as_deref() == Some(origin)
            || config.allowed_origins.iter().any(|allowed| allowed == origin);
    }
    let Ok(url) = reqwest::Url::parse(origin) else {
        return false;
    };
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    matches!(url.scheme(), "http" | "https")
        && origin == url.origin().ascii_serialization()
        && origin == format!("{}://{}", url.scheme(), host)
}
// All browser-authenticated mutations, including HTML forms, use the session's CSRF token.
pub async fn csrf_guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) || matches!(request.uri().path(), "/login")
        || request.uri().path() == state.auth.path("/login")
    {
        return next.run(request).await;
    }
    let Some(user) = authenticate(request.headers(), &state.db).await else {
        return deny(StatusCode::UNAUTHORIZED, "请重新登录");
    };
    if !origin_allowed(&state.auth, request.headers()) {
        return deny(StatusCode::FORBIDDEN, "请求来源不匹配");
    }
    let mut supplied = request
        .headers()
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let (parts, body) = request.into_parts();
    let body = if supplied.is_none()
        && parts
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|s| s.starts_with("application/x-www-form-urlencoded"))
    {
        let Ok(bytes) = to_bytes(body, 65536).await else {
            return deny(StatusCode::PAYLOAD_TOO_LARGE, "表单过大");
        };
        supplied = String::from_utf8_lossy(&bytes)
            .split('&')
            .filter_map(|s| s.split_once('='))
            .find(|(k, _)| *k == "_csrf")
            .map(|(_, v)| v.to_string());
        Body::from(bytes)
    } else {
        body
    };
    if !supplied
        .as_deref()
        .is_some_and(|s| bool::from(s.as_bytes().ct_eq(user.csrf_token.as_bytes())))
    {
        return deny(StatusCode::FORBIDDEN, "验证令牌已失效，请刷新页面");
    }
    let mut request = Request::from_parts(parts, body);
    request.extensions_mut().insert(user);
    next.run(request).await
}
#[derive(Deserialize)]
pub struct LoginQuery {
    error: Option<String>,
}
async fn login_page(State(state): State<AppState>, Query(q): Query<LoginQuery>) -> Response {
    let csrf = generate_secure_token(32);
    let html = ui::login_html(&state.auth, q.error.as_deref(), &csrf);
    (
        [
            (
                header::SET_COOKIE,
                session_cookie(&state.auth, "login_csrf", &csrf, 600),
            ),
            (header::CACHE_CONTROL, "no-store".into()),
            (header::REFERRER_POLICY, "no-referrer".into()),
        ],
        axum::response::Html(html),
    )
        .into_response()
}
#[derive(Deserialize)]
struct LoginForm {
    username: String,
    password: String,
    #[serde(rename = "_csrf")]
    csrf: String,
    #[serde(rename = "cf-turnstile-response")]
    captcha: Option<String>,
}
async fn local_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(p): Form<LoginForm>,
) -> Response {
    if !cookie(&headers, "login_csrf")
        .is_some_and(|c| bool::from(c.as_bytes().ct_eq(p.csrf.as_bytes())))
    {
        return login_redirect(&state.auth, "csrf");
    }
    let username = p.username.trim().to_lowercase();
    if username.len() > 64 || p.password.len() > 1024 {
        return login_redirect(&state.auth, "credentials");
    }
    // Account-keyed throttling cannot be bypassed by spoofing proxy address headers.
    let key = token_hash(&username);
    {
        static ATTEMPT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let _guard = ATTEMPT_LOCK.lock().await;
        let attempts = LOGIN_ATTEMPTS.get(&key).await.unwrap_or(0);
        if attempts >= 5 {
            return login_redirect(&state.auth, "ratelimit");
        }
        LOGIN_ATTEMPTS.insert(key.clone(), attempts + 1).await;
    }
    if !turnstile::verify(&state.auth, p.captcha.as_deref()).await {
        return login_redirect(&state.auth, "captcha");
    }
    let record: Option<(i64, Option<String>, String, i64)> = sqlx::query_as(
        "SELECT id,password_hash,status,auth_version FROM app_users WHERE lower(username)=$1",
    )
    .bind(username)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    // Use a real hash on unknown users to avoid a fast username-existence oracle.
    let dummy = "pbkdf2$sha256$600000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000";
    let hash = record
        .as_ref()
        .and_then(|r| r.1.as_deref())
        .unwrap_or(dummy)
        .to_string();
    let valid = password_matches(p.password.clone(), hash.clone()).await;
    if let Some((id, Some(_), status, version)) = record {
        if valid && status == "active" {
            LOGIN_ATTEMPTS.invalidate(&key).await;
            if !hash.starts_with("pbkdf2$sha256$600000$") {
                if let Ok(hash) = password_hash(p.password).await {
                    let _ = sqlx::query(
                        "UPDATE app_users SET password_hash=$1 WHERE id=$2 AND auth_version=$3",
                    )
                    .bind(hash)
                    .bind(id)
                    .bind(version)
                    .execute(&state.db)
                    .await;
                }
            }
            return match issue_session(&state, id, Some(version)).await {
                Ok(cookie) => (
                    [
                        (header::SET_COOKIE, cookie),
                        (header::LOCATION, state.auth.admin_path.clone()),
                        (header::CACHE_CONTROL, "no-store".into()),
                    ],
                    StatusCode::SEE_OTHER,
                )
                    .into_response(),
                Err(e) => e.into_response(),
            };
        }
    }
    login_redirect(&state.auth, "credentials")
}
async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(token) = cookie(&headers, "iplogger_session") {
        let _ = sqlx::query("DELETE FROM user_sessions WHERE token_hash=$1")
            .bind(token_hash(token))
            .execute(&state.db)
            .await;
    }
    (
        StatusCode::SEE_OTHER,
        [
            (
                header::SET_COOKIE,
                session_cookie(&state.auth, "iplogger_session", "", 0),
            ),
            (header::LOCATION, state.auth.path("/login")),
        ],
    )
        .into_response()
}

pub async fn init(db: &sqlx::PgPool, config: &crate::config::Auth) -> anyhow::Result<()> {
    for sql in [
        "CREATE TABLE IF NOT EXISTS app_users(id BIGSERIAL PRIMARY KEY,username TEXT,display_name TEXT NOT NULL,email TEXT,password_hash TEXT,role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin','viewer')),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('active','pending','disabled')),created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,last_login_at TIMESTAMPTZ)",
        "CREATE UNIQUE INDEX IF NOT EXISTS app_users_username ON app_users(lower(username)) WHERE username IS NOT NULL",
        "CREATE TABLE IF NOT EXISTS oidc_identities(issuer TEXT NOT NULL,subject TEXT NOT NULL,user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,PRIMARY KEY(issuer,subject))",
        "CREATE TABLE IF NOT EXISTS user_sessions(token_hash TEXT PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,csrf_token TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,expires_at TIMESTAMPTZ NOT NULL)",
        "ALTER TABLE app_users ADD COLUMN IF NOT EXISTS auth_version BIGINT NOT NULL DEFAULT 1",
        "ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS auth_version BIGINT NOT NULL DEFAULT 1",
        "CREATE INDEX IF NOT EXISTS user_sessions_user ON user_sessions(user_id)",
        "CREATE TABLE IF NOT EXISTS oidc_login_attempts(state_hash TEXT PRIMARY KEY,browser_hash TEXT NOT NULL,nonce TEXT NOT NULL,pkce_verifier TEXT NOT NULL,link_user BIGINT REFERENCES app_users(id) ON DELETE CASCADE,link_session TEXT,expires_at TIMESTAMPTZ NOT NULL)",
        "CREATE TABLE IF NOT EXISTS auth_audit(id BIGSERIAL PRIMARY KEY,actor_id BIGINT,subject_id BIGINT,action TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    ] {
        sqlx::query(sql).execute(db).await?;
    }
    let mut tx = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(739105001)")
        .execute(&mut *tx)
        .await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_users")
        .fetch_one(&mut *tx)
        .await?;
    if count == 0 {
        let legacy: Option<(String, String)> =
            sqlx::query_as("SELECT username,password FROM admin_auth WHERE id=1")
                .fetch_optional(&mut *tx)
                .await?;
        let (name, hash) = if let Some((name, hash)) = legacy {
            (
                name,
                if hash.starts_with("pbkdf2$") {
                    hash
                } else {
                    hash_password(&hash)
                },
            )
        } else {
            let pass = &config.initial_password;
            anyhow::ensure!(
                valid_password(&pass),
                "Fresh installation requires auth.initial_password (12–1024 bytes)"
            );
            (
                config.initial_username.clone(),
                hash_password(&pass),
            )
        };
        sqlx::query("INSERT INTO app_users(username,display_name,password_hash,role,status) VALUES($1,$2,$3,'admin','active')").bind(name.trim().to_lowercase()).bind(name).bind(hash).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn password_hashes_and_migration() {
        let hash = hash_password("long-test-password");
        assert!(verify_password("long-test-password", &hash));
        assert!(!verify_password("wrong", &hash));
        assert!(verify_password("legacy", "legacy"));
        assert!(!verify_password("x", "pbkdf2$sha256$0$aa$bb"));
        assert!(!valid_password("short"));
    }
    #[test]
    fn cookies_match_exact_names() {
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            "not_iplogger_session=bad; iplogger_session=good"
                .parse()
                .unwrap(),
        );
        assert_eq!(cookie(&h, "iplogger_session"), Some("good"));
    }
}
pub use ui::{load as ui_assets, paths as paths_html, response as page_response};

pub fn spawn_cleanup(db: sqlx::PgPool) {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            timer.tick().await;
            for sql in [
                "DELETE FROM user_sessions WHERE expires_at<CURRENT_TIMESTAMP",
                "DELETE FROM oidc_login_attempts WHERE expires_at<CURRENT_TIMESTAMP",
                "DELETE FROM auth_audit WHERE created_at<CURRENT_TIMESTAMP-INTERVAL '90 days'",
            ] {
                if sqlx::query(sql).execute(&db).await.is_err() {
                    tracing::warn!("Account retention cleanup failed");
                }
            }
        }
    });
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires disposable NEXUS_TEST_DATABASE_URL"]
    async fn migrates_legacy_admin_and_rejects_old_session_version() {
        use std::str::FromStr;
        let url = std::env::var("NEXUS_TEST_DATABASE_URL").unwrap();
        let root = sqlx::PgPool::connect(&url).await.unwrap();
        let schema = format!("auth_qa_{}", generate_secure_token(6));
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&root)
            .await
            .unwrap();
        let options = sqlx::postgres::PgConnectOptions::from_str(&url)
            .unwrap()
            .options([("search_path", schema.as_str())]);
        let db = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE admin_auth(id INTEGER PRIMARY KEY,username TEXT,password TEXT)")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO admin_auth VALUES(1,'ExistingAdmin','legacy-admin-password')")
            .execute(&db)
            .await
            .unwrap();
        init(&db, &crate::config::Auth::default()).await.unwrap();
        init(&db, &crate::config::Auth::default()).await.unwrap();
        let users: Vec<(i64, String, String, String)> =
            sqlx::query_as("SELECT id,username,password_hash,role FROM app_users")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].1, "existingadmin");
        assert_eq!(users[0].3, "admin");
        assert!(verify_password("legacy-admin-password", &users[0].2));
        assert_ne!(users[0].2, "legacy-admin-password");
        let token = generate_secure_token(32);
        sqlx::query("INSERT INTO user_sessions(token_hash,user_id,csrf_token,expires_at,auth_version) VALUES($1,$2,'csrf',CURRENT_TIMESTAMP+INTERVAL '1 hour',1)").bind(token_hash(&token)).bind(users[0].0).execute(&db).await.unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            format!("iplogger_session={token}").parse().unwrap(),
        );
        assert!(authenticate(&headers, &db).await.is_some());
        sqlx::query("UPDATE app_users SET auth_version=auth_version+1")
            .execute(&db)
            .await
            .unwrap();
        assert!(authenticate(&headers, &db).await.is_none());
        db.close().await;
        sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
            .execute(&root)
            .await
            .unwrap();
    }
}
