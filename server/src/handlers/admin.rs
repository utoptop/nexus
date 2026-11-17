use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use std::sync::Arc;
use serde_json::Value;

use crate::models::*;
use crate::extractors::auth::{AdminAuth, AdminAuthPage};
use crate::visuals;
use crate::db::fetch_dashboard_data;
use crate::error::AppError;

pub async fn admin_playback_handler(_auth: AdminAuth, Query(params): Query<AdminParams>, State(state): State<AppState>) -> Result<Response, AppError> {
    let selected_node = params.node.unwrap_or_else(|| "All".to_string());
    let days = crate::db::normalize_days(params.days.unwrap_or(1.0));
    let nodes: Vec<String> = selected_node.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let is_all = nodes.contains(&"All".to_string()) || nodes.is_empty();
    let duration_secs = if days <= 0.001 { 600 } else { (days * 24.0 * 60.0 * 60.0) as i64 };
    let cutoff = chrono::Utc::now() - chrono::Duration::seconds(duration_secs);

    let history: Vec<HistoryRow> = sqlx::query_as(
        r#"
        WITH resolved_nodes AS (SELECT node_ip, COALESCE(NULLIF(TRIM(custom_name), ''), node_ip) as display_name FROM api_nodes)
        SELECT d.lat, d.lon, d.location, COALESCE(rn.display_name, vl.server_name), d.ip_address, CAST(vl.visit_time AS TEXT), COALESCE(vl.target_domain, '-') 
        FROM visitor_logs vl JOIN ip_dimensions d ON vl.ip_id = d.id
        LEFT JOIN resolved_nodes rn ON vl.server_name = rn.node_ip OR vl.server_name = rn.display_name
        WHERE d.lat IS NOT NULL AND ($1 = TRUE OR COALESCE(rn.display_name, vl.server_name) = ANY($2)) AND vl.visit_time >= $3 ORDER BY vl.visit_time ASC LIMIT 30000
        "#
    ).bind(is_all).bind(&nodes).bind(cutoff).fetch_all(&state.db).await?;
    
    let mut resp_headers = HeaderMap::new(); resp_headers.insert(header::CACHE_CONTROL, "no-store, max-age=0".parse().unwrap());
    Ok((resp_headers, axum::Json(history)).into_response())
}

pub async fn admin_data_handler(_auth: AdminAuth, Query(params): Query<AdminParams>, State(state): State<AppState>) -> Result<Response, AppError> {
    let (stats, history, heatmap) = fetch_dashboard_data(&state.db, &params.node.unwrap_or_else(|| "All".to_string()), params.days.unwrap_or(1.0)).await?;
    let mut clean_stats = Vec::new(); for s in stats { clean_stats.push((s.0, s.1, s.2, s.3, s.4, s.5.unwrap_or(0.0), s.6.unwrap_or(0.0), s.7, s.8)); }
    let mut resp_headers = HeaderMap::new(); resp_headers.insert(header::CACHE_CONTROL, "no-store, no-cache, must-revalidate, max-age=0".parse().unwrap());
    Ok((resp_headers, axum::Json(serde_json::json!({ "stats": clean_stats, "history": history, "heatmap": heatmap }))).into_response())
}

