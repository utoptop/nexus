pub mod styles;
pub mod effects;
pub mod mobile; 

use axum::{
    extract::{Form, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use askama::Template;

use crate::{AppState, ServerLocation};
use crate::extractors::auth::AdminOnly;
use styles::MAP_BUBBLE_CSS;
use effects::TRAJECTORY_JS;

// Frontend resources are loaded once per process, outside the Rust build graph.
// Docker can replace them without recompiling either architecture's binary.
struct FrontendAssets {
    runtime: String, controller: String, routes: String, layout: String, coastline: String, nodes: String, overview: String, stream: String,
}
static FRONTEND_ASSETS: std::sync::OnceLock<FrontendAssets> = std::sync::OnceLock::new();
pub fn load_frontend_assets(dir: &std::path::Path) -> std::io::Result<()> {
    if FRONTEND_ASSETS.get().is_some() { return Ok(()); }
    let read = |name: &str| std::fs::read_to_string(dir.join(name))
        .map_err(|e| std::io::Error::new(e.kind(), format!("frontend asset {}: {e}", dir.join(name).display())));
    let assets = FrontendAssets {
        runtime: read("traffic-runtime.js")?, controller: read("dashboard-controller.js")?,
        routes: read("trajectory.js")?, layout: read("layout.css")?, coastline: read("coastline.js")?, nodes: read("node-layout.js")?, overview: read("overview.js")?, stream: read("node-stream.js")?,
    };
    let _ = FRONTEND_ASSETS.set(assets);
    Ok(())
}

#[derive(Deserialize)]
pub struct VisualSettingsParams {
    pub dyn_bright: f64,
    pub res_bright: f64,
    pub res_time: f64,
    pub anim_speed: f64,
    pub init_speed: f64,
    pub init_thick: f64,
    pub res_thick: f64,
    pub dash_length: f64,
    pub dash_gap: f64,
}

#[derive(Template)]
#[template(path = "visitor.html")]
struct VisitorTemplate<'a> {
    t: &'a str, 
    w: &'a str, 
    c: &'a str, 
    s: &'a str, 
    ip: &'a str,
    loc: &'a str, 
}

#[derive(Template)]
#[template(path = "desktop.html")]
#[allow(dead_code)]
struct AdminTemplate<'a> {
    t_title: &'a str, t_freq: &'a str, t_playback: &'a str, t_geo_off: &'a str, t_ip_off: &'a str,
    t_track_off: &'a str, t_data: &'a str, t_settings: &'a str, t_logout: &'a str, t_fullscreen: &'a str,
    t_opacity: &'a str, t_node: &'a str, t_ip: &'a str, t_loc: &'a str, t_hits: &'a str, t_lang: &'a str,
    t_time: &'a str, t_net: &'a str, t_realtime: &'a str, t_visuals: &'a str, t_visuals_desc: &'a str,
    t_dyn_bright: &'a str, t_res_bright: &'a str, t_res_time: &'a str, t_init_speed: &'a str,
    t_anim_speed: &'a str, t_init_thick: &'a str, t_res_thick: &'a str, t_reset_visuals: &'a str,
    t_dash_length: &'a str, t_dash_gap: &'a str, t_warn_node: &'a str,
    t_time_sort: &'a str, t_freq_sort: &'a str, t_apply: &'a str,
    t_hist_path_on: &'a str, t_fog_off: &'a str,
    
    // 🚀 新增：节点网络控制菜单按钮文本
    t_network: &'a str,
    lang: &'a str,
    
    mobile_css: String, mobile_js: String, mobile_overlay: String,
    mobile_controls: String, mobile_fab: String,
    map_bubble_css: &'a str, trajectory_js: &'a str,
    runtime_js: &'a str, controller_js: &'a str, route_js: &'a str, layout_css: &'a str, coastline_js: &'a str, node_layout_js: &'a str, overview_js: &'a str, stream_js: &'a str,
    cb_html: String, key_rows: String, node_rows: String,
    
    selected_node: &'a str, sel_count: String, stats_json: String, history_json: String,
    hm_json: String, nodes_map_json: String, ip_to_name_json: String, is_zh_bool: &'static str,
    
    // 🚀 新增：将数据库中各节点的配额和已用流量打包成 JSON 传给前端
    node_quota_json: String,
    
    // 🗺️ 地图底图配置 (CARTO Basemap Key / 自定义瓦片 URL)
    map_api_key: String,
    map_tile_url: String,
    nexus_domains_json: String,

    lat: f64, lon: f64, city: &'a str, dyn_bright: f64, res_bright: f64,
    res_time: f64, anim_speed: f64, init_speed: f64, init_thick: f64,
    res_thick: f64, dash_length: f64, dash_gap: f64,
}

