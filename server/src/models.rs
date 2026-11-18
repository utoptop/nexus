use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use tokio::sync::{broadcast, mpsc, Mutex};
use moka::future::Cache;
use arc_swap::ArcSwap;
use serde_json::Value;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub enum IpLookupMode { LocalDb, HttpApi }

#[derive(Clone, Debug)]
pub struct LogEntry {
    pub server_name: String,
    pub ip_id: i32,
    pub language: String,
    pub target_domain: String,
    pub visit_time: chrono::DateTime<chrono::Utc>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct LiveEvent {
    pub ip: String, pub location: String, pub lat: f64, pub lon: f64,
    pub lang: String, pub time: String, pub hour: usize, pub server_name: String, pub target_domain: String,
    pub count: usize, 
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct UserOperationEntry {
    pub visitor_uuid: String, pub ip_address: String, pub operation_type: String,
    pub element_id: String, pub page_url: String, pub operation_details: Value,
    pub op_time: chrono::DateTime<chrono::Utc>,
}

#[derive(Deserialize, Debug)]
pub struct TrackItem {
    pub ip: String,
    pub domain: String,
}

#[derive(Deserialize, Debug)]
pub struct NodeMetrics {
    pub rx_bytes_total: u64,
    pub tx_bytes_total: u64,
    pub rx_speed_bps: u64,
    pub tx_speed_bps: u64,
}

#[derive(Clone, Serialize, sqlx::FromRow)]
pub struct NodeSnapshot {
    pub ip: String, pub name: String, pub location: String,
    pub lat: f64, pub lon: f64, pub last_active: String,
    // Agent reports only; manual edits and historical visits cannot revive a node.
    pub last_report_ms: Option<i64>, pub report_age_ms: Option<i64>,
    pub offline_after_ms: i64, pub online: bool,
    pub rx_speed: i64, pub tx_speed: i64,
    pub rx_bytes: i64, pub tx_bytes: i64, pub quota_bytes: i64,
    pub reset_day: i32, pub mode: String,
}

#[derive(Clone, Serialize)]
pub struct WsMetricsEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<NodeSnapshot>,
    pub event_type: String,
    pub ip: String,
    pub name: String,
    pub rx_speed: u64,
    pub tx_speed: u64,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Clone, Serialize)]
pub struct ServerLocation { pub lat: f64, pub lon: f64, pub city: String }

#[allow(clippy::type_complexity)]
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<crate::config::Config>,
    pub db: sqlx::PgPool,
    pub auth: Arc<crate::account::config::AuthConfig>,
    pub server_loc: Arc<ArcSwap<ServerLocation>>,
    pub tx: broadcast::Sender<Arc<Vec<u8>>>,
    pub ingest_slots: Arc<tokio::sync::Semaphore>,
    pub metrics_tx: broadcast::Sender<WsMetricsEvent>,
    pub ws_tx: mpsc::Sender<LiveEvent>, 
    pub http_client: reqwest::Client,
    pub geo_cache: Cache<String, (i32, String, f64, f64)>,
    pub log_tx: mpsc::Sender<LogEntry>,
    pub geo_db: Arc<ArcSwap<Option<maxminddb::Reader<Vec<u8>>>>>,
    pub node_activity_cache: Cache<String, bool>,
    pub ip_lookup_mode: Arc<ArcSwap<IpLookupMode>>,
    pub op_tx: mpsc::Sender<UserOperationEntry>,
    pub admin_sessions: Arc<Mutex<VecDeque<(u64, i64, mpsc::Sender<()>)>>>,
    pub next_session_id: Arc<AtomicU64>,
}

#[derive(Deserialize)]
pub struct AdminParams {
    pub node: Option<String>, pub days: Option<f64>,
    pub hide_nexus: Option<bool>, pub nexus_host: Option<String>,
}
#[derive(Deserialize)]
pub struct ActionParams { pub token: Option<String>, pub ip: Option<String>, pub name: Option<String>, pub loc_ip: Option<String> }
#[derive(Deserialize)]
pub struct SettingsParams { pub mode: IpLookupMode }

#[derive(Deserialize)]
pub struct RetentionParams { pub days: i32 }
#[derive(Deserialize)]
pub struct CleanParams { pub days: i32 }

#[derive(Deserialize)]
pub struct QuotaUpdateParams { 
    pub ip: String, 
    pub quota_gb: f64, 
    pub reset_day: i32,
    pub quota_mode: String
}

#[derive(Deserialize)]
pub struct CorrectionParams {
    pub ip: String,
    pub used_gb: f64,
    pub correction_type: String
}

#[derive(Deserialize)]
pub struct HttpApiGeoResponse {
    pub status: String, pub country: Option<String>, pub city: Option<String>,
    pub lat: Option<f64>, pub lon: Option<f64>,
}

pub type StatsRow = (String, String, i64, String, String, Option<f64>, Option<f64>, String, String);
pub type HistoryRow = (f64, f64, String, String, String, String, String);
pub type HeatmapRow = (String, i64);
