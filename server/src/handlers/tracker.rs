use axum::{
    body::Bytes,
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode, header},
    response::{Html, IntoResponse},
};
use chrono::Timelike;
use std::net::SocketAddr;

use crate::extractors::auth::ApiAuth;
use crate::models::*;
use crate::utils::{parse_ips, resolve_ip_id};
use crate::visuals;

pub async fn visitor_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let xff = headers
        .get("x-forwarded-for")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .trim();
    let (primary_ip, display_ip) = parse_ips(xff, &addr.ip().to_string());

    let lang_header = headers
        .get("accept-language")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("en");
    let mut is_zh = lang_header.to_lowercase().contains("zh");
    if let Some(cookie_val) = headers.get(header::COOKIE).and_then(|h| h.to_str().ok()) {
        if cookie_val.contains("lang=zh") {
            is_zh = true;
        } else if cookie_val.contains("lang=en") {
            is_zh = false;
        }
    }

    let target_domain = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("Direct Access")
        .to_string();
    let permit = match state.ingest_slots.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                [(header::RETRY_AFTER, "1")],
                "Ingestion busy; retry",
            )
                .into_response();
        }
    };
    let (ip_id, loc, la, lo) = resolve_ip_id(
        &primary_ip,
        &state.db,
        &state.http_client,
        &state.geo_cache,
        &state.geo_db,
        &state.ip_lookup_mode,
    )
    .await;

    let state_clone = state.clone();
    let display_ip_clone = display_ip.clone();
    let lang_clone = lang_header.to_string();
    let loc_clone = loc.clone();

    tokio::spawn(async move {
        let _permit = permit;
        let now_utc = chrono::Utc::now();
        if let Err(e) = state_clone
            .log_tx
            .send(LogEntry {
                server_name: "Direct Access".to_string(),
                ip_id,
                language: lang_clone.clone(),
                target_domain: target_domain.clone(),
                visit_time: now_utc,
            })
            .await
        {
            tracing::warn!("Failed to enqueue visitor log: {}", e);
        }
        let _ = state_clone
            .ws_tx
            .send(LiveEvent {
                ip: display_ip_clone,
                location: loc_clone,
                lat: la,
                lon: lo,
                lang: lang_clone.split(',').next().unwrap_or("en").to_string(),
                time: now_utc.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                hour: chrono::Local::now().hour() as usize,
                server_name: "Direct Access".to_string(),
                target_domain,
                count: 1,
            })
            .await;
    });

    (
        [(header::CACHE_CONTROL, "no-store, no-cache")],
        Html(visuals::generate_visitor_ui(&display_ip, &loc, is_zh)),
    )
        .into_response()
}

pub async fn log_operation_handler(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    State(state): State<AppState>,
    axum::Json(mut op): axum::Json<UserOperationEntry>,
) -> StatusCode {
    let xff = headers
        .get("x-forwarded-for")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    op.ip_address = parse_ips(xff, &addr.ip().to_string()).0;
    op.op_time = chrono::Utc::now();
    let _ = state.op_tx.try_send(op);
    StatusCode::NO_CONTENT
}

pub async fn api_track_batch_handler(
    _auth: ApiAuth,
    headers: HeaderMap,
    State(state): State<AppState>,
    body: Bytes,
) -> impl IntoResponse {
    let node_ip = headers
        .get("x-node-ip")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_string();
    if node_ip.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing Node IP").into_response();
    }
    if body.len() > 512 * 1024 {
        return (StatusCode::PAYLOAD_TOO_LARGE, "Batch exceeds 512 KiB").into_response();
    }
    let items: Vec<TrackItem> = match rmp_serde::from_slice(&body) {
        Ok(data) => data,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid MessagePack payload").into_response(),
    };
    if items.len() > 2000
        || items
            .iter()
            .any(|item| item.ip.len() > 128 || item.domain.len() > 512)
    {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            "Batch exceeds 2000 events or field limits",
        )
            .into_response();
    }
    let permit = match state.ingest_slots.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                [(header::RETRY_AFTER, "1")],
                "Ingestion busy; retry",
            )
                .into_response();
        }
    };
    if let Err(error) = handle_node_activity(&state, &node_ip).await {
        tracing::error!("Node registration failed: {error}");
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::RETRY_AFTER, "2")],
            "Node registration unavailable; retry",
        )
            .into_response();
    }
    let state_clone = state.clone();
    tokio::spawn(async move {
        let _permit = permit;
        let node_name_for_ui = sqlx::query_scalar("SELECT COALESCE(NULLIF(TRIM(custom_name), ''), node_ip) FROM api_nodes WHERE node_ip = $1").bind(&node_ip).fetch_optional(&state_clone.db).await.unwrap_or(None).unwrap_or(node_ip.clone());
        for item in items {
            let (_, display_ip) = parse_ips(&item.ip, "0.0.0.0");
            let (ip_id, v_loc, la, lo) = resolve_ip_id(
                &item.ip,
                &state_clone.db,
                &state_clone.http_client,
                &state_clone.geo_cache,
                &state_clone.geo_db,
                &state_clone.ip_lookup_mode,
            )
            .await;
            let now_utc = chrono::Utc::now();
            let _ = state_clone
                .log_tx
                .send(LogEntry {
                    server_name: node_ip.clone(),
                    ip_id,
                    language: "en".to_string(),
                    target_domain: item.domain.clone(),
                    visit_time: now_utc,
                })
                .await;
            let _ = state_clone
                .ws_tx
                .send(LiveEvent {
                    ip: display_ip,
                    location: v_loc,
                    lat: la,
                    lon: lo,
                    lang: "en".to_string(),
                    time: now_utc.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    hour: chrono::Local::now().hour() as usize,
                    server_name: node_name_for_ui.clone(),
                    target_domain: item.domain,
                    count: 1,
                })
                .await;
        }
    });
    (StatusCode::OK, "Batch Processed").into_response()
}

