use crate::{
    account::{self, Principal},
    models::AppState,
};
use axum::{
    extract::FromRequestParts,
    http::{Method, StatusCode, request::Parts},
    response::{IntoResponse, Redirect, Response},
};
pub struct AdminAuth(pub Principal);
pub struct AdminOnly(pub Principal);
pub struct AdminAuthPage(pub Principal);
pub struct RedirectToLogin(String);
impl IntoResponse for RedirectToLogin {
    fn into_response(self) -> Response {
        Redirect::to(&self.0).into_response()
    }
}
async fn current(parts: &Parts, state: &AppState) -> Option<Principal> {
    if let Some(user) = parts.extensions.get::<Principal>() {
        Some(user.clone())
    } else {
        account::authenticate(&parts.headers, &state.db).await
    }
}
#[axum::async_trait]
impl FromRequestParts<AppState> for AdminAuth {
    type Rejection = StatusCode;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = current(parts, state)
            .await
            .ok_or(StatusCode::UNAUTHORIZED)?;
        let self_action = parts.uri.path() == "/api/me/password"
            || parts.uri.path() == state.auth.path("/api/me/password");
        if !matches!(parts.method, Method::GET | Method::HEAD | Method::OPTIONS)
            && user.role != "admin"
            && !self_action
        {
            return Err(StatusCode::FORBIDDEN);
        }
        Ok(Self(user))
    }
}
#[axum::async_trait]
impl FromRequestParts<AppState> for AdminOnly {
    type Rejection = StatusCode;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = current(parts, state)
            .await
            .ok_or(StatusCode::UNAUTHORIZED)?;
        if user.role != "admin" {
            return Err(StatusCode::FORBIDDEN);
        }
        Ok(Self(user))
    }
}
#[axum::async_trait]
impl FromRequestParts<AppState> for AdminAuthPage {
    type Rejection = RedirectToLogin;
    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        current(parts, state)
            .await
            .map(Self)
            .ok_or_else(|| RedirectToLogin(state.auth.path("/login")))
    }
}

/// 提取器：提取并验证外部 API 调用（Bearer Token）的权限
pub struct ApiAuth;

#[axum::async_trait]
impl FromRequestParts<AppState> for ApiAuth {
    type Rejection = StatusCode;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let auth_header = parts
            .headers
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");

        let token = auth_header.replace("Bearer ", "");

        if token.is_empty() {
            return Err(StatusCode::UNAUTHORIZED);
        }

        let is_valid: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM api_keys WHERE token = $1)")
                .bind(&token)
                .fetch_one(&state.db)
                .await
                .unwrap_or(false);

        if is_valid {
            Ok(ApiAuth)
        } else {
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}
