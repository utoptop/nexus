# 账号、Google OIDC 与多域名

## 本地账号

新库使用 `config/nexus.toml` 的 `auth.initial_username` 和 `auth.initial_password` 初始化首个管理员，密码至少 12 字符。已有数据库会保留管理员，不通过初始化配置覆盖密码。后台支持管理员和观察者、账号启停、密码修改及会话撤销；观察者可以查看流量，不能管理节点、密钥或成员。

修改密码或撤销会话后需要重新登录。系统防止删除/禁用最后一位可用管理员。浏览器会话使用 HttpOnly、SameSite=Lax Cookie，配置 HTTPS 主入口后设置 Secure；从纯 HTTP 地址访问时，这种 Cookie 不会被发送。

## Cloudflare Turnstile 人机验证

Turnstile 保护本地账号密码登录，Google 登录继续使用 OIDC 身份验证、账号状态和成员审核。它不控制 DNS 小黄云代理，也不修改 Cloudflare WAF 规则；即使域名没有经过 Cloudflare 代理，也能使用 Turnstile。[Cloudflare 接入说明](https://developers.cloudflare.com/turnstile/get-started/)

在 Cloudflare 控制台创建 Turnstile 组件，将实际登录域名（包括备用入口）加入该组件允许的主机名。把同一组件的 Site Key 和 Secret Key 填入 `config/nexus.toml`，不要将 Cloudflare API Token 当作 Secret Key。

```toml
[turnstile]
enabled = true
site_key = "你的SiteKey"
secret_key = "你的SecretKey"
timeout_seconds = 10
```

关闭时只需改 `enabled = false`，可保留密钥供下次开启。配置关闭后页面不加载 Cloudflare 脚本、不显示验证组件，后端不调用验证接口。开启时两把密钥缺一不可，否则启动失败；Secret Key 不会发送到页面。

```bash
docker compose run --rm --no-deps nexus --config /etc/nexus/nexus.toml --check-config
docker compose up -d --no-deps --no-build --force-recreate nexus
```

服务端必须通过 Siteverify 校验，不能只检查前端组件是否成功。Nexus 还检查 `action=login`；没有 token、失效/重复 token、异常响应和超时均拒绝本地登录。token 有效期为 300 秒，超时后应重新获取。[Cloudflare 服务端校验说明](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)

若显示“人机验证未通过”，检查组件域名、密钥配对、浏览器能否加载 `challenges.cloudflare.com`、服务器能否连接 Siteverify。需要临时停用时修改开关并重新创建容器，原有账号和会话数据不被删除。

## Google 登录

本地账号可独立使用。启用 Google 时：

1. 在 Google Cloud Console 创建或选择项目，在 Google Auth Platform 配置 Branding、Audience 与支持邮箱。
2. 创建类型为 Web application 的 OAuth Client。
3. 请求范围是 `openid email profile`。Testing 模式按 Google 配置加入测试用户；应用内的成员审核仍然独立。
4. 在 Authorized redirect URIs 中填写：`auth.public_base_url + auth.admin_path + /auth/oidc/callback`。
5. 将客户端 ID 和 Secret 写入 TOML 的 `[oidc]` 段并重新创建容器。

```toml
[auth]
public_base_url = "https://nexus.example.com"
admin_path = "/admin"

[oidc]
issuer_url = "https://accounts.google.com"
client_id = "你的客户端ID.apps.googleusercontent.com"
client_secret = "你的客户端Secret"
```

回调示例：`https://nexus.example.com/admin/auth/oidc/callback`。域名、协议、端口、路径和尾斜杠需与 Google 配置一致。服务端实现 Discovery、PKCE、state、nonce 和 ID token 校验。[Google OIDC 文档](https://developers.google.com/identity/openid-connect)

先以原本地管理员登录，再在我的账号中绑定 Google，可保留同一个管理员身份。直接使用未绑定的 Google 身份登录，会进入待管理员审核的流程；同邮箱不会自动合并账号，也不会自动获得管理员权限。

## 多域名与代理入口

```toml
[auth]
public_base_url = "https://origin.example.com"
allowed_origins = ["https://nexus.example.com", "https://monitor.example.com"]
```

`auth.public_base_url` 是主入口与 Google 回调地址，`auth.allowed_origins` 是额外信任的完整 HTTPS origin。允许列表会用于 WebSocket 与管理写操作，不是任意跨站读取的 CORS 开关。填写协议及非默认端口，不带路径或通配符；没有配置这些配置时才使用原有 Origin 与 Host 同源匹配。

不同入口 Cookie 独立，需要分别登录。额外域名不改变 Google 回调，也不会共享跨域 Cookie；使用 Google 登录时从主入口发起。反向代理即使改写上游 Host，也可以通过明确的允许列表接受实际浏览器域名；不要把任意 X-Forwarded-Host 当作信任依据。

## 路径和接口

| 用途 | 默认路径 |
| --- | --- |
| 管理首页 | `/admin` |
| 登录 | `/admin/login` |
| 用户页 | `/admin/users` |
| 当前账号 | `/admin/api/me` |
| 访客实时流 | `/admin/ws` |
| 节点快照 | `/admin/api/nodes` |
| Agent 访问批次 | `/api/track_batch` |
| Agent 流量 | `/api/node/metrics` |

HTML 表单和管理写请求受 CSRF 校验。浏览器页面会自动携带会话 CSRF token；自行调用写接口时，从 `/admin/api/me` 获取当前会话的 token 后放入 `X-CSRF-Token`。Agent API 使用 `Authorization: Bearer <API key>` 和 `X-Node-IP`，不使用浏览器 Cookie。
