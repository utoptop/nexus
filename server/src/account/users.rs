use super::*;
use crate::extractors::auth::{AdminAuth, AdminOnly};
use axum::extract::Path;

#[derive(Serialize, sqlx::FromRow)]
struct UserRow {
    id: i64,
    username: Option<String>,
    display_name: String,
    email: Option<String>,
    role: String,
    status: String,
    created_at: String,
    last_login_at: Option<String>,
    local_login: bool,
    google_login: bool,
    sessions: i64,
}
const USER_SELECT: &str = "SELECT u.id,u.username,u.display_name,u.email,u.role,u.status,CAST(u.created_at AS TEXT) AS created_at,CAST(u.last_login_at AS TEXT) AS last_login_at,(u.password_hash IS NOT NULL) AS local_login,EXISTS(SELECT 1 FROM oidc_identities o WHERE o.user_id=u.id) AS google_login,(SELECT COUNT(*) FROM user_sessions s WHERE s.user_id=u.id AND s.expires_at>CURRENT_TIMESTAMP) AS sessions FROM app_users u";
pub async fn me(AdminAuth(user): AdminAuth, State(state): State<AppState>) -> Response {
    Json(serde_json::json!({"user":user,"oidc_enabled":state.auth.client_id.is_some(),"admin_path":state.auth.admin_path,"callback_url":state.auth.callback()})).into_response()
}
#[derive(Deserialize)]
pub struct ListQuery {
    q: Option<String>,
    page: Option<i64>,
}
pub async fn list(
    _auth: AdminOnly,
    State(state): State<AppState>,
    Query(q): Query<ListQuery>,
) -> Result<Response, AppError> {
    let page = q.page.unwrap_or(1).clamp(1, 100000);
    let q =
        q.q.unwrap_or_default()
            .chars()
            .take(120)
            .collect::<String>()
            .to_lowercase();
    let filter = " WHERE $1='' OR strpos(lower(COALESCE(u.username,'')||' '||u.display_name||' '||COALESCE(u.email,'')),$1)>0";
    let total: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM app_users u{filter}"))
        .bind(&q)
        .fetch_one(&state.db)
        .await?;
    let users: Vec<UserRow> = sqlx::query_as(&format!(
        "{USER_SELECT}{filter} ORDER BY u.id LIMIT 30 OFFSET $2"
    ))
    .bind(&q)
    .bind((page - 1) * 30)
    .fetch_all(&state.db)
    .await?;
    Ok(
        Json(serde_json::json!({"users":users,"total":total,"page":page,"page_size":30}))
            .into_response(),
    )
}
fn username(value: &str) -> Option<String> {
    let v = value.trim().to_lowercase();
    if (3..=64).contains(&v.len())
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-@".contains(&b))
    {
        Some(v)
    } else {
        None
    }
}
fn display(value: &str) -> Option<String> {
    let v = value.trim();
    if v.is_empty() || v.chars().count() > 120 {
        None
    } else {
        Some(v.into())
    }
}
#[derive(Deserialize)]
pub struct CreateUser {
    username: String,
    password: String,
    display_name: String,
    role: String,
}
pub async fn create(
    AdminOnly(actor): AdminOnly,
    State(state): State<AppState>,
    Json(p): Json<CreateUser>,
) -> Result<Response, AppError> {
    let (Some(name), Some(display)) = (username(&p.username), display(&p.display_name)) else {
        return Ok(deny(
            StatusCode::BAD_REQUEST,
            "账号需为 3–64 位字母、数字或 _.-@，显示名不能为空",
        ));
    };
    if !valid_password(&p.password) || !matches!(p.role.as_str(), "admin" | "viewer") {
        return Ok(deny(
            StatusCode::BAD_REQUEST,
            "密码至少 12 位，角色必须有效",
        ));
    }
    let hash = password_hash(p.password).await?;
    let result=sqlx::query_scalar::<_,i64>("INSERT INTO app_users(username,display_name,password_hash,role,status) VALUES($1,$2,$3,$4,'active') RETURNING id").bind(name).bind(display).bind(hash).bind(p.role).fetch_one(&state.db).await;
    match result {
        Ok(id) => {
            audit(&state, actor.id, id, "user.create").await?;
            Ok((StatusCode::CREATED, Json(serde_json::json!({"id":id}))).into_response())
        }
        Err(sqlx::Error::Database(ref e)) if e.code().as_deref() == Some("23505") => {
            Ok(deny(StatusCode::CONFLICT, "账号已存在"))
        }
        Err(e) => Err(e.into()),
    }
}
#[derive(Deserialize)]
pub struct UpdateUser {
    display_name: String,
    role: String,
    status: String,
}
pub async fn update(
    AdminOnly(actor): AdminOnly,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(p): Json<UpdateUser>,
) -> Result<Response, AppError> {
    let Some(name) = display(&p.display_name) else {
        return Ok(deny(StatusCode::BAD_REQUEST, "显示名不能为空且最多 120 字"));
    };
    if !matches!(p.role.as_str(), "admin" | "viewer")
        || !matches!(p.status.as_str(), "active" | "pending" | "disabled")
    {
        return Ok(deny(StatusCode::BAD_REQUEST, "角色或状态无效"));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(739105001)")
        .execute(&mut *tx)
        .await?;
    let allowed: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM app_users WHERE id=$1 AND status='active' AND role='admin')",
    )
    .bind(actor.id)
    .fetch_one(&mut *tx)
    .await?;
    if !allowed {
        return Ok(deny(StatusCode::FORBIDDEN, "管理员权限已撤销"));
    }
    let previous: Option<(String, String)> =
        sqlx::query_as("SELECT role,status FROM app_users WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((role, status)) = previous else {
        return Ok(deny(StatusCode::NOT_FOUND, "用户不存在"));
    };
    if role == "admin" && status == "active" && (p.role != "admin" || p.status != "active") {
        let admins: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM app_users WHERE role='admin' AND status='active'",
        )
        .fetch_one(&mut *tx)
        .await?;
        if admins <= 1 {
            return Ok(deny(StatusCode::CONFLICT, "必须保留至少一名已启用的管理员"));
        }
    }
    sqlx::query("UPDATE app_users SET display_name=$1,role=$2,status=$3,auth_version=auth_version+CASE WHEN role<>$2 OR status<>$3 THEN 1 ELSE 0 END WHERE id=$4").bind(name).bind(&p.role).bind(&p.status).bind(id).execute(&mut *tx).await?;
    if role != p.role || status != p.status {
        sqlx::query("DELETE FROM user_sessions WHERE user_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT INTO auth_audit(actor_id,subject_id,action) VALUES($1,$2,'user.update')")
        .bind(actor.id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if role != p.role || status != p.status {
        revoke_sessions(&state, id).await?;
    }
    Ok(Json(serde_json::json!({"ok":true})).into_response())
}
#[derive(Deserialize)]
pub struct Password {
    password: String,
}
pub async fn reset_password(
    AdminOnly(actor): AdminOnly,
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(p): Json<Password>,
) -> Result<Response, AppError> {
    if !valid_password(&p.password) {
        return Ok(deny(StatusCode::BAD_REQUEST, "密码至少 12 位"));
    }
    let hash = password_hash(p.password).await?;
    let r=sqlx::query("UPDATE app_users SET password_hash=$1,auth_version=auth_version+1 WHERE id=$2 AND username IS NOT NULL").bind(hash).bind(id).execute(&state.db).await?;
    if r.rows_affected() == 0 {
        return Ok(deny(StatusCode::BAD_REQUEST, "此用户没有本地登录账号"));
    }
    revoke_sessions(&state, id).await?;
    audit(&state, actor.id, id, "password.reset").await?;
    Ok(Json(serde_json::json!({"ok":true})).into_response())
}
#[derive(Deserialize)]
pub struct ChangePassword {
    current_password: String,
    password: String,
}
pub async fn change_password(
    AdminAuth(actor): AdminAuth,
    State(state): State<AppState>,
    Json(p): Json<ChangePassword>,
) -> Result<Response, AppError> {
    if !valid_password(&p.password) || p.current_password.len() > 1024 {
        return Ok(deny(StatusCode::BAD_REQUEST, "新密码至少 12 位"));
    }
    let hash: Option<String> =
        sqlx::query_scalar("SELECT password_hash FROM app_users WHERE id=$1")
            .bind(actor.id)
            .fetch_one(&state.db)
            .await?;
    let old_hash = hash.unwrap_or_default();
    if !password_matches(p.current_password, old_hash.clone()).await {
        return Ok(deny(StatusCode::FORBIDDEN, "当前密码不正确"));
    }
    let hash = password_hash(p.password).await?;
    let changed=sqlx::query("UPDATE app_users SET password_hash=$1,auth_version=auth_version+1 WHERE id=$2 AND password_hash=$3").bind(hash).bind(actor.id).bind(old_hash).execute(&state.db).await?;
    if changed.rows_affected() != 1 {
        return Ok(deny(StatusCode::CONFLICT, "密码已发生变化，请重新登录"));
    }
    revoke_sessions(&state, actor.id).await?;
    audit(&state, actor.id, actor.id, "password.change").await?;
    Ok(Json(serde_json::json!({"ok":true,"login":state.auth.path("/login")})).into_response())
}
#[derive(Serialize, sqlx::FromRow)]
struct SessionRow {
    created_at: String,
    expires_at: String,
}
pub async fn sessions(
    AdminOnly(_): AdminOnly,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Response, AppError> {
    let rows:Vec<SessionRow>=sqlx::query_as("SELECT CAST(created_at AS TEXT) AS created_at,CAST(expires_at AS TEXT) AS expires_at FROM user_sessions WHERE user_id=$1 AND expires_at>CURRENT_TIMESTAMP ORDER BY created_at DESC LIMIT 100").bind(id).fetch_all(&state.db).await?;
    Ok(Json(rows).into_response())
}
pub async fn revoke(
    AdminOnly(actor): AdminOnly,
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Response, AppError> {
    revoke_sessions(&state, id).await?;
    audit(&state, actor.id, id, "sessions.revoke").await?;
    Ok(Json(serde_json::json!({"ok":true})).into_response())
}
async fn audit(state: &AppState, actor: i64, subject: i64, action: &str) -> Result<(), AppError> {
    sqlx::query("INSERT INTO auth_audit(actor_id,subject_id,action) VALUES($1,$2,$3)")
        .bind(actor)
        .bind(subject)
        .bind(action)
        .execute(&state.db)
        .await?;
    Ok(())
}
