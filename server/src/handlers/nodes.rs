use crate::error::AppError;
use axum::{
    body::Bytes,
    extract::{Query, State},
    http::HeaderMap,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::Datelike;

use crate::extractors::auth::{AdminAuth, ApiAuth};
use crate::models::*;
use crate::utils::fetch_geo;

pub async fn rename_node_handler(
    _auth: AdminAuth,
    Query(p): Query<ActionParams>,
    State(state): State<AppState>,
) -> Response {
    if let (Some(ip), Some(name)) = (p.ip.clone(), p.name.clone()) {
        let _ = sqlx::query("UPDATE api_nodes SET custom_name = $1 WHERE node_ip = $2")
            .bind(&name)
            .bind(&ip)
            .execute(&state.db)
            .await;
        if let Some(loc_ip) = p.loc_ip {
            let trim_ip = loc_ip.trim();
            if !trim_ip.is_empty() {
                let (loc, lat_opt, lon_opt) = fetch_geo(
                    trim_ip,
                    &state.http_client,
                    &state.geo_db,
                    &state.ip_lookup_mode,
                )
                .await;
                let lat = lat_opt.unwrap_or(0.0);
                let lon = lon_opt.unwrap_or(0.0);
                if lat != 0.0 || lon != 0.0 {
                    let _ = sqlx::query(
                        "UPDATE api_nodes SET location = $1, lat = $2, lon = $3 WHERE node_ip = $4",
                    )
                    .bind(&loc)
                    .bind(lat)
                    .bind(lon)
                    .bind(&ip)
                    .execute(&state.db)
                    .await;
                    return (
                        StatusCode::OK,
                        axum::Json(
                            serde_json::json!({ "updated_geo": true, "lat": lat, "lon": lon }),
                        ),
                    )
                        .into_response();
                }
            }
        }
        return (
            StatusCode::OK,
            axum::Json(serde_json::json!({"updated_geo": false})),
        )
            .into_response();
    }
    StatusCode::BAD_REQUEST.into_response()
}

pub async fn add_node_handler(
    _auth: AdminAuth,
    Query(p): Query<ActionParams>,
    State(state): State<AppState>,
) -> Response {
    if let Some(ip_or_name) = p.name {
        let (loc, lat_opt, lon_opt) = fetch_geo(
            &ip_or_name,
            &state.http_client,
            &state.geo_db,
            &state.ip_lookup_mode,
        )
        .await;
        let lat = lat_opt.unwrap_or(0.0);
        let lon = lon_opt.unwrap_or(0.0);

        if sqlx::query("UPDATE api_nodes SET location = $1, lat = $2, lon = $3, last_active = CURRENT_TIMESTAMP WHERE node_ip = $4").bind(&loc).bind(lat).bind(lon).bind(&ip_or_name).execute(&state.db).await.map(|r| r.rows_affected()).unwrap_or(0) == 0 {
            let _ = sqlx::query("INSERT INTO api_nodes (node_ip, location, lat, lon) VALUES ($1, $2, $3, $4)").bind(&ip_or_name).bind(&loc).bind(lat).bind(lon).execute(&state.db).await;
        }
        return (
            StatusCode::OK,
            axum::Json(serde_json::json!({ "lat": lat, "lon": lon })),
        )
            .into_response();
    }
    StatusCode::BAD_REQUEST.into_response()
}

pub async fn delete_node_handler(
    _auth: AdminAuth,
    Query(p): Query<ActionParams>,
    State(state): State<AppState>,
) -> Response {
    if let Some(ip) = p.ip {
        let _ = sqlx::query("DELETE FROM api_nodes WHERE node_ip = $1")
            .bind(ip)
            .execute(&state.db)
            .await;
    }
    StatusCode::OK.into_response()
}

const NODE_SELECT: &str = "SELECT node_ip AS ip,COALESCE(NULLIF(TRIM(custom_name),''),node_ip) AS name,COALESCE(location,'Unknown') AS location,COALESCE(lat,0) AS lat,COALESCE(lon,0) AS lon,CAST(last_active AS TEXT) AS last_active,CAST(EXTRACT(EPOCH FROM (last_report_at AT TIME ZONE current_setting('TimeZone')))*1000 AS BIGINT) AS last_report_ms,CASE WHEN last_report_at IS NOT NULL THEN CAST(GREATEST(0,EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP-last_report_at))*1000) AS BIGINT) END AS report_age_ms,30000::BIGINT AS offline_after_ms,COALESCE(last_report_at>CURRENT_TIMESTAMP-INTERVAL '30 seconds',false) AS online,CASE WHEN last_metrics_at>CURRENT_TIMESTAMP-INTERVAL '15 seconds' THEN rx_speed_bps ELSE 0 END AS rx_speed,CASE WHEN last_metrics_at>CURRENT_TIMESTAMP-INTERVAL '15 seconds' THEN tx_speed_bps ELSE 0 END AS tx_speed,current_rx_bytes AS rx_bytes,current_tx_bytes AS tx_bytes,monthly_quota_bytes AS quota_bytes,reset_day,quota_mode AS mode FROM api_nodes";

pub async fn node_snapshot(db: &sqlx::PgPool, ip: &str) -> Result<NodeSnapshot, sqlx::Error> {
    sqlx::query_as(&format!("{NODE_SELECT} WHERE node_ip=$1"))
        .bind(ip)
        .fetch_one(db)
        .await
}
pub async fn node_snapshots(db: &sqlx::PgPool) -> Result<Vec<NodeSnapshot>, sqlx::Error> {
    sqlx::query_as(&format!("{NODE_SELECT} ORDER BY online DESC, name, ip LIMIT 10000"))
        .fetch_all(db).await
}
pub fn publish_node(state: &AppState, event: &str, node: NodeSnapshot) {
    let _ = state.metrics_tx.send(WsMetricsEvent {
        event_type: event.into(),
        ip: node.ip.clone(),
        name: node.name.clone(),
        rx_speed: node.rx_speed as u64,
        tx_speed: node.tx_speed as u64,
        lat: node.lat,
        lon: node.lon,
        snapshot: Some(node),
    });
}
pub async fn node_snapshot_handler(
    _auth: AdminAuth,
    State(state): State<AppState>,
) -> Result<Response, AppError> {
    let nodes = node_snapshots(&state.db).await?;
    Ok((
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        axum::Json(serde_json::json!({"nodes":nodes,"websocket_path":state.auth.path("/ws")})),
    )
        .into_response())
}

pub async fn api_node_metrics_handler(
    _auth: ApiAuth,
    headers: HeaderMap,
    State(state): State<AppState>,
    body: Bytes,
) -> Response {
    let node_ip = headers
        .get("x-node-ip")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_string();
    if node_ip.is_empty() || node_ip.len() > 128 {
        return (StatusCode::BAD_REQUEST, "Missing or invalid X-Node-IP").into_response();
    }
    let payload: NodeMetrics = match rmp_serde::from_slice(&body) {
        Ok(data) => data,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid MessagePack metrics").into_response(),
    };
    // Preserve the 1.x agent's two-second accounting contract; reject overflow.
    let (Some(rx), Some(tx)) = (
        payload
            .rx_speed_bps
            .checked_mul(2)
            .and_then(|n| i64::try_from(n).ok()),
        payload
            .tx_speed_bps
            .checked_mul(2)
            .and_then(|n| i64::try_from(n).ok()),
    ) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let result=async {
        super::tracker::handle_node_activity(&state,&node_ip).await?;
        // Row-atomic increments; a reset can happen at most once on the reset day.
        sqlx::query("UPDATE api_nodes SET current_rx_bytes=(CASE WHEN reset_day=$4 AND last_quota_reset IS DISTINCT FROM $5 THEN 0 ELSE current_rx_bytes END)+$1,current_tx_bytes=(CASE WHEN reset_day=$4 AND last_quota_reset IS DISTINCT FROM $5 THEN 0 ELSE current_tx_bytes END)+$2,last_quota_reset=CASE WHEN reset_day=$4 THEN $5 ELSE last_quota_reset END,rx_speed_bps=$1/2,tx_speed_bps=$2/2,last_active=CURRENT_TIMESTAMP,last_metrics_at=CURRENT_TIMESTAMP,last_report_at=CURRENT_TIMESTAMP WHERE node_ip=$3")
            .bind(rx).bind(tx).bind(&node_ip).bind(chrono::Local::now().day() as i32).bind(chrono::Local::now().date_naive()).execute(&state.db).await?;
        node_snapshot(&state.db,&node_ip).await
    }.await;
    match result {
        Ok(node) => {
            publish_node(&state, "metrics", node);
            StatusCode::OK.into_response()
        }
        Err(error) => {
            tracing::error!("Node metrics were not acknowledged: {error}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                [(axum::http::header::RETRY_AFTER, "2")],
                "Node metrics unavailable; retry",
            )
                .into_response()
        }
    }
}

pub async fn update_node_quota_handler(
    _auth: AdminAuth,
    State(state): State<AppState>,
    axum::Json(p): axum::Json<QuotaUpdateParams>,
) -> impl IntoResponse {
    let quota_bytes = (p.quota_gb * 1024.0 * 1024.0 * 1024.0) as i64;
    let _ = sqlx::query("UPDATE api_nodes SET monthly_quota_bytes = $1, reset_day = $2, quota_mode = $3 WHERE node_ip = $4")
        .bind(quota_bytes).bind(p.reset_day).bind(&p.quota_mode).bind(&p.ip).execute(&state.db).await;
    (StatusCode::OK, "✅ 节点流量配额配置已更新").into_response()
}

pub async fn correction_node_traffic_handler(
    _auth: AdminAuth,
    State(state): State<AppState>,
    axum::Json(p): axum::Json<CorrectionParams>,
) -> impl IntoResponse {
    let used_bytes = (p.used_gb * 1024.0 * 1024.0 * 1024.0) as i64;
    let query = match p.correction_type.as_str() {
        "rx" => "UPDATE api_nodes SET current_rx_bytes = $1 WHERE node_ip = $2",
        "tx" => "UPDATE api_nodes SET current_tx_bytes = $1 WHERE node_ip = $2",
        _ => "UPDATE api_nodes SET current_rx_bytes = $1, current_tx_bytes = 0 WHERE node_ip = $2",
    };
    let _ = sqlx::query(query)
        .bind(used_bytes)
        .bind(&p.ip)
        .execute(&state.db)
        .await;
    (StatusCode::OK, "✅ 节点流量已手动校正").into_response()
}
