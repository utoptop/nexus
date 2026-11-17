use super::*;
use openidconnect::{
    AccessTokenHash, AuthorizationCode, ClientId, ClientSecret, CsrfToken, Nonce,
    OAuth2TokenResponse, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope, TokenResponse,
    core::{CoreAuthenticationFlow, CoreClient},
};

pub async fn start(State(state): State<AppState>) -> Response {
    begin(&state, None).await
}
pub async fn link(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(user) = authenticate(&headers, &state.db).await else {
        return deny(StatusCode::UNAUTHORIZED, "请先登录");
    };
    begin(&state, Some(user)).await
}
async fn begin(state: &AppState, link: Option<Principal>) -> Response {
    if state.auth.client_id.is_none() {
        return login_redirect(&state.auth, "unconfigured");
    }
    match begin_inner(state, link).await {
        Ok(r) => r,
        Err(_) => {
            tracing::warn!("OIDC authorization initialization failed");
            login_redirect(&state.auth, "provider")
        }
    }
}
async fn begin_inner(state: &AppState, link: Option<Principal>) -> anyhow::Result<Response> {
    let meta = state.auth.provider().await?;
    let client = CoreClient::from_provider_metadata(
        meta,
        ClientId::new(state.auth.client_id.clone().unwrap()),
        state.auth.client_secret.clone().map(ClientSecret::new),
    )
    .set_redirect_uri(RedirectUrl::new(state.auth.callback())?)
    .set_auth_type(openidconnect::AuthType::RequestBody);
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let (url, csrf, nonce) = client
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            CsrfToken::new_random,
            Nonce::new_random,
        )
        .add_scope(Scope::new("email".into()))
        .add_scope(Scope::new("profile".into()))
        .set_pkce_challenge(challenge)
        .add_extra_param("prompt", "select_account")
        .url();
    let binding = generate_secure_token(32);
    sqlx::query("DELETE FROM oidc_login_attempts WHERE expires_at<CURRENT_TIMESTAMP")
        .execute(&state.db)
        .await?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM oidc_login_attempts")
        .fetch_one(&state.db)
        .await?;
    anyhow::ensure!(count < 10000, "Too many login attempts");
    sqlx::query("INSERT INTO oidc_login_attempts(state_hash,browser_hash,nonce,pkce_verifier,link_user,link_session,expires_at) VALUES($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP+INTERVAL '5 minutes')")
 .bind(token_hash(csrf.secret())).bind(token_hash(&binding)).bind(nonce.secret()).bind(verifier.secret()).bind(link.as_ref().map(|u|u.id)).bind(link.map(|u|u.session_hash)).execute(&state.db).await?;
    Ok((
        StatusCode::SEE_OTHER,
        [
            (header::LOCATION, url.to_string()),
            (
                header::SET_COOKIE,
                session_cookie(&state.auth, "oidc_binding", &binding, 300),
            ),
            (header::CACHE_CONTROL, "no-store".into()),
            (header::REFERRER_POLICY, "no-referrer".into()),
        ],
    )
        .into_response())
}
#[derive(Deserialize)]
pub struct Callback {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}
#[derive(sqlx::FromRow)]
struct Attempt {
    nonce: String,
    pkce_verifier: String,
    link_user: Option<i64>,
    link_session: Option<String>,
}
pub async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<Callback>,
) -> Response {
    let result = complete(&state, &headers, q).await;
    let mut response = match result {
        Ok(r) => r,
        Err(_) => {
            tracing::warn!("OIDC callback rejected (state, provider or token verification)");
            login_redirect(&state.auth, "oidc")
        }
    };
    response.headers_mut().append(
        header::SET_COOKIE,
        session_cookie(&state.auth, "oidc_binding", "", 0)
            .parse()
            .unwrap(),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    response
}
async fn complete(state: &AppState, headers: &HeaderMap, q: Callback) -> anyhow::Result<Response> {
    let csrf = q
        .state
        .filter(|s| s.len() <= 256)
        .ok_or_else(|| anyhow::anyhow!("Missing state"))?;
    let binding = cookie(headers, "oidc_binding")
        .filter(|s| s.len() == 64)
        .ok_or_else(|| anyhow::anyhow!("Missing browser binding"))?;
    // Atomic consumption binds this one-use authorization code to the initiating browser.
    let attempt:Attempt=sqlx::query_as("DELETE FROM oidc_login_attempts WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>CURRENT_TIMESTAMP RETURNING nonce,pkce_verifier,link_user,link_session").bind(token_hash(&csrf)).bind(token_hash(binding)).fetch_optional(&state.db).await?.ok_or_else(||anyhow::anyhow!("Expired or invalid state"))?;
    if q.error.is_some() {
        return Ok(login_redirect(&state.auth, "cancelled"));
    }
    let code = q
        .code
        .filter(|c| c.len() <= 4096)
        .ok_or_else(|| anyhow::anyhow!("Missing code"))?;
    let meta = state.auth.provider().await?;
    let client = CoreClient::from_provider_metadata(
        meta,
        ClientId::new(
            state
                .auth
                .client_id
                .clone()
                .ok_or_else(|| anyhow::anyhow!("Disabled"))?,
        ),
        state.auth.client_secret.clone().map(ClientSecret::new),
    )
    .set_redirect_uri(RedirectUrl::new(state.auth.callback())?)
    .set_auth_type(openidconnect::AuthType::RequestBody);
    let token = client
        .exchange_code(AuthorizationCode::new(code))?
        .set_pkce_verifier(PkceCodeVerifier::new(attempt.pkce_verifier))
        .request_async(&state.auth.oidc_http)
        .await?;
    let id_token = token
        .id_token()
        .ok_or_else(|| anyhow::anyhow!("Missing ID token"))?;
    let verifier = client.id_token_verifier();
    let claims = verified_claims(id_token, &verifier, &Nonce::new(attempt.nonce))?;
    if let Some(expected) = claims.access_token_hash() {
        let actual = AccessTokenHash::from_token(
            token.access_token(),
            id_token.signing_alg()?,
            id_token.signing_key(&verifier)?,
        )?;
        anyhow::ensure!(actual == *expected, "Access token hash mismatch");
    }
    let subject = claims.subject().as_str();
    anyhow::ensure!(
        !subject.is_empty() && subject.len() <= 255,
        "Invalid subject"
    );
    let email = if claims.email_verified() == Some(true) {
        claims.email().map(|s| s.as_str().to_owned())
    } else {
        None
    };
    let display = claims
        .name()
        .and_then(|names| names.get(None))
        .map(|n| n.as_str())
        .or(email.as_deref())
        .unwrap_or("Google 用户")
        .chars()
        .take(120)
        .collect::<String>();
    let link_user = if let Some(id) = attempt.link_user {
        let current = authenticate(headers, &state.db)
            .await
            .ok_or_else(|| anyhow::anyhow!("Link session ended"))?;
        anyhow::ensure!(
            current.id == id && Some(current.session_hash) == attempt.link_session,
            "Wrong link session"
        );
        Some(id)
    } else {
        None
    };
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(739105002)")
        .execute(&mut *tx)
        .await?;
    let existing: Option<i64> =
        sqlx::query_scalar("SELECT user_id FROM oidc_identities WHERE issuer=$1 AND subject=$2")
            .bind(&state.auth.issuer)
            .bind(subject)
            .fetch_optional(&mut *tx)
            .await?;
    let id=match (existing,link_user) {(Some(existing),Some(link))=>{anyhow::ensure!(existing==link,"Identity belongs to another account");link},(Some(id),None)=>id,(None,Some(id))=>id,(None,None)=>sqlx::query_scalar("INSERT INTO app_users(display_name,email,role,status) VALUES($1,$2,'viewer','pending') RETURNING id").bind(&display).bind(&email).fetch_one(&mut *tx).await?};
    sqlx::query("INSERT INTO oidc_identities(issuer,subject,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(&state.auth.issuer).bind(subject).bind(id).execute(&mut *tx).await?;
    let status: String = sqlx::query_scalar("SELECT status FROM app_users WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    if status != "active" {
        return Ok(login_redirect(
            &state.auth,
            if status == "pending" {
                "pending"
            } else {
                "disabled"
            },
        ));
    }
    let cookie = issue_session(state, id, None)
        .await
        .map_err(|_| anyhow::anyhow!("Session creation failed"))?;
    Ok((
        StatusCode::SEE_OTHER,
        [
            (header::SET_COOKIE, cookie),
            (
                header::LOCATION,
                if link_user.is_some() {
                    state.auth.path("/users")
                } else {
                    state.auth.admin_path.clone()
                },
            ),
        ],
    )
        .into_response())
}

fn verified_claims<'a>(
    token: &'a openidconnect::core::CoreIdToken,
    verifier: &openidconnect::core::CoreIdTokenVerifier,
    nonce: &Nonce,
) -> anyhow::Result<&'a openidconnect::core::CoreIdTokenClaims> {
    let claims = token.claims(verifier, nonce)?;
    anyhow::ensure!(
        claims.issue_time() <= chrono::Utc::now() + chrono::Duration::seconds(60),
        "Future ID token"
    );
    Ok(claims)
}
#[cfg(test)]
mod tests;