pub async fn update_visuals_handler(_auth: AdminOnly, State(state): State<AppState>, Form(params): Form<VisualSettingsParams>) -> Response {
    let _ = sqlx::query("UPDATE admin_settings SET dyn_bright = $1, res_bright = $2, res_time = $3, anim_speed = $4, init_speed = $5, init_thick = $6, res_thick = $7, dash_length = $8, dash_gap = $9 WHERE id = 1")
        .bind(params.dyn_bright).bind(params.res_bright).bind(params.res_time).bind(params.anim_speed).bind(params.init_speed).bind(params.init_thick).bind(params.res_thick).bind(params.dash_length).bind(params.dash_gap)
        .execute(&state.db).await;
    StatusCode::OK.into_response()
}

pub fn generate_visitor_ui(ip: &str, loc: &str, is_zh: bool) -> String {
    let (t, w, c, s) = if is_zh { ("安全验证", "安全终端", "识别中...", "已归档") } else { ("Identity", "Terminal", "Identifying...", "LOGGED") };
    VisitorTemplate { t, w, c, s, ip, loc }.render().unwrap()
}

#[allow(clippy::too_many_arguments)]
#[allow(clippy::type_complexity)]
pub fn generate_admin_ui(
    selected_node: &str, active_servers: Vec<String>,
    stats: Vec<(String, String, i64, String, String, Option<f64>, Option<f64>, String, String)>,
    history: Vec<(f64, f64, String, String, String, String, String)>,
    heatmap: Vec<(String, i64)>, keys: Vec<(String, String)>,
    nodes: Vec<(String, String, Option<String>, String, Option<f64>, Option<f64>)>,
    nodes_map_json: String, server: &ServerLocation, is_zh: bool,
    t_hist_path_on: &str, t_fog_off: &str, dyn_bright: f64, res_bright: f64,
    res_time: f64, anim_speed: f64, init_speed: f64, init_thick: f64,
    res_thick: f64, dash_length: f64, dash_gap: f64, t_dash_length: &str, t_dash_gap: &str,
    node_quota_json: String, // 🚀 新增参数
    map_api_key: String,
    map_tile_url: String,
    nexus_domains: Vec<String>,
) -> String {
    let t_title = if is_zh { "NEXUS · 实时节点监测" } else { "NEXUS · Live Node Monitor" };
    let t_freq = if is_zh { "🔥 高频服务" } else { "🔥 High Freq Services" };
    let t_playback = if is_zh { "▶️ 轨迹回放" } else { "▶️ Playback" };
    let t_geo_off = if is_zh { "🌍 区域热力: 关" } else { "🌍 Geo Heatmap: Off" };
    let t_ip_off = if is_zh { "🏷️ 访客 IP: 关" } else { "🏷️ Visitor IP: Off" };
    let t_track_off = if is_zh { "🔓 地图: 手动" } else { "🔓 Map: Manual" };

    // 🚀 新增：节点网络监控按钮文本
    let t_network = if is_zh { "📶 节点网络" } else { "📶 Node Network" };

    let t_data = if is_zh { "☰ 数据面板" } else { "☰ Data Panel" };
    let t_settings = if is_zh { "⚙️ 接入管理" } else { "⚙️ Settings" };
    let t_logout = if is_zh { "🚪 退出" } else { "🚪 Logout" };
    let t_fullscreen = if is_zh { "⛶ 全屏" } else { "⛶ Fullscreen" };
    let t_opacity = if is_zh { "🎛️ 透明度" } else { "🎛️ Opacity" };
    let t_all_nodes = if is_zh { "🌍 全部节点汇总" } else { "🌍 All Nodes" };
    let t_node = if is_zh { "接入节点" } else { "Node" };
    let t_ip = if is_zh { "访客 IP" } else { "Visitor IP" };
    let t_loc = if is_zh { "位置" } else { "Location" };
    let t_hits = if is_zh { "次数" } else { "Hits" };
    let t_lang = if is_zh { "语言" } else { "Lang" };
    let t_time = if is_zh { "活跃时间" } else { "Active Time" };
    let t_net = if is_zh { "🌐 矩阵节点网络" } else { "🌐 Matrix Node Network" };
    let t_global = if is_zh { "全局" } else { "Global" };
    let t_realtime = if is_zh { "⚡ 实时轨迹" } else { "⚡ Real-time" };
    let t_dyn_bright = if is_zh { "动态亮度 (爆发状态)" } else { "Dynamic Brightness (Burst)" };
    let t_res_bright = if is_zh { "残留亮度 (冷却状态)" } else { "Residual Brightness (Cooling)" };
    let t_res_time = if is_zh { "残留时间 (消散时长)" } else { "Residual Time (Fade Duration)" };
    let t_init_speed = if is_zh { "访问流光速度" } else { "Access Flow Speed" };
    let t_anim_speed = if is_zh { "冷却流光速度" } else { "Cooling Flow Speed" };
    let t_init_thick = if is_zh { "初始流粗细 (爆发时线条宽度)" } else { "Initial Thickness (Burst)" };
    let t_res_thick = if is_zh { "冷却流粗细 (消散时线条宽度)" } else { "Residual Thickness (Cooling)" };
    let t_reset_visuals = if is_zh { "🔄 重置为默认" } else { "🔄 Reset to Default" };
    let t_visuals_desc = if is_zh { "动态虚线从访客流向真实节点，每次访问触发柔和亮闪，冷却后恢复细暗底线。节点辉光、访客光圈随实时访问量联动，参数实时生效并自动保存。" } else { "Glowing dashes flow from the visitor to the true node. Each access adds a soft flash that fades to a quiet carrier. Node glow and visitor ripples respond to live traffic. Settings apply live and auto-save." };
    let t_visuals = if is_zh { "🎨 视觉控制" } else { "🎨 Visuals" };
    let t_warn_node = if is_zh { "若节点被降维掉入非洲海面 (0,0)，请填入服务器公网 IP 修正！" } else { "If node falls into ocean (0,0), insert its real Public IP below to fix geo-location!" };
    
    let mobile_css = mobile::get_mobile_css();
    let mobile_js = mobile::get_mobile_js();
    let mobile_overlay = mobile::get_mobile_overlay();
    let mobile_fab = mobile::render_mobile_fab();
    
    let mobile_controls = mobile::render_mobile_controls();

    let selected_arr: Vec<&str> = selected_node.split(',').collect();
    let is_all = selected_arr.contains(&"All");
    let sel_count = if is_all { t_global.to_string() } else { format!("{} {}", if is_zh {"已选"} else {"Selected"}, selected_arr.len()) };
    
    let mut cb_html = String::new();
    cb_html.push_str(&format!("<label><input type='checkbox' value='All' class='cb-all' onchange='toggleAll(this)' {}><span> {}</span></label><hr style='border-color:#334155;margin:8px 0;'>", if is_all { "checked" } else { "" }, t_all_nodes));
    
    for s in active_servers {
        let checked = if selected_arr.contains(&s.as_str()) { "checked" } else { "" };
        cb_html.push_str(&format!("<label><input type='checkbox' class='node-cb' value='{}' {} onchange='updateAllCb()'><span> 📌 {}</span></label>", s, checked, s));
    }

    let mut key_rows = String::new();
    for k in keys { key_rows.push_str(&format!("<tr><td><code>{}</code></td><td class='utc' data-u='{}'>{}</td><td><form method='POST' action='__ADMIN_BASE__/api_keys/delete?token={}' style='margin:0;' onsubmit='return confirm(\"{}?\");'><button class='danger-btn'>{}</button></form></td></tr>", k.0, k.1, k.1, k.0, if is_zh {"确定删除此密钥吗"} else {"Delete this key"}, if is_zh {"吊销"} else {"Revoke"})); }

    let mut node_rows = String::new();
    
    let mut ip_to_name = std::collections::HashMap::new();
    ip_to_name.insert("Direct Access".to_string(), "Direct Access".to_string());
    ip_to_name.insert("-".to_string(), "Direct Access".to_string());
    
    for n in &nodes {
        let custom_name = n.2.as_ref().filter(|s| !s.trim().is_empty()).unwrap_or(&n.0).clone();
        ip_to_name.insert(n.0.clone(), custom_name.clone());
        ip_to_name.insert(custom_name.clone(), custom_name.clone());
    }
    let ip_to_name_json = serde_json::to_string(&ip_to_name).unwrap();
    
    for n in nodes {
        let custom_name = n.2.as_ref().filter(|s| !s.trim().is_empty()).unwrap_or(&n.0).clone();
        let display_name = if n.2.as_ref().is_none_or(|s| s.trim().is_empty()) { if is_zh {"未命名自动节点".to_string()} else {"Unnamed Auto Node".to_string()} } else { custom_name.clone() };
        let safe_ip_id = n.0.replace(|c: char| !c.is_ascii_alphanumeric(), "-");
        let safe_old_name = custom_name.replace("'", "\\'"); 
        
        node_rows.push_str(&format!(
            "<tr id='row-{}'><td><code>{}</code></td><td>{}</td><td><span id='display-name-{}' style='color:#4ade80;font-weight:bold;'>{}</span></td>
                <td><div style='display:flex;gap:5px;flex-wrap:wrap;'>
                <input type='text' id='name-{}' value='{}' placeholder='{}' style='width:100px;'>
                <input type='text' id='locip-{}' placeholder='{}' title='{}' style='width:150px;'>
                <button type='button' id='btn-{}' class='primary-btn' style='padding:4px 8px;' onclick='renameNode(\"{}\", \"{}\", \"{}\", event)'>{}</button>
                <button type='button' class='danger-btn' style='padding:4px 8px;' onclick='deleteNode(\"{}\", \"{}\", this, event)'>{}</button></div></td><td class='utc' data-u='{}'>{}</td></tr>", 
            safe_ip_id, n.0, n.1, safe_ip_id, display_name, safe_ip_id, 
            if n.2.as_ref().is_none_or(|s| s.trim().is_empty()) { "" } else { &custom_name },
            if is_zh {"重命名"} else {"Rename"}, safe_ip_id, if is_zh {"填真实公网IP定点"} else {"Real Public IP"}, if is_zh {"若坐标处于内网0,0，填入公网IP纠偏"} else {"Fix 0,0 by inserting real IP"}, safe_ip_id, n.0, safe_ip_id, safe_old_name, if is_zh {"修改并定位"} else {"Save & Locate"}, n.0, safe_old_name, if is_zh {"移除"} else {"Remove"}, n.3, n.3
        ));
    }

    let assets = FRONTEND_ASSETS.get().expect("frontend assets loaded");
    let html=AdminTemplate {
        t_title, t_freq, t_playback, t_geo_off, t_ip_off, t_track_off, t_data, t_settings, t_logout, t_fullscreen,
        t_opacity, t_node, t_ip, t_loc, t_hits, t_lang, t_time, t_net, t_realtime, t_visuals, t_visuals_desc,
        t_dyn_bright, t_res_bright, t_res_time, t_init_speed, t_anim_speed, t_init_thick, t_res_thick, t_reset_visuals,
        t_dash_length, t_dash_gap, t_warn_node, t_time_sort: if is_zh {"按最新访问排序"} else {"Sort by Newest"},
        t_freq_sort: if is_zh {"按高频次数排序"} else {"Sort by Highest Freq"}, t_apply: if is_zh {"确定应用"} else {"Apply"},
        t_hist_path_on, t_fog_off, t_network, // 🚀 传入 t_network
        lang: if is_zh { "zh" } else { "en" },
        mobile_css, mobile_js, mobile_overlay, mobile_controls, mobile_fab,
        runtime_js: &assets.runtime,
        controller_js: &assets.controller,
        route_js: &assets.routes,
        layout_css: &assets.layout, coastline_js: &assets.coastline, node_layout_js: &assets.nodes, overview_js: &assets.overview, stream_js: &assets.stream,
        map_bubble_css: MAP_BUBBLE_CSS, trajectory_js: TRAJECTORY_JS, cb_html, key_rows, node_rows, selected_node,
        sel_count, stats_json: serde_json::to_string(&stats).unwrap(), history_json: serde_json::to_string(&history).unwrap(),
        hm_json: serde_json::to_string(&heatmap).unwrap(), nodes_map_json, ip_to_name_json, is_zh_bool: if is_zh { "true" } else { "false" },
        node_quota_json, // 🚀 传入 node_quota_json
        map_api_key, map_tile_url, nexus_domains_json: serde_json::to_string(&nexus_domains).unwrap(),
        lat: server.lat, lon: server.lon, city: &server.city, dyn_bright, res_bright, res_time, anim_speed,
        init_speed, init_thick, res_thick, dash_length, dash_gap,
    }.render().unwrap();
    html
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_dashboard_fixture() {
        load_frontend_assets(std::path::Path::new("templates/assets")).unwrap();
        let places = [(31.23,121.47,"中国 · 上海"),(35.68,139.69,"日本 · 东京"),(1.35,103.82,"新加坡"),(37.77,-122.42,"美国 · 旧金山"),(51.51,-0.13,"英国 · 伦敦"),(48.86,2.35,"法国 · 巴黎"),(-33.87,151.21,"澳大利亚 · 悉尼")];
        let mut stats = Vec::new();
        let mut history = Vec::new();
        for i in 0..200 {
            let (lat, lon, loc) = places[i % places.len()];
            let ip = format!("203.0.113.{}", i + 1);
            let time = (chrono::Utc::now() - chrono::Duration::seconds(i as i64 * 30)).to_rfc3339();
            let node = if i % 2 == 0 { "Direct Access" } else { "Tokyo Edge" };
            stats.push((ip.clone(), loc.to_string(), (i % 40 + 1) as i64, time.clone(), "zh".to_string(), Some(lat), Some(lon), node.to_string(), "api.example.test".to_string()));
            history.push((lat, lon, loc.to_string(), node.to_string(), ip, time, "api.example.test".to_string()));
        }
        let html = generate_admin_ui("All", vec!["Direct Access".into(), "Tokyo Edge".into()], stats, history,
            vec![(chrono::Utc::now().to_rfc3339(), 420)], vec![], vec![],
            r#"{"Direct Access":[1.35,103.82],"Tokyo Edge":[35.68,139.69]}"#.into(),
            &ServerLocation { lat:1.35, lon:103.82, city:"Singapore".into() }, true,
            "历史连线: 开", "迷雾热力: 关", 4.0, 3.5, 3.0, 0.5, 0.1, 1.5, 0.5, 20.0, 60.0, "长度", "间距",
            "{}".into(), String::new(), "https://tile.openstreetmap.org/{z}/{x}/{y}.png".into(), vec!["logger.example.test".into(), "proxy.example.test".into()]);
        let html = crate::account::paths_html(html, "/admin");
        assert!(html.contains("createTrajectoryLayer"));
        assert!(html.contains("NEXUS"));
        assert!(!html.contains("OBSERVATORY"));
        assert_eq!(html.matches("</html>").count(), 1);
        if let Ok(path) = std::env::var("DASHBOARD_FIXTURE_PATH") { std::fs::write(path, html).unwrap(); }
    }
}
