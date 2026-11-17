use crate::models::{AppState, LogEntry, UserOperationEntry, LiveEvent, IpLookupMode};
use std::sync::Arc;
use tokio::time::Duration;
use sqlx::{QueryBuilder, Postgres};
use maxminddb::Reader;

pub async fn flush_logs(db: &sqlx::PgPool, buffer: &mut Vec<LogEntry>) {
    let mut query_builder: QueryBuilder<Postgres> = QueryBuilder::new(
        "INSERT INTO visitor_logs (server_name, ip_id, language, target_domain, visit_time) "
    );

    query_builder.push_values(buffer.iter(), |mut b, entry| {
        b.push_bind(&entry.server_name).push_bind(entry.ip_id)
         .push_bind(&entry.language).push_bind(&entry.target_domain).push_bind(entry.visit_time);
    });

    if let Err(e) = query_builder.build().execute(db).await { 
        tracing::error!("批量写入 visitor_logs 失败: {}", e); 
    }
    buffer.clear();
}

pub async fn flush_operations(db: &sqlx::PgPool, buffer: &mut Vec<UserOperationEntry>) {
    let mut query_builder: QueryBuilder<Postgres> = QueryBuilder::new(
        "INSERT INTO user_operations (visitor_uuid, ip_address, operation_type, element_id, page_url, operation_details, op_time) "
    );
    query_builder.push_values(buffer.iter(), |mut b, op| {
        b.push_bind(&op.visitor_uuid).push_bind(&op.ip_address).push_bind(&op.operation_type)
         .push_bind(&op.element_id).push_bind(&op.page_url).push_bind(&op.operation_details).push_bind(op.op_time);
    });
    
    if let Err(e) = query_builder.build().execute(db).await {
        tracing::error!("批量写入 user_operations 失败: {}", e); 
    }
    buffer.clear();
}

pub fn spawn_flush_loops(state: AppState, mut log_rx: tokio::sync::mpsc::Receiver<LogEntry>, mut op_rx: tokio::sync::mpsc::Receiver<UserOperationEntry>) {
    let db_logs = state.db.clone();
    tokio::spawn(async move {
        let mut buffer = Vec::with_capacity(4000);
        let mut interval = tokio::time::interval(Duration::from_millis(800));
        loop {
            tokio::select! {
                Some(entry) = log_rx.recv() => {
                    buffer.push(entry);
                    if buffer.len() >= 4000 { flush_logs(&db_logs, &mut buffer).await; }
                }
                _ = interval.tick() => { if !buffer.is_empty() { flush_logs(&db_logs, &mut buffer).await; } }
            }
        }
    });

    let db_ops = state.db.clone();
    tokio::spawn(async move {
        let mut buffer = Vec::with_capacity(2000);
        let mut interval = tokio::time::interval(Duration::from_millis(1000));
        loop {
            tokio::select! {
                Some(entry) = op_rx.recv() => {
                    buffer.push(entry);
                    if buffer.len() >= 2000 { flush_operations(&db_ops, &mut buffer).await; }
                }
                _ = interval.tick() => { if !buffer.is_empty() { flush_operations(&db_ops, &mut buffer).await; } }
            }
        }
    });
}

pub fn spawn_db_cleanup_task(db: sqlx::PgPool) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(3600 * 6));
        loop {
            interval.tick().await;
            tracing::info!("♻️ 启动数据生命周期定期清理任务...");
            
            let days: i32 = sqlx::query_scalar("SELECT COALESCE(retention_days, 30) FROM admin_settings WHERE id = 1")
                .fetch_one(&db).await.unwrap_or(30);
            
            // 🚀 [核心修复] 使用 TimescaleDB专用的 drop_chunks 来直接抹除文件实现秒级真实磁盘空间释放 (无Dead Tuples)
            let logs_del = sqlx::query("SELECT drop_chunks('visitor_logs', older_than => make_interval(days => $1))")
                .bind(days)
                .execute(&db).await;
                
            if let Err(e) = logs_del {
                tracing::warn!("TimescaleDB drop_chunks visitor_logs 失败 (若建表未使用 hypertable，请忽略): {}", e);
            }
                
            let op_del = sqlx::query("SELECT drop_chunks('user_operations', older_than => make_interval(days => $1))")
                .bind(days)
                .execute(&db).await;
                
            if let Err(e) = op_del {
                tracing::warn!("TimescaleDB drop_chunks user_operations 失败: {}", e);
            }

            // 定期清理过期的管理员 Session，释放数据库空间并防止历史残留
            let _ = sqlx::query("DELETE FROM admin_sessions WHERE expires_at < CURRENT_TIMESTAMP")
                .execute(&db)
                .await;
            
            tracing::info!("✅ 数据周期清理完成 (保留 {} 天)", days);
        }
    });
}

