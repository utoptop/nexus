pub mod account;
pub mod visuals;
pub mod models;
pub mod utils;
pub mod handlers;
pub mod tasks;
pub mod extractors;
pub mod error;
pub mod db;

use axum::{
    routing::{get, post},
    Router,
};
use sqlx::postgres::PgPoolOptions;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};
use std::collections::VecDeque;
use std::sync::atomic::AtomicU64;
use tokio::sync::{broadcast, mpsc};
use moka::future::Cache;
use std::time::Duration;
use arc_swap::ArcSwap;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use models::{AppState, ServerLocation, LiveEvent, LogEntry, IpLookupMode, UserOperationEntry, WsMetricsEvent};
use utils::fetch_geo;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 采用 tracing 构建结构化日志
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(std::env::var("RUST_LOG").unwrap_or_else(|_| "info,nexus=debug".into())))
        .with(tracing_subscriber::fmt::layer())
        .init();

    // 加载 .env 环境变量文件
    dotenvy::dotenv().ok();
    visuals::load_frontend_assets()?;
    let auth=account::config::AuthConfig::from_env()?;
    account::ui_assets()?;
    
    // 修改为硬要求加载环境变量里的 DATABASE_URL
    let db_url = std::env::var("DATABASE_URL").map_err(|_| anyhow::anyhow!("DATABASE_URL must be configured"))?;
    
    tracing::info!("Connecting to Database...");
    let pool = PgPoolOptions::new()
        .max_connections(env_limit("DB_MAX_CONNECTIONS", 24, 4, 128) as u32)
        .min_connections(2)
        .idle_timeout(Duration::from_secs(120))
        .acquire_timeout(Duration::from_secs(10))
        .connect(&db_url).await?;

    tracing::info!("Initializing Database Schema...");
    init_db(&pool).await?;
    account::init(&pool).await?;

    let http_client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(3)).build().unwrap();
    let geo_cache = Cache::builder()
        .max_capacity((env_limit("GEO_CACHE_MB", 16, 1, 256) * 1024 * 1024) as u64)
        .weigher(|key: &String, value: &(i32, String, f64, f64)| {
            (key.len() + value.1.len() + 160).min(u32::MAX as usize) as u32
        })
        .time_to_idle(Duration::from_secs(60 * 60))
        .time_to_live(Duration::from_secs(24 * 60 * 60)).build();
    let node_activity_cache = Cache::builder().max_capacity(10_000).time_to_live(Duration::from_secs(10)).build();
    
    let initial_db = maxminddb::Reader::open_readfile("GeoLite2-City.mmdb").ok();
    if initial_db.is_some() { tracing::info!("✅ Loaded local GeoLite2-City database."); }
    
    let geo_db = Arc::new(ArcSwap::from_pointee(initial_db));
    let ip_lookup_mode = Arc::new(ArcSwap::from_pointee(if geo_db.load().is_some() { IpLookupMode::LocalDb } else { IpLookupMode::HttpApi }));

    let (watch_tx, watch_rx) = mpsc::channel(10);
    // 文件系统事件监视
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(event) = res && (event.kind.is_modify() || event.kind.is_create()) { let _ = watch_tx.try_send(()); }
    }).unwrap();
    use notify::{Watcher, RecursiveMode};
    let _ = watcher.watch(std::path::Path::new("GeoLite2-City.mmdb"), RecursiveMode::NonRecursive);

    let geo_db_watcher = geo_db.clone();
    let ip_mode_watcher = ip_lookup_mode.clone();
    
    tokio::spawn(async move {
        let _keep = watcher; 
        tasks::handle_geo_file_changes(watch_rx, geo_db_watcher, ip_mode_watcher).await;
    });

    let (s_loc, s_lat, s_lon) = fetch_geo("", &http_client, &geo_db, &ip_lookup_mode).await;
    let server_loc_initial = ServerLocation { lat: s_lat.unwrap_or(0.0), lon: s_lon.unwrap_or(0.0), city: s_loc };
    let server_loc = Arc::new(ArcSwap::from_pointee(server_loc_initial));

    let (tx, _) = broadcast::channel(32);
    let (metrics_tx, _) = broadcast::channel(128);
    
    let sloc_clone = server_loc.clone();
    let hc_clone = http_client.clone();
    let geo_clone = geo_db.clone();
    let ipm_clone = ip_lookup_mode.clone();
    let metrics_tx_clone = metrics_tx.clone();

    tokio::spawn(async move {
        loop {
            let (s_loc, s_lat, s_lon) = fetch_geo("Direct Access", &hc_clone, &geo_clone, &ipm_clone).await;
            let mut success = false;
            
            if let (Some(lat), Some(lon)) = (s_lat, s_lon)
                && lat != 0.0 && lon != 0.0 {
                    success = true;
                    let prev = sloc_clone.load();
                    if prev.lat != lat || prev.lon != lon {
                        sloc_clone.store(Arc::new(ServerLocation { lat, lon, city: s_loc.clone() }));
                        let _ = metrics_tx_clone.send(WsMetricsEvent { snapshot: None, event_type: "system_geo".to_string(), ip: "Direct Access".to_string(), name: s_loc, rx_speed: 0, tx_speed: 0, lat, lon });
                    }
                }

            if success { tokio::time::sleep(Duration::from_secs(3600)).await; } else { tokio::time::sleep(Duration::from_secs(10)).await; }
        }
    });

    let (ws_tx, ws_rx) = mpsc::channel::<LiveEvent>(env_limit("LIVE_QUEUE_CAPACITY", 8192, 512, 65536));
    tasks::spawn_ws_batch_loop(ws_rx, tx.clone());

    let (log_tx, log_rx) = mpsc::channel::<LogEntry>(env_limit("LOG_QUEUE_CAPACITY", 16384, 1024, 131072));
    let (op_tx, op_rx) = mpsc::channel::<UserOperationEntry>(2048);
    
    let state = AppState { auth:auth.clone(), ingest_slots: Arc::new(Semaphore::new(env_limit("INGEST_CONCURRENCY", 64, 4, 512))), db: pool.clone(), server_loc, tx, metrics_tx, ws_tx, http_client, geo_cache, log_tx, geo_db, node_activity_cache, ip_lookup_mode, op_tx, admin_sessions: Arc::new(Mutex::new(VecDeque::new())), next_session_id: Arc::new(AtomicU64::new(1)) };

    tasks::spawn_flush_loops(state.clone(), log_rx, op_rx);
    tasks::spawn_db_cleanup_task(pool.clone());
    account::spawn_cleanup(pool.clone());

    let admin=Router::new()
        .route("/", get(handlers::admin_handler))
        .route("/api/data", get(handlers::admin_data_handler))
        .route("/api/nodes", get(handlers::node_snapshot_handler))
        .route("/api/playback", get(handlers::admin_playback_handler))
        .route("/api/settings/ip-mode", get(handlers::get_ip_mode_handler).post(handlers::switch_ip_mode_handler))
        .route("/api/settings/retention", get(handlers::get_retention_handler).post(handlers::set_retention_handler))
        .route("/api/data/clean", post(handlers::manual_clean_handler))
        .route("/ws", get(handlers::ws_handler))
        .route("/nodes/quota", post(handlers::update_node_quota_handler)) 
        .route("/nodes/correction", post(handlers::correction_node_traffic_handler)) 
        .route("/api_keys/generate", post(handlers::generate_key_handler))
        .route("/api_keys/delete", post(handlers::delete_key_handler))
        .route("/nodes/rename", post(handlers::rename_node_handler))
        .route("/nodes/delete", post(handlers::delete_node_handler))
        .route("/nodes/add", post(handlers::add_node_handler))
        .route("/settings/visuals", post(visuals::update_visuals_handler))
        .merge(account::routes())
        .layer(axum::extract::DefaultBodyLimit::max(65536))
        .route_layer(axum::middleware::from_fn_with_state(state.clone(),account::csrf_guard));
    let app=Router::new()
        .route("/", get(handlers::visitor_handler))
        .route("/api/log-operation", post(handlers::log_operation_handler))
        .route("/api/track", get(handlers::api_track_handler).post(handlers::api_track_handler))
        .route("/api/track_batch", post(handlers::api_track_batch_handler))
        .route("/api/node/metrics", post(handlers::api_node_metrics_handler)) 
        .nest(&auth.admin_path,admin)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(std::env::var("LISTEN_ADDR").unwrap_or_else(|_|"0.0.0.0:3000".into())).await?;
    tracing::info!("🚀 [NEXUS] 异步高并发时序引擎启动完毕！(流量监控网关已开启)");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await?;
    Ok(())
}

