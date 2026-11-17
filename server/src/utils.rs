use crate::models::{IpLookupMode, HttpApiGeoResponse};
use std::net::IpAddr;
use moka::future::Cache;
use arc_swap::ArcSwap;

pub fn is_private_or_restricted(addr: &IpAddr) -> bool {
    match addr {
        IpAddr::V4(ipv4) => {
            ipv4.is_loopback()
            || ipv4.is_private()
            || ipv4.is_link_local()
            || ipv4.is_broadcast()
            || ipv4.is_unspecified()
            || ipv4.octets()[0] == 0
            || ipv4.octets()[0] >= 224
        }
        IpAddr::V6(ipv6) => {
            ipv6.is_loopback()
            || ipv6.is_unspecified()
            || (ipv6.segments()[0] & 0xfe00) == 0xfc00
            || (ipv6.segments()[0] & 0xffc0) == 0xfe80
            || ipv6.is_multicast()
            || if let Some(ipv4) = ipv6.to_ipv4_mapped() {
                is_private_or_restricted(&IpAddr::V4(ipv4))
            } else {
                false
            }
        }
    }
}

pub fn parse_ips(xff: &str, direct_ip: &str) -> (String, String) {
    let mut v4 = None; let mut v6 = None; let mut primary = None;
    let mut all_ips: Vec<&str> = xff.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if all_ips.is_empty() { all_ips.push(direct_ip); }
    for ip in &all_ips {
        if primary.is_none() { primary = Some(ip.to_string()); }
        if ip.contains('.') && v4.is_none() { v4 = Some(ip.to_string()); }
        if ip.contains(':') && v6.is_none() { v6 = Some(ip.to_string()); }
    }
    let display_ip = match (v4, v6) {
        (Some(v4_str), Some(v6_str)) => format!("{}<br><span style='color:#94a3b8;font-size:10px;'>v4: {}</span>", v6_str, v4_str),
        (Some(v4_str), None) => v4_str, (None, Some(v6_str)) => v6_str, (None, None) => direct_ip.to_string(),
    };
    (primary.unwrap_or_else(|| direct_ip.to_string()), display_ip)
}

pub async fn fetch_geo(ip: &str, client: &reqwest::Client, geo_db: &ArcSwap<Option<maxminddb::Reader<Vec<u8>>>>, ip_mode: &ArcSwap<IpLookupMode>) -> (String, Option<f64>, Option<f64>) {
    let mut target_ip = ip.trim().to_string();
    
    if (target_ip.is_empty() || target_ip == "Direct Access" || target_ip == "-")
        && let Ok(resp) = client.get("https://api64.ipify.org").send().await 
            && let Ok(text) = resp.text().await { target_ip = text.trim().to_string(); }
    
    if target_ip.is_empty() { 
        return ("Private/Local".into(), Some(0.0), Some(0.0)); 
    }

    let ip_addr: IpAddr = match target_ip.parse() {
        Ok(addr) => addr,
        Err(_) => {
            if let Ok(mut iter) = tokio::net::lookup_host(format!("{}:80", target_ip)).await {
                if let Some(socket_addr) = iter.next() {
                    target_ip = socket_addr.ip().to_string();
                    socket_addr.ip()
                } else {
                    return ("Invalid Domain".into(), Some(0.0), Some(0.0));
                }
            } else {
                return ("Invalid Domain".into(), Some(0.0), Some(0.0));
            }
        }
    };

    // 强化 SSRF 防御：阻止任何内网/私有/云服务元数据/回环地址外联
    if is_private_or_restricted(&ip_addr) {
        return ("Private/Local".into(), Some(0.0), Some(0.0));
    }

    let current_mode = **ip_mode.load();
    let geo_guard = geo_db.load();
    let mut use_api = current_mode == IpLookupMode::HttpApi;

    if current_mode == IpLookupMode::LocalDb {
        if let Some(reader) = &**geo_guard {
            if let Ok(city_data) = reader.lookup::<maxminddb::geoip2::City>(ip_addr) {
                let get_name = |names: Option<&std::collections::BTreeMap<&str, &str>>| -> String {
                    names.and_then(|n| n.get("zh-CN").or_else(|| n.get("en"))).map(|s| s.to_string()).unwrap_or_default()
                };
                let country_name = get_name(city_data.country.as_ref().and_then(|c| c.names.as_ref()));
                let city_name = get_name(city_data.city.as_ref().and_then(|c| c.names.as_ref()));
                let mut loc = format!("{}·{}", country_name, city_name);
                if loc == "·" { loc = "Unknown".to_string(); }
                let lat = city_data.location.as_ref().and_then(|l| l.latitude).unwrap_or(0.0);
                let lon = city_data.location.as_ref().and_then(|l| l.longitude).unwrap_or(0.0);
                return (loc, Some(lat), Some(lon));
            } else { return ("Unknown (Not Found)".into(), Some(0.0), Some(0.0)); }
        } else { use_api = true; }
    }

    if use_api {
        let api_url = format!("http://ip-api.com/json/{}?fields=status,country,city,lat,lon", target_ip);
        if let Ok(resp) = client.get(&api_url).send().await
            && let Ok(data) = resp.json::<HttpApiGeoResponse>().await
                && data.status == "success" {
                    let loc = format!("{}·{}", data.country.unwrap_or_default(), data.city.unwrap_or_default());
                    return (loc, data.lat, data.lon);
                }
    }
    ("Unknown".into(), Some(0.0), Some(0.0))
}

pub async fn resolve_ip_id(ip: &str, db: &sqlx::PgPool, client: &reqwest::Client, cache: &Cache<String, (i32, String, f64, f64)>, geo_db: &ArcSwap<Option<maxminddb::Reader<Vec<u8>>>>, ip_mode: &ArcSwap<IpLookupMode>) -> (i32, String, f64, f64) {
    let target_ip = ip.trim().to_string();
    if let Some(cached) = cache.get(&target_ip).await { return cached; }

    if let Ok(row) = sqlx::query_as::<_, (i32, String, Option<f64>, Option<f64>)>("SELECT id, location, lat, lon FROM ip_dimensions WHERE ip_address = $1")
        .bind(&target_ip).fetch_one(db).await {
        let res = (row.0, row.1, row.2.unwrap_or(0.0), row.3.unwrap_or(0.0));
        cache.insert(target_ip.clone(), res.clone()).await; return res;
    }

    let (loc, lat, lon) = fetch_geo(&target_ip, client, geo_db, ip_mode).await;
    let final_lat = lat.unwrap_or(0.0); let final_lon = lon.unwrap_or(0.0);
    
    let id: i32 = sqlx::query_scalar(
        "INSERT INTO ip_dimensions (ip_address, location, lat, lon) VALUES ($1, $2, $3, $4) ON CONFLICT (ip_address) DO UPDATE SET location = EXCLUDED.location RETURNING id"
    ).bind(&target_ip).bind(&loc).bind(final_lat).bind(final_lon).fetch_one(db).await.unwrap_or(0);

    let res = (id, loc, final_lat, final_lon);
    cache.insert(target_ip, res.clone()).await;
    res
}