pub fn spawn_ws_batch_loop(mut ws_rx: tokio::sync::mpsc::Receiver<LiveEvent>, tx: tokio::sync::broadcast::Sender<Arc<Vec<u8>>>) {
    tokio::spawn(async move {
        // Preserve every visit and arrival order; batching only reduces transport overhead.
        let mut buffer: Vec<LiveEvent> = Vec::with_capacity(500);
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                event = ws_rx.recv() => {
                    let Some(event) = event else {
                        if !buffer.is_empty() && tx.receiver_count() > 0
                            && let Ok(bytes) = rmp_serde::to_vec_named(&buffer) {
                            let _ = tx.send(Arc::new(bytes));
                        }
                        break;
                    };
                    buffer.push(event);
                    if buffer.len() >= 500 {
                        if tx.receiver_count() > 0 && let Ok(bytes) = rmp_serde::to_vec_named(&buffer) {
                            let _ = tx.send(Arc::new(bytes));
                        }
                        buffer.clear();
                    }
                }
                _ = interval.tick() => {
                    if !buffer.is_empty() {
                        if tx.receiver_count() > 0 && let Ok(bytes) = rmp_serde::to_vec_named(&buffer) {
                            let _ = tx.send(Arc::new(bytes));
                        }
                        buffer.clear();
                    }
                }
            }
        }
    });
}

pub fn spawn_geo_watcher(
    _watch_rx: &mut tokio::sync::mpsc::Receiver<()>,
    _geo_db_watcher: Arc<arc_swap::ArcSwap<Option<Reader<Vec<u8>>>>>,
    _ip_mode_watcher: Arc<arc_swap::ArcSwap<IpLookupMode>>,
) {
    // 因为所有权和生命周期原因，我们将逻辑封装起来在外面包一层 async
}

pub async fn handle_geo_file_changes(
    mut watch_rx: tokio::sync::mpsc::Receiver<()>,
    geo_db_watcher: Arc<arc_swap::ArcSwap<Option<Reader<Vec<u8>>>>>,
    ip_mode_watcher: Arc<arc_swap::ArcSwap<IpLookupMode>>,
    geoip_path: std::path::PathBuf,
) {
    while watch_rx.recv().await.is_some() {
        tokio::time::sleep(Duration::from_secs(3)).await;
        while watch_rx.try_recv().is_ok() {} 
        
        tracing::info!("📡 侦测到 GeoLite2-City.mmdb 更新，尝试重载本地库...");
        if let Ok(new_db) = maxminddb::Reader::open_readfile(&geoip_path) {
            let is_first_load = geo_db_watcher.load().is_none();
            geo_db_watcher.store(Arc::new(Some(new_db)));
            if is_first_load { 
                ip_mode_watcher.store(Arc::new(IpLookupMode::LocalDb)); 
            }
            tracing::info!("✅ 地理位置离线库已成功重载！");
        } else {
            tracing::error!("❌ 重载离线库文件失败，它可能破损或正在被写入。");
        }
    }
}

#[cfg(test)]
mod live_batch_tests {
    use super::*;

    #[tokio::test]
    async fn batching_preserves_repeated_visits_order_and_final_partial_batch() {
        let (input, receiver) = tokio::sync::mpsc::channel(1024);
        let (output, mut batches) = tokio::sync::broadcast::channel(32);
        spawn_ws_batch_loop(receiver, output);
        for i in 0..1001 {
            input.send(LiveEvent {
                ip: "198.51.100.1".into(), location: "Shanghai".into(),
                lat: 31.0, lon: 121.0, lang: "zh".into(), time: format!("visit-{i}"),
                hour: 1, server_name: "Tokyo".into(), target_domain: "example.test".into(), count: 1,
            }).await.unwrap();
        }
        drop(input);
        let mut seen = Vec::new();
        while seen.len() < 1001 {
            let bytes = tokio::time::timeout(Duration::from_secs(2), batches.recv()).await.unwrap().unwrap();
            let batch: Vec<LiveEvent> = rmp_serde::from_slice(&bytes).unwrap();
            assert!(batch.len() <= 500);
            seen.extend(batch);
        }
        assert_eq!(seen.len(), 1001);
        for (i, event) in seen.iter().enumerate() {
            assert_eq!(event.time, format!("visit-{i}"));
            assert_eq!(event.count, 1);
        }
    }
}
