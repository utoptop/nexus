use sqlx::PgPool;
use crate::models::{StatsRow, HistoryRow, HeatmapRow};
use crate::error::AppError;

pub async fn fetch_dashboard_data(db: &PgPool, nodes_param: &str, days: f64, hidden_domains: &str) -> Result<(Vec<StatsRow>, Vec<HistoryRow>, Vec<HeatmapRow>), AppError> {
    // Dashboard aggregations share one bounded transaction. Disable parallel DSM
    // allocations here without changing the ingestion pool's session settings.
    let mut query_tx = db.begin().await?;
    sqlx::query("SET LOCAL max_parallel_workers_per_gather = 0").execute(&mut *query_tx).await?;
    sqlx::query("SET LOCAL work_mem = '4MB'").execute(&mut *query_tx).await?;
    let days = normalize_days(days);
    let nodes: Vec<String> = nodes_param.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let is_all = nodes.contains(&"All".to_string()) || nodes.is_empty();

    let duration_secs = (days * 24.0 * 60.0 * 60.0) as i64;
    let cutoff = chrono::Utc::now() - chrono::Duration::seconds(duration_secs);

    let stats: Vec<StatsRow> = sqlx::query_as(
        r#"
        WITH resolved_nodes AS (SELECT node_ip, COALESCE(NULLIF(TRIM(custom_name), ''), node_ip) as display_name FROM api_nodes)
        SELECT d.ip_address, d.location, COUNT(*) as c, CAST(MAX(vl.visit_time) AS TEXT), vl.language, d.lat, d.lon, 
               COALESCE(rn.display_name, vl.server_name) AS final_server_name, COALESCE(vl.target_domain, '-') 
        FROM visitor_logs vl
        JOIN ip_dimensions d ON vl.ip_id = d.id
        LEFT JOIN resolved_nodes rn ON vl.server_name = rn.node_ip OR vl.server_name = rn.display_name
        WHERE ($1 = TRUE OR COALESCE(rn.display_name, vl.server_name) = ANY($2)) 
        AND vl.visit_time >= $3 AND ($4 = '' OR btrim(COALESCE(vl.target_domain, '')) !~* $4)
        GROUP BY d.ip_address, final_server_name, vl.target_domain, d.location, vl.language, d.lat, d.lon 
        ORDER BY MAX(vl.visit_time) DESC LIMIT 200
        "#
    ).bind(is_all).bind(&nodes).bind(cutoff).bind(hidden_domains).fetch_all(&mut *query_tx).await?;

    let history: Vec<HistoryRow> = sqlx::query_as(
        r#"
        WITH resolved_nodes AS (SELECT node_ip, COALESCE(NULLIF(TRIM(custom_name), ''), node_ip) as display_name FROM api_nodes)
        SELECT d.lat, d.lon, d.location, COALESCE(rn.display_name, vl.server_name), d.ip_address, CAST(vl.visit_time AS TEXT), COALESCE(vl.target_domain, '-') 
        FROM visitor_logs vl
        JOIN ip_dimensions d ON vl.ip_id = d.id
        LEFT JOIN resolved_nodes rn ON vl.server_name = rn.node_ip OR vl.server_name = rn.display_name
        WHERE d.lat IS NOT NULL 
        AND ($1 = TRUE OR COALESCE(rn.display_name, vl.server_name) = ANY($2)) 
        AND vl.visit_time >= $3 AND ($4 = '' OR btrim(COALESCE(vl.target_domain, '')) !~* $4)
        ORDER BY vl.visit_time DESC LIMIT 2000
        "#
    ).bind(is_all).bind(&nodes).bind(cutoff).bind(hidden_domains).fetch_all(&mut *query_tx).await?;

    let hm_query = if days <= 0.05 {
        "WITH resolved_nodes AS (SELECT node_ip, COALESCE(NULLIF(TRIM(custom_name), ''), node_ip) as display_name FROM api_nodes) SELECT CAST(date_trunc('minute', vl.visit_time) AS TEXT) as ts, COUNT(*) as c FROM visitor_logs vl LEFT JOIN resolved_nodes rn ON vl.server_name = rn.node_ip OR vl.server_name = rn.display_name WHERE ($1 = TRUE OR COALESCE(rn.display_name, vl.server_name) = ANY($2)) AND vl.visit_time >= $3 AND ($4 = '' OR btrim(COALESCE(vl.target_domain, '')) !~* $4) GROUP BY date_trunc('minute', vl.visit_time) ORDER BY date_trunc('minute', vl.visit_time) ASC"
    } else if days <= 1.0 {
        "WITH resolved_nodes AS (SELECT node_ip, COALESCE(NULLIF(TRIM(custom_name), ''), node_ip) as display_name FROM api_nodes) SELECT CAST(date_trunc('hour', vl.visit_time) AS TEXT) as ts, COUNT(*) as c FROM visitor_logs vl LEFT JOIN resolved_nodes rn ON vl.server_name = rn.node_ip OR vl.server_name = rn.display_name WHERE ($1 = TRUE OR COALESCE(rn.display_name, vl.server_name) = ANY($2)) AND vl.visit_time >= $3 AND ($4 = '' OR btrim(COALESCE(vl.target_domain, '')) !~* $4) GROUP BY date_trunc('hour', vl.visit_time) ORDER BY date_trunc('hour', vl.visit_time) ASC"
    } else {
        "WITH resolved_nodes AS (SELECT node_ip, COALESCE(NULLIF(TRIM(custom_name), ''), node_ip) as display_name FROM api_nodes) SELECT CAST(date_trunc('day', vl.visit_time) AS TEXT) as ts, COUNT(*) as c FROM visitor_logs vl LEFT JOIN resolved_nodes rn ON vl.server_name = rn.node_ip OR vl.server_name = rn.display_name WHERE ($1 = TRUE OR COALESCE(rn.display_name, vl.server_name) = ANY($2)) AND vl.visit_time >= $3 AND ($4 = '' OR btrim(COALESCE(vl.target_domain, '')) !~* $4) GROUP BY date_trunc('day', vl.visit_time) ORDER BY date_trunc('day', vl.visit_time) ASC"
    };
    let heatmap: Vec<HeatmapRow> = sqlx::query_as(hm_query).bind(is_all).bind(&nodes).bind(cutoff).bind(hidden_domains).fetch_all(&mut *query_tx).await?;

    query_tx.commit().await?;
    Ok((stats, history, heatmap))
}

