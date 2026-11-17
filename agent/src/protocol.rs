use serde::{Deserialize, Serialize};
use std::net::IpAddr;

pub const MAX_BATCH_BYTES: usize = 512 * 1024;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct TrackItem {
    pub ip: String,
    pub domain: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NodeMetrics {
    pub rx_bytes_total: u64,
    pub tx_bytes_total: u64,
    pub rx_speed_bps: u64,
    pub tx_speed_bps: u64,
}

pub fn parse_line(
    line: &str,
    node_ip: &str,
) -> std::result::Result<Option<TrackItem>, &'static str> {
    // Prefer structured access logs before looking for the legacy marker: a URL
    // or User-Agent containing TRACK_L7 must not turn into a forged track event.
    let fields = parse_common(line).or_else(|| parse_haproxy_http(line));
    let (raw_ip, domain) = if let Some((ip, request)) = fields {
        (ip, request_host(request).unwrap_or_else(|| "-".into()))
    } else if let Some((prefix, payload)) = line.split_once("TRACK_L7|") {
        if prefix.contains('"') {
            return Ok(None);
        }
        let mut fields = payload.split('|');
        let raw_ip = fields.next().unwrap_or_default().trim();
        let raw_domain = fields.next().ok_or("missing domain")?.trim();
        let domain = if raw_domain.contains(['{', '}']) {
            raw_domain.replace(['{', '}'], "")
        } else {
            raw_domain.to_owned()
        };
        (
            raw_ip,
            if domain.is_empty() || domain == "-" {
                "未配置透传".into()
            } else {
                domain
            },
        )
    } else {
        return Ok(None);
    };
    if raw_ip.len() > 128 {
        return Err("IP exceeds 128 bytes");
    }
    let ip: IpAddr = raw_ip.parse().map_err(|_| "invalid IP")?;
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        _ => ip,
    };
    if is_restricted(ip) || node_ip.parse::<IpAddr>().ok() == Some(ip) {
        return Ok(None);
    }
    if domain.len() > 512 || domain.chars().any(char::is_control) {
        return Err("invalid/overlong domain");
    }
    Ok(Some(TrackItem {
        ip: ip.to_string(),
        domain,
    }))
}

fn parse_common(line: &str) -> Option<(&str, &str)> {
    let (prefix, rest) = line.split_once(" [")?;
    let mut prefix = prefix.split_whitespace();
    let ip = prefix.next()?.trim_matches('"');
    if prefix.next()? != "-" {
        return None;
    }
    prefix.next()?;
    if prefix.next().is_some() || ip.parse::<IpAddr>().is_err() {
        return None;
    }
    let (date, rest) = rest.split_once("] \"")?;
    if !date.as_bytes().first()?.is_ascii_digit() || !date.contains('/') {
        return None;
    }
    let (request, rest) = rest.split_once('"')?;
    let mut fields = rest.split_whitespace();
    let status = fields.next()?.parse::<u16>().ok()?;
    if !(100..=599).contains(&status) {
        return None;
    }
    let bytes = fields.next()?;
    if bytes != "-" && bytes.parse::<u64>().is_err() {
        return None;
    }
    if !valid_request(request) {
        return None;
    }
    Some((ip, request))
}

fn parse_haproxy_http(line: &str) -> Option<(&str, &str)> {
    let (prefix, rest) = line.split_once(" [")?;
    let peer = prefix.split_whitespace().last()?;
    let (ip, port) = peer.rsplit_once(':')?;
    port.parse::<u16>().ok()?;
    let ip = ip.trim_matches(['[', ']']);
    ip.parse::<IpAddr>().ok()?;
    let (date, fields) = rest.split_once("] ")?;
    if !date.as_bytes().first()?.is_ascii_digit() || !date.contains('/') {
        return None;
    }
    let mut words = fields.split_whitespace();
    words.next()?; // frontend
    if !words.next()?.contains('/') {
        return None;
    }
    let timers = words.next()?;
    if timers.split('/').count() != 5
        || !timers
            .bytes()
            .all(|c| c.is_ascii_digit() || b"/+-".contains(&c))
    {
        return None;
    }
    if !(100..=599).contains(&words.next()?.parse::<u16>().ok()?) {
        return None;
    }
    let quoted = fields.trim_end().strip_suffix('"')?;
    let (_, request) = quoted.rsplit_once('"')?;
    if !valid_request(request) {
        return None;
    }
    Some((ip, request))
}

