use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use std::sync::atomic::Ordering;

use crate::extractors::auth::AdminAuth;
use crate::models::AppState;

pub async fn ws_handler(
    AdminAuth(auth): AdminAuth,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if !crate::account::origin_allowed(&state.auth, &headers) {
        tracing::warn!(
            origin = headers
                .get("origin")
                .and_then(|h| h.to_str().ok())
                .unwrap_or(""),
            host = headers
                .get("host")
                .and_then(|h| h.to_str().ok())
                .unwrap_or(""),
            "WebSocket origin rejected; check PUBLIC_BASE_URL and ALLOWED_ORIGINS"
        );
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.on_upgrade(|socket| handle_socket(socket, state, auth))
        .into_response()
}

async fn handle_socket(mut socket: WebSocket, state: AppState, auth: crate::account::Principal) {
    let session_id = state.next_session_id.fetch_add(1, Ordering::SeqCst);
    let (kill_tx, mut kill_rx) = tokio::sync::mpsc::channel::<()>(1);

    {
        let mut sessions = state.admin_sessions.lock().await;
        while sessions
            .iter()
            .filter(|(_, uid, _)| *uid == auth.id)
            .count()
            >= 5
            || sessions.len() >= 64
        {
            let pos = if sessions.len() >= 64 {
                0
            } else {
                sessions
                    .iter()
                    .position(|(_, uid, _)| *uid == auth.id)
                    .unwrap_or(0)
            };
            if let Some((_, _, tx)) = sessions.remove(pos) {
                let _ = tx.try_send(());
            }
        }
        sessions.push_back((session_id, auth.id, kill_tx));
    }

    let mut rx = state.tx.subscribe();
    let mut metrics_rx = state.metrics_tx.subscribe();

    let mut session_check = tokio::time::interval(std::time::Duration::from_secs(30));
    loop {
        tokio::select! {
            _ = session_check.tick() => {
                let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM user_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>CURRENT_TIMESTAMP AND u.status='active' AND s.auth_version=u.auth_version)").bind(&auth.session_hash).fetch_one(&state.db).await.unwrap_or(false);
                if !valid {break;}
                if !matches!(tokio::time::timeout(std::time::Duration::from_secs(5),socket.send(Message::Ping(Vec::new()))).await,Ok(Ok(()))){break;}
            }
            batch = rx.recv() => {
                match batch {
                    Ok(bytes) => {
                        if !matches!(tokio::time::timeout(std::time::Duration::from_secs(5), socket.send(Message::Binary((*bytes).clone()))).await, Ok(Ok(()))) { break; }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        // Tell the client its live view needs a bounded database refresh.
                        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), socket.send(Message::Text("resync".into()))).await;
                        break;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            Ok(metrics) = metrics_rx.recv() => {
                if let Ok(bin_data) = rmp_serde::to_vec_named(&metrics)
                    && !matches!(tokio::time::timeout(std::time::Duration::from_secs(5), socket.send(Message::Binary(bin_data))).await, Ok(Ok(()))) { break; }
            }
            _ = kill_rx.recv() => {
                let _ = socket.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: axum::extract::ws::close_code::POLICY,
                    reason: std::borrow::Cow::Borrowed("EVICTED"),
                }))).await;
                break;
            }
            msg = socket.recv() => {
                if matches!(msg, None | Some(Err(_)) | Some(Ok(Message::Close(_)))) { break; }
            }
        }
    }

    {
        let mut sessions = state.admin_sessions.lock().await;
        sessions.retain(|&(id, _, _)| id != session_id);
    }
}