#[allow(clippy::too_many_arguments)]
#[allow(clippy::type_complexity)]
pub async fn admin_handler(AdminAuthPage(user): AdminAuthPage, headers: HeaderMap, Query(params): Query<AdminParams>, State(state): State<AppState>) -> Result<Response, AppError> {
    let lang_header = headers.get(header::ACCEPT_LANGUAGE).and_then(|h| h.to_str().ok()).unwrap_or("en");
    let mut is_zh = lang_header.to_lowercase().contains("zh");
    if let Some(cookie_val) = headers.get(header::COOKIE).and_then(|h| h.to_str().ok()) { if cookie_val.contains("lang=zh") { is_zh = true; } else if cookie_val.contains("lang=en") { is_zh = false; } }
    
    let selected_node = params.node.unwrap_or_else(|| "All".to_string());
    let (stats, history, heatmap) = fetch_dashboard_data(&state.db, &selected_node, params.days.unwrap_or(1.0)).await?;
    let mut active_servers: Vec<String> = sqlx::query_scalar("SELECT COALESCE(NULLIF(TRIM(custom_name), ''), node_ip) FROM api_nodes ORDER BY last_active DESC").fetch_all(&state.db).await?;
    if !active_servers.contains(&"Direct Access".to_string()) { active_servers.insert(0, "Direct Access".to_string()); }
    let keys: Vec<(String, String)> = if user.role=="admin" { sqlx::query_as("SELECT token, CAST(created_at AS TEXT) FROM api_keys ORDER BY id DESC").fetch_all(&state.db).await? } else {vec![]};
    
    let nodes: Vec<(String, String, Option<String>, String, Option<f64>, Option<f64>)> = sqlx::query_as("SELECT node_ip, location, custom_name, CAST(last_active AS TEXT), lat, lon FROM api_nodes ORDER BY last_active DESC").fetch_all(&state.db).await?;
    
    let mut quota_map = serde_json::Map::new();
    for node in super::nodes::node_snapshots(&state.db).await? {
        quota_map.insert(node.ip.clone(), serde_json::to_value(node).expect("node snapshot is serializable"));
    }
    let node_quota_json = Value::Object(quota_map).to_string();

    let (dyn_bright, res_bright, res_time, anim_speed, init_speed, init_thick, res_thick, dash_length, dash_gap): (f64, f64, f64, f64, f64, f64, f64, f64, f64) = sqlx::query_as("SELECT dyn_bright, res_bright, res_time, anim_speed, init_speed, COALESCE(init_thick, 1.5), COALESCE(res_thick, 0.5), COALESCE(dash_length, 20.0), COALESCE(dash_gap, 60.0) FROM admin_settings WHERE id = 1").fetch_optional(&state.db).await?.unwrap_or((4.0, 3.5, 3.0, 0.5, 0.1, 1.5, 0.5, 20.0, 60.0));
    
    let current_loc = state.server_loc.load();
    let mut nodes_map = std::collections::HashMap::new();
    nodes_map.insert("Direct Access".to_string(), (current_loc.lat, current_loc.lon));
    for n in &nodes {
        let mut name = n.2.clone().unwrap_or(n.0.clone()); if name.trim().is_empty() { name = n.0.clone(); }
        let mut f_lat = n.4.unwrap_or(current_loc.lat); let mut f_lon = n.5.unwrap_or(current_loc.lon);
        if f_lat == 0.0 && f_lon == 0.0 { f_lat = current_loc.lat; f_lon = current_loc.lon; } nodes_map.insert(name, (f_lat, f_lon));
    }
    
    let map_api_key = std::env::var("CARTO_API_KEY")
        .or_else(|_| std::env::var("MAP_API_KEY"))
        .unwrap_or_default();
    let map_tile_url = std::env::var("MAP_TILE_URL").unwrap_or_default();

    let html=visuals::generate_admin_ui(
        &selected_node, active_servers, stats, history, heatmap, keys, nodes, serde_json::to_string(&nodes_map).unwrap(),
        &current_loc, is_zh, 
        if is_zh { "🕸️ 历史连线: 开" } else { "🕸️ Hist Lines: On" }, 
        if is_zh { "🌫️ 迷雾热力: 关" } else { "🌫️ Fog Heat: Off" },
        dyn_bright, res_bright, res_time, anim_speed, init_speed, init_thick, res_thick, dash_length, dash_gap,
        if is_zh { "轨迹滑块长度 (Dash Length)" } else { "Dash Length (Pulse Size)" }, 
        if is_zh { "轨迹滑块间隙 (Dash Gap/Density)" } else { "Dash Gap (Pulse Density)" },
        node_quota_json,
        map_api_key,
        map_tile_url,
    );
    Ok(crate::account::page_response(html,&state.auth,&user))
}