fn valid_request(request: &str) -> bool {
    let mut parts = request.split_whitespace();
    matches!((parts.next(),parts.next(),parts.next(),parts.next()),
        (Some(method),Some(_),Some(version),None) if !method.is_empty() && method.bytes().all(|b|b.is_ascii_uppercase()) && version.starts_with("HTTP/"))
}

fn request_host(request: &str) -> Option<String> {
    let target = request.split_whitespace().nth(1)?;
    if !target.starts_with("http://") && !target.starts_with("https://") {
        return None;
    }
    reqwest::Url::parse(target)
        .ok()?
        .host_str()
        .map(str::to_owned)
}

fn is_restricted(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_unspecified()
                || ip.octets()[0] == 0
                || ip.octets()[0] >= 224
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_access_formats_do_not_invent_host_or_trust_referrer() {
        let nginx = r#"8.8.8.8 - - [17/Nov/2026:12:00:00 +0800] "GET /index.html HTTP/1.1" 200 123 "https://referrer.example/" "TRACK_L7|9.9.9.9|forged.example""#;
        let item = parse_line(nginx, "1.1.1.1").unwrap().unwrap();
        assert_eq!(item.ip, "8.8.8.8");
        assert_eq!(item.domain, "-");
        let common = r#"8.8.4.4 - user [17/Nov/2026:12:00:00 +0800] "GET http://actual.example/path HTTP/1.1" 200 123"#;
        assert_eq!(
            parse_line(common, "1.1.1.1").unwrap().unwrap().domain,
            "actual.example"
        );
        let haproxy = r#"Nov 17 12:00:00 node haproxy[42]: 9.9.9.9:12345 [17/Nov/2026:12:00:00.000] frontend backend/srv 0/0/1/2/3 200 123 - - ---- 1/1/1/1/0 0/0 {arbitrary-captured-header} {} "GET / HTTP/1.1""#;
        let item = parse_line(haproxy, "1.1.1.1").unwrap().unwrap();
        assert_eq!(item.ip, "9.9.9.9");
        assert_eq!(item.domain, "-");
        assert!(
            parse_line("2026/11/17 [error] upstream connect failed", "1.1.1.1")
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn validates_fields_and_normalizes_ips() {
        for ip in [
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:192.168.1.2",
            "169.254.169.254",
            "224.0.0.1",
        ] {
            assert!(
                parse_line(&format!("TRACK_L7|{ip}|x"), "1.1.1.1")
                    .unwrap()
                    .is_none()
            );
        }
        assert!(parse_line("TRACK_L7|not-an-ip|x", "1.1.1.1").is_err());
        assert!(parse_line(&format!("TRACK_L7|8.8.8.8|{}", "x".repeat(513)), "1.1.1.1").is_err());
        assert!(parse_line(&format!("TRACK_L7|8.8.8.8|{}", "中".repeat(171)), "1.1.1.1").is_err());
        let item = parse_line("prefix TRACK_L7|::ffff:8.8.8.8|{example.com}", "1.1.1.1")
            .unwrap()
            .unwrap();
        assert_eq!(
            item,
            TrackItem {
                ip: "8.8.8.8".into(),
                domain: "example.com".into()
            }
        );
    }
    #[test]
    fn wire_format_matches_32_models() {
        #[derive(Deserialize)]
        struct ServerTrack {
            ip: String,
            domain: String,
        }
        #[derive(Deserialize)]
        struct ServerMetrics {
            rx_bytes_total: u64,
            tx_bytes_total: u64,
            rx_speed_bps: u64,
            tx_speed_bps: u64,
        }
        let bytes = rmp_serde::to_vec_named(&vec![TrackItem {
            ip: "8.8.8.8".into(),
            domain: "example.com".into(),
        }])
        .unwrap();
        let decoded: Vec<ServerTrack> = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(
            (&*decoded[0].ip, &*decoded[0].domain),
            ("8.8.8.8", "example.com")
        );
        let bytes = rmp_serde::to_vec_named(&NodeMetrics {
            rx_bytes_total: 10,
            tx_bytes_total: 20,
            rx_speed_bps: 3,
            tx_speed_bps: 4,
        })
        .unwrap();
        let m: ServerMetrics = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(
            (
                m.rx_bytes_total,
                m.tx_bytes_total,
                m.rx_speed_bps,
                m.tx_speed_bps
            ),
            (10, 20, 3, 4)
        );
    }
}