async fn init_db(pool: &sqlx::PgPool) -> anyhow::Result<()> {
    sqlx::query("CREATE TABLE IF NOT EXISTS ip_dimensions (id SERIAL PRIMARY KEY, ip_address TEXT UNIQUE NOT NULL, location TEXT, lat DOUBLE PRECISION, lon DOUBLE PRECISION)").execute(pool).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS admin_sessions (token TEXT PRIMARY KEY, expires_at TIMESTAMP NOT NULL)").execute(pool).await?;
    sqlx::query("DELETE FROM admin_sessions WHERE expires_at < CURRENT_TIMESTAMP").execute(pool).await?;

    sqlx::query("CREATE TABLE IF NOT EXISTS visitor_logs (id SERIAL, server_name TEXT DEFAULT 'Direct', ip_id INTEGER NOT NULL, language TEXT, visit_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, target_domain TEXT DEFAULT '-', PRIMARY KEY (id, visit_time))").execute(pool).await.ok();
    let _ = sqlx::query("SELECT create_hypertable('visitor_logs', 'visit_time', if_not_exists => TRUE)").execute(pool).await;

    sqlx::query("CREATE TABLE IF NOT EXISTS user_operations (id SERIAL, visitor_uuid TEXT, ip_address TEXT, operation_type TEXT, element_id TEXT, page_url TEXT, operation_details JSONB, op_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id, op_time))").execute(pool).await.ok();
    let _ = sqlx::query("SELECT create_hypertable('user_operations', 'op_time', if_not_exists => TRUE)").execute(pool).await;

    sqlx::query("CREATE TABLE IF NOT EXISTS api_keys (id SERIAL PRIMARY KEY, token TEXT UNIQUE NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)").execute(pool).await?;
    
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS api_nodes (
            id SERIAL PRIMARY KEY, node_ip TEXT UNIQUE NOT NULL, custom_name TEXT, location TEXT, lat DOUBLE PRECISION, 
            lon DOUBLE PRECISION, last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP, monthly_quota_bytes BIGINT DEFAULT 0,
            reset_day INTEGER DEFAULT 1, current_rx_bytes BIGINT DEFAULT 0, current_tx_bytes BIGINT DEFAULT 0, quota_mode TEXT DEFAULT 'total' 
        )"
    ).execute(pool).await?;
    let _ = sqlx::query("ALTER TABLE api_nodes ADD CONSTRAINT api_nodes_node_ip_key UNIQUE (node_ip)").execute(pool).await;

    let _ = sqlx::query("ALTER TABLE api_nodes ADD COLUMN monthly_quota_bytes BIGINT DEFAULT 0").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE api_nodes ADD COLUMN reset_day INTEGER DEFAULT 1").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE api_nodes ADD COLUMN current_rx_bytes BIGINT DEFAULT 0").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE api_nodes ADD COLUMN current_tx_bytes BIGINT DEFAULT 0").execute(pool).await;
    let _ = sqlx::query("ALTER TABLE api_nodes ADD COLUMN quota_mode TEXT DEFAULT 'total'").execute(pool).await;

    for sql in [
        "ALTER TABLE api_nodes ADD COLUMN IF NOT EXISTS rx_speed_bps BIGINT NOT NULL DEFAULT 0",
        "ALTER TABLE api_nodes ADD COLUMN IF NOT EXISTS tx_speed_bps BIGINT NOT NULL DEFAULT 0",
        "ALTER TABLE api_nodes ADD COLUMN IF NOT EXISTS last_metrics_at TIMESTAMP",
        "ALTER TABLE api_nodes ADD COLUMN IF NOT EXISTS last_report_at TIMESTAMP",
        "ALTER TABLE api_nodes ADD COLUMN IF NOT EXISTS last_quota_reset DATE"
    ] {sqlx::query(sql).execute(pool).await?;}
    sqlx::query("UPDATE api_nodes SET last_report_at=last_metrics_at WHERE last_report_at IS NULL AND last_metrics_at IS NOT NULL").execute(pool).await?;

    sqlx::query("CREATE TABLE IF NOT EXISTS admin_auth (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, password TEXT NOT NULL)").execute(pool).await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS admin_settings (id INTEGER PRIMARY KEY CHECK(id=1), dyn_bright DOUBLE PRECISION DEFAULT 4.0, res_bright DOUBLE PRECISION DEFAULT 3.5, res_time DOUBLE PRECISION DEFAULT 3.0, anim_speed DOUBLE PRECISION DEFAULT 0.5, init_speed DOUBLE PRECISION DEFAULT 0.1, init_thick DOUBLE PRECISION DEFAULT 1.5, res_thick DOUBLE PRECISION DEFAULT 0.5, dash_length DOUBLE PRECISION DEFAULT 20.0, dash_gap DOUBLE PRECISION DEFAULT 60.0)").execute(pool).await?;
    sqlx::query("INSERT INTO admin_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING").execute(pool).await?;
    
    let _ = sqlx::query("ALTER TABLE admin_settings ADD COLUMN retention_days INTEGER DEFAULT 30").execute(pool).await;

    sqlx::query("CREATE INDEX IF NOT EXISTS idx_visitor_logs_visit_time ON visitor_logs (visit_time DESC)").execute(pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_visitor_logs_ip_id ON visitor_logs (ip_id)").execute(pool).await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_ip_dimensions_ip ON ip_dimensions (ip_address)").execute(pool).await?;

    let key_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM api_keys").fetch_one(pool).await.unwrap_or(0);
    if key_count == 0 {
        let initial_key = format!("sk_{}", account::generate_secure_token(24));
        sqlx::query("INSERT INTO api_keys (token) VALUES ($1)").bind(initial_key).execute(pool).await?;
    }
    
    Ok(())
}
fn env_limit(name: &str, default: usize, min: usize, max: usize) -> usize {
    std::env::var(name).ok().and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(default).clamp(min, max)
}
