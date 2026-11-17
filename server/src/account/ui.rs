use super::*;
use askama::Template;
use std::sync::OnceLock;
struct Assets {
    css: String,
    js: String,
}
static ASSETS: OnceLock<Assets> = OnceLock::new();
pub fn load() -> std::io::Result<()> {
    if ASSETS.get().is_some() {
        return Ok(());
    }
    let dir = std::env::var_os("FRONTEND_ASSET_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "templates/assets".into());
    let _ = ASSETS.set(Assets {
        css: std::fs::read_to_string(dir.join("account.css"))?,
        js: std::fs::read_to_string(dir.join("users.js"))?,
    });
    Ok(())
}
#[derive(Template)]
#[template(path = "login.html")]
struct Login<'a> {
    css: &'a str,
    path: &'a str,
    error: &'a str,
    csrf: &'a str,
    google: bool,
    site_key: &'a str,
}
pub fn login_html(config: &AuthConfig, error: Option<&str>, csrf: &str) -> String {
    let message = match error {
        Some("pending") => "Google 身份已验证，账号正在等待管理员开通。",
        Some("disabled") => "此账号已停用，请联系管理员。",
        Some("provider") => "身份服务暂时不可用，请稍后重试或使用本地账号。",
        Some("unconfigured") => "管理员尚未配置 Google 登录。",
        Some("ratelimit") => "尝试次数过多，请在 15 分钟后重试。",
        Some("csrf") => "登录页面已过期，请重新提交。",
        Some("cancelled") => "已取消 Google 登录。",
        Some("captcha") => "人机验证未通过，请重试。",
        Some(_) => "无法完成登录，请核对账号或重试。",
        None => "",
    };
    let assets = ASSETS.get().expect("account assets loaded");
    Login {
        css: &assets.css,
        path: &config.admin_path,
        error: message,
        csrf,
        google: config.client_id.is_some(),
        site_key: &std::env::var("CF_TURNSTILE_SITE_KEY").unwrap_or_default(),
    }
    .render()
    .unwrap()
}
#[derive(Template)]
#[template(path = "users.html")]
struct Users<'a> {
    css: &'a str,
    js: &'a str,
    path: &'a str,
    name: &'a str,
    admin: bool,
    google: bool,
    local: bool,
}
pub async fn users_page(
    crate::extractors::auth::AdminAuthPage(user): crate::extractors::auth::AdminAuthPage,
    State(state): State<AppState>,
) -> Response {
    let assets = ASSETS.get().unwrap();
    let html = Users {
        css: &assets.css,
        js: &assets.js,
        path: &state.auth.admin_path,
        name: &user.display_name,
        admin: user.role == "admin",
        google: state.auth.client_id.is_some(),
        local: user.username.is_some(),
    }
    .render()
    .unwrap();
    page_response(html, &state.auth, &user)
}
// All generated routes use a fixed marker rather than rewriting user data or external URLs.
pub fn paths(html: String, path: &str) -> String {
    html.replace("__ADMIN_BASE__", path)
}
pub fn response(html: String, config: &AuthConfig, user: &Principal) -> Response {
    let data=serde_json::json!({"base":config.admin_path,"csrf":user.csrf_token,"role":user.role,"id":user.id}).to_string().replace('<',"\\u003c").replace('>',"\\u003e").replace('&',"\\u0026");
    let script = format!(
        r#"<script>window.Account={data};(()=>{{const native=window.fetch;window.fetch=function(input,options){{const url=new URL(input instanceof Request?input.url:String(input),location.href),method=(options?.method||(input instanceof Request?input.method:'GET')).toUpperCase();if(url.origin===location.origin&&(url.pathname===Account.base||url.pathname.startsWith(Account.base+'/'))&&!['GET','HEAD','OPTIONS'].includes(method)){{const headers=new Headers(input instanceof Request?input.headers:undefined);new Headers(options?.headers).forEach((v,k)=>headers.set(k,v));headers.set('X-CSRF-Token',Account.csrf);options={{...options,headers}};}}return native.call(this,input,options);}};document.addEventListener('submit',e=>{{const form=e.target;if(form.method.toLowerCase()!=='post')return;const url=new URL(form.action,location.href);if(url.origin!==location.origin||!url.pathname.startsWith(Account.base+'/'))return;let input=form.querySelector('input[name=_csrf]');if(!input){{input=document.createElement('input');input.type='hidden';input.name='_csrf';form.appendChild(input);}}input.value=Account.csrf;}},true);}})();</script>"#
    );
    let mut html =
        paths(html, &config.admin_path).replacen("</head>", &format!("{script}</head>"), 1);
    if user.role != "admin" {
        html=html.replacen("</head>","<style>[data-admin-only],#settings-modal .tab-btn:not([onclick*=account]),#settings-modal .tab-content:not(#account){display:none!important}</style></head>",1);
    }
    (
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "same-origin"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CONTENT_SECURITY_POLICY, "frame-ancestors 'none'"),
        ],
        axum::response::Html(html),
    )
        .into_response()
}
