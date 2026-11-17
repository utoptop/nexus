# 账号、Google OIDC 与多域名

## 本地账号

新库使用 `.env` 中的 `ADMIN_INITIAL_USERNAME` 和 `ADMIN_INITIAL_PASSWORD` 初始化首个管理员，密码至少 12 字符。已有数据库会保留管理员，不通过初始化变量覆盖密码。后台支持管理员和观察者、账号启停、密码修改及会话撤销；观察者可以查看流量，不能管理节点、密钥或成员。

修改密码或撤销会话后需要重新登录。系统防止删除/禁用最后一位可用管理员。浏览器会话使用 HttpOnly、SameSite=Lax Cookie，配置 HTTPS 主入口后设置 Secure；从纯 HTTP 地址访问时，这种 Cookie 不会被发送。

## Google 登录

本地账号可独立使用。启用 Google 时：

1. 在 Google Cloud Console 创建或选择项目，在 Google Auth Platform 配置 Branding、Audience 与支持邮箱。
2. 创建类型为 Web application 的 OAuth Client。
3. 请求范围是 `openid email profile`。Testing 模式按 Google 配置加入测试用户；应用内的成员审核仍然独立。
4. 在 Authorized redirect URIs 中填写：`PUBLIC_BASE_URL + ADMIN_PATH + /auth/oidc/callback`。
5. 将客户端 ID 和 Secret 写入应用 `.env` 并重建容器。

```dotenv
PUBLIC_BASE_URL=https://nexus.example.com
ADMIN_PATH=/admin
OIDC_ISSUER_URL=https://accounts.google.com
OIDC_CLIENT_ID=你的客户端ID.apps.googleusercontent.com
OIDC_CLIENT_SECRET='你的客户端Secret'
```

回调示例：`https://nexus.example.com/admin/auth/oidc/callback`。域名、协议、端口、路径和尾斜杠需与 Google 配置一致。服务端实现 Discovery、PKCE、state、nonce 和 ID token 校验。[Google OIDC 文档](https://developers.google.com/identity/openid-connect)

先以原本地管理员登录，再在我的账号中绑定 Google，可保留同一个管理员身份。直接使用未绑定的 Google 身份登录，会进入待管理员审核的流程；同邮箱不会自动合并账号，也不会自动获得管理员权限。

## 多域名与代理入口

```dotenv
PUBLIC_BASE_URL=https://origin.example.com
ALLOWED_ORIGINS=https://nexus.example.com,https://monitor.example.com
```

`PUBLIC_BASE_URL` 是主入口与 Google 回调地址，`ALLOWED_ORIGINS` 是额外信任的完整 HTTPS origin。允许列表会用于 WebSocket 与管理写操作，不是任意跨站读取的 CORS 开关。填写协议及非默认端口，不带路径或通配符；没有配置这些变量时才使用原有 Origin 与 Host 同源匹配。

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