pub async fn api_track_handler(
    _auth: ApiAuth,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let mut node_id = headers
        .get("x-node-ip")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_string();
    let proxy_ip = parse_ips(
        headers
            .get("x-forwarded-for")
            .and_then(|h| h.to_str().ok())
            .unwrap_or(""),
        &addr.ip().to_string(),
    )
    .0;
    if node_id.is_empty() {
        node_id = proxy_ip;
    }
    let visitor_xff = headers
        .get("x-visitor-ip")
        .or_else(|| headers.get("x-forwarded-for"))
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_string();
    let lang = headers
        .get("accept-language")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("en")
        .to_string();
    let mut target_domain = headers
        .get("x-target-domain")
        .or_else(|| headers.get("x-forwarded-host"))
        .or_else(|| headers.get("x-original-host"))
        .and_then(|h| h.to_str().ok())
        .unwrap_or("-")
        .trim()
        .to_string();
    if target_domain.is_empty() {
        target_domain = "-".to_string();
    }
    let permit = match state.ingest_slots.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                [(header::RETRY_AFTER, "1")],
                "Ingestion busy; retry",
            )
                .into_response();
        }
    };
    if let Err(error) = handle_node_activity(&state, &node_id).await {
        tracing::error!("Node registration failed: {error}");
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::RETRY_AFTER, "2")],
            "Node registration unavailable; retry",
        )
            .into_response();
    }
    let state_clone = state.clone();

    tokio::spawn(async move {
        let _permit = permit;
        let (_, display_ip) = parse_ips(&visitor_xff, "0.0.0.0");
        let (ip_id, v_loc, la, lo) = resolve_ip_id(
            &visitor_xff,
            &state_clone.db,
            &state_clone.http_client,
            &state_clone.geo_cache,
            &state_clone.geo_db,
            &state_clone.ip_lookup_mode,
        )
        .await;
        let now_utc = chrono::Utc::now();
        let _ = state_clone
            .log_tx
            .send(LogEntry {
                server_name: node_id.clone(),
                ip_id,
                language: lang.clone(),
                target_domain: target_domain.clone(),
                visit_time: now_utc,
            })
            .await;
        let node_name_for_ui = sqlx::query_scalar("SELECT COALESCE(NULLIF(TRIM(custom_name), ''), node_ip) FROM api_nodes WHERE node_ip = $1").bind(&node_id).fetch_optional(&state_clone.db).await.unwrap_or(None).unwrap_or(node_id);
        let _ = state_clone
            .ws_tx
            .send(LiveEvent {
                ip: display_ip,
                location: v_loc,
                lat: la,
                lon: lo,
                lang: lang.split(',').next().unwrap_or("en").to_string(),
                time: now_utc.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                hour: chrono::Local::now().hour() as usize,
                server_name: node_name_for_ui,
                target_domain,
                count: 1,
            })
            .await;
    });

    let pixel: [u8; 43] = [
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0xff, 0xff,
        0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00,
        0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
    ];
    (
        [
            (header::CONTENT_TYPE, "image/gif"),
            (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
        ],
        pixel,
    )
        .into_response()
}

// A registration ACK is sent only after the node exists. Geolocation is enrichment,
// so slow geo services must never delay the agent handshake or swallow first metrics.
pub async fn handle_node_activity(state: &AppState, node_id: &str) -> Result<(), sqlx::Error> {
    if state.node_activity_cache.get(node_id).await.is_some() {
        return Ok(());
    }
    sqlx::query("INSERT INTO api_nodes(node_ip,location,lat,lon,last_active,last_report_at) VALUES($1,'Unknown',0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(node_ip) DO UPDATE SET last_active=CURRENT_TIMESTAMP,last_report_at=CURRENT_TIMESTAMP")
        .bind(node_id).execute(&state.db).await?;
    let snapshot = super::nodes::node_snapshot(&state.db, node_id).await?;
    state
        .node_activity_cache
        .insert(node_id.to_owned(), true)
        .await;
    super::nodes::publish_node(state, "node", snapshot.clone());
    if snapshot.lat == 0.0 && snapshot.lon == 0.0 {
        let state = state.clone();
        let node_id = node_id.to_owned();
        tokio::spawn(async move {
            let (_, location, lat, lon) = resolve_ip_id(
                &node_id,
                &state.db,
                &state.http_client,
                &state.geo_cache,
                &state.geo_db,
                &state.ip_lookup_mode,
            )
            .await;
            if lat == 0.0 && lon == 0.0 {
                return;
            }
            let updated=sqlx::query("UPDATE api_nodes SET location=$1,lat=$2,lon=$3 WHERE node_ip=$4 AND COALESCE(lat,0)=0 AND COALESCE(lon,0)=0")
                .bind(location).bind(lat).bind(lon).bind(&node_id).execute(&state.db).await;
            if updated.is_ok_and(|r| r.rows_affected() > 0) {
                if let Ok(node) = super::nodes::node_snapshot(&state.db, &node_id).await {
                    super::nodes::publish_node(&state, "node", node);
                }
            }
        });
    }
    Ok(())
}