pub async fn get_retention_handler(_auth: AdminAuth, State(state): State<AppState>) -> Result<Response, AppError> {
    let days: i32 = sqlx::query_scalar("SELECT COALESCE(retention_days, 30) FROM admin_settings WHERE id = 1")
        .fetch_one(&state.db).await.unwrap_or(30);
    Ok((StatusCode::OK, axum::Json(serde_json::json!({ "days": days }))).into_response())
}

pub async fn set_retention_handler(_auth: AdminAuth, State(state): State<AppState>, axum::Json(p): axum::Json<RetentionParams>) -> Result<Response, AppError> {
    let safe_days = p.days.clamp(1, 30);
    let _ = sqlx::query("UPDATE admin_settings SET retention_days = $1 WHERE id = 1")
        .bind(safe_days).execute(&state.db).await?;
    Ok((StatusCode::OK, "✅ 自动清理保留周期已更新").into_response())
}

pub async fn manual_clean_handler(_auth: AdminAuth, State(state): State<AppState>, axum::Json(p): axum::Json<CleanParams>) -> Result<Response, AppError> {
    if p.days == -1 {
        let _ = sqlx::query("TRUNCATE TABLE visitor_logs").execute(&state.db).await?;
        let _ = sqlx::query("TRUNCATE TABLE user_operations").execute(&state.db).await?;
        return Ok((StatusCode::OK, "✅ 已不可逆地清空所有时序数据").into_response());
    }
    
    let logs_del = sqlx::query("SELECT drop_chunks('visitor_logs', older_than => make_interval(days => $1))")
        .bind(p.days).execute(&state.db).await;
    if let Err(e) = logs_del { tracing::warn!("手动 drop_chunks visitor_logs 报错: {}", e); }
        
    let op_del = sqlx::query("SELECT drop_chunks('user_operations', older_than => make_interval(days => $1))")
        .bind(p.days).execute(&state.db).await;
    if let Err(e) = op_del { tracing::warn!("手动 drop_chunks user_operations 报错: {}", e); }
    
    Ok((StatusCode::OK, format!("✅ 已成功清理 {} 天以前的数据区块", p.days)).into_response())
}

pub async fn generate_key_handler(_auth: AdminAuth, State(state): State<AppState>) -> Result<Response, AppError> {
    let new_key = format!("sk_{}", crate::account::generate_secure_token(24));
    let _ = sqlx::query("INSERT INTO api_keys (token) VALUES ($1)").bind(new_key).execute(&state.db).await?; 
    Ok(StatusCode::OK.into_response())
}

pub async fn delete_key_handler(_auth: AdminAuth, Query(p): Query<ActionParams>, State(state): State<AppState>) -> Result<Response, AppError> {
    if let Some(tok) = p.token { let _ = sqlx::query("DELETE FROM api_keys WHERE token = $1").bind(tok).execute(&state.db).await?; } 
    Ok(StatusCode::OK.into_response())
}

pub async fn get_ip_mode_handler(_auth: AdminAuth, State(state): State<AppState>) -> Response {
    let mode = match **state.ip_lookup_mode.load() { IpLookupMode::LocalDb => "LocalDb", IpLookupMode::HttpApi => "HttpApi" };
    (StatusCode::OK, mode).into_response()
}

pub async fn switch_ip_mode_handler(_auth: AdminAuth, State(state): State<AppState>, axum::Json(p): axum::Json<SettingsParams>) -> Response {
    if p.mode == IpLookupMode::LocalDb && state.geo_db.load().is_none() { return (StatusCode::BAD_REQUEST, "❌ 本地离线库未加载").into_response(); }
    state.ip_lookup_mode.store(Arc::new(p.mode));
    (StatusCode::OK, "✅ 切换成功").into_response()
}