pub fn normalize_days(days: f64) -> f64 {
    if !days.is_finite() { 1.0 } else { days.clamp(0.0, 30.0) }
}

#[cfg(test)]
mod tests {
    use super::normalize_days;
    #[test]
    fn query_windows_are_finite_and_bounded() {
        assert_eq!(normalize_days(f64::INFINITY), 1.0);
        assert_eq!(normalize_days(f64::NAN), 1.0);
        assert_eq!(normalize_days(1e100), 30.0);
        assert_eq!(normalize_days(-1.0), 0.0);
        assert_eq!(normalize_days(7.0), 7.0);
    }
}

#[cfg(test)]
mod database_tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires a disposable NEXUS_TEST_DATABASE_URL"]
    async fn dashboard_query_preserves_nodes_and_restores_memory_settings() {
        let url = std::env::var("NEXUS_TEST_DATABASE_URL").unwrap();
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(1).connect(&url).await.unwrap();
        sqlx::raw_sql(r#"
            CREATE TEMP TABLE api_nodes (node_ip text, custom_name text);
            CREATE TEMP TABLE ip_dimensions (id integer, ip_address text, location text, lat double precision, lon double precision);
            CREATE TEMP TABLE visitor_logs (ip_id integer, server_name text, target_domain text, language text, visit_time timestamptz);
            INSERT INTO api_nodes VALUES ('192.0.2.10', 'Tokyo Edge');
            INSERT INTO ip_dimensions VALUES (1, '198.51.100.1', 'Shanghai', 31, 121), (2, '198.51.100.2', 'London', 51, 0);
            INSERT INTO visitor_logs VALUES (1, 'Direct Access', 'one.test', 'en', NOW()), (2, '192.0.2.10', 'two.test', 'en', NOW()), (2, '192.0.2.10', 'two.test', 'en', NOW());
            SET max_parallel_workers_per_gather = 2;
            SET work_mem = '8MB';
        "#).execute(&pool).await.unwrap();
        let (stats, history, heat) = fetch_dashboard_data(&pool, "All", 1.0, "").await.unwrap();
        assert_eq!(stats.len(), 2);
        assert!(stats.iter().any(|row| row.7 == "Tokyo Edge" && row.2 == 2));
        assert_eq!(history.len(), 3);
        assert_eq!(heat.iter().map(|row| row.1).sum::<i64>(), 3);
        let (filtered, _, _) = fetch_dashboard_data(&pool, "Tokyo Edge", 1.0, "").await.unwrap();
        assert_eq!(filtered.len(), 1);
        let parallel: String = sqlx::query_scalar("SHOW max_parallel_workers_per_gather").fetch_one(&pool).await.unwrap();
        let memory: String = sqlx::query_scalar("SHOW work_mem").fetch_one(&pool).await.unwrap();
        assert_eq!(parallel, "2");
        assert_eq!(memory, "8MB");
        pool.close().await;
    }
}
