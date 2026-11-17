# Nexus 服务端部署（配置文件版）

当前 `utoptop/nexus:1.0` 使用 TOML，取消应用环境变量和 `.env`，程序版本仍为 1.0.0。这是同名镜像更新：已有环境变量版部署先看[迁移说明](MIGRATION.md)，准备新配置并保留原数据库、密码、数据目录和端口。

## 1. 配置文件

| 文件 | 用途 |
| --- | --- |
| `config/nexus.toml` | 服务端、账号、域名、Turnstile、OIDC、地图、容量参数 |
| `config/postgres-password` | 数据库密码，纯文本单行，由应用与 PostgreSQL 共享 |
| `config/postgresql.conf` | PostgreSQL 内存、连接数等参数 |
| `docker-compose.yaml` | 宿主端口、网络、挂载、资源限制 |

真实 TOML、数据库密码及探针 TOML 已加入 `.gitignore`，镜像不会复制这些文件。配置只在启动时读取，不提供在线热修改。相对文件路径以 TOML 文件所在目录为基准；容器示例使用绝对路径。

## 2. 全新安装

```bash
git clone https://github.com/utoptop/nexus.git
cd nexus
cp config/nexus.toml.example config/nexus.toml
openssl rand -hex 24 > config/postgres-password
chmod 700 config
chmod 644 config/nexus.toml config/postgres-password
```

`config/` 的宿主权限限制其他普通用户读取；挂载文件要让容器的非 root 用户可读。如果使用 rootless Docker 或自定义 UID，按实际 UID 调整权限。不要把密码文件设成容器用户不可读的 `600` 后直接挂载。

修改 TOML 中的 `auth.public_base_url` 和 `auth.initial_password`（至少 12 字符）；首次初始化用户名默认 `admin`。已有管理员不会被初始化配置重置。数据库密码文件仅在全新安装时随机生成，已有库必须沿用原密码。

```bash
docker compose config --quiet
docker compose pull nexus
docker compose run --rm --no-deps nexus --config /etc/nexus/nexus.toml --check-config
docker compose up -d --no-build
docker compose ps
docker compose logs --tail=100 nexus
```

`--check-config` 校验字段、来源策略、Turnstile 开关与数据库密码文件，不连接数据库。旧库可留空初始化密码；新库需要有效的初始化密码。缺少配置文件、未知字段、错误类型、超范围数值会报错，错误信息不输出配置原文或密钥。

应用默认只发布宿主 `127.0.0.1:3001`。HAProxy/Nginx 连 `http://127.0.0.1:3001`；同一 Docker 网络内连 `nexus:3000`。打开 HTTPS 管理地址 `/admin` 登录，并创建探针 API key。

## 3. 域名与代理

```toml
[auth]
public_base_url = "https://origin.example.com"
allowed_origins = ["https://proxy.example.com", "https://monitor.example.com"]
admin_path = "/admin"
```

将内容合并到已有 `[auth]` 段。列表项是协议、主机及可选端口，不带路径、查询参数或通配符；本机 localhost 测试允许 HTTP。主入口用于安全 Cookie 和 OIDC 回调，额外入口用于 WebSocket 与管理写操作的来源校验。不同入口分别登录。

参考 [HAProxy](../deploy/haproxy.cfg) / [Nginx](../deploy/nginx.conf) 示例，保留 Host、Origin、Cookie，完整转发 `/admin/...` 与 `/api/...`。HAProxy WebSocket 使用 `timeout tunnel` 控制连接超时。[HAProxy 官方说明](https://www.haproxy.com/documentation/haproxy-configuration-tutorials/protocol-support/websocket/)

修改管理路径后实时接口随之改变，例如 `/console/ws`；探针接口仍为 `/api/track_batch` 与 `/api/node/metrics`。浏览器 WS 应返回 101。

需要沿用 3002 端口时直接将 Compose 端口改为 `127.0.0.1:3002:3000`。远程代理直连宿主时按需调整监听地址及访问范围，不再使用 `NEXUS_PORT` / `NEXUS_BIND` 环境变量。

## 4. Turnstile 开关

默认关闭：

```toml
[turnstile]
enabled = false
site_key = ""
secret_key = ""
timeout_seconds = 10
```

开启时改为 `enabled = true`，并填写同一个 Cloudflare Turnstile 组件的 Site Key 和 Secret Key。关闭时允许保留密钥，不显示组件、不发起验证请求；开启但缺少密钥会阻止启动。校验失败、超时、缺少 token 都不会放行本地密码登录。Secret Key 始终只供服务端使用。

这是登录页 Turnstile，不控制 Cloudflare DNS 小黄云或 WAF 挑战开关。详细配置见[身份管理](AUTHENTICATION.md)。

## 5. 配置字段

| TOML 字段 | 默认值 / 说明 |
| --- | --- |
| `server.listen_addr` | `0.0.0.0:3000`，容器内部监听 |
| `server.log_filter` | `info`，可设 `info,nexus=debug` |
| `server.frontend_asset_dir` | `/app/templates/assets` |
| `server.geoip_database` | `/app/GeoLite2-City.mmdb`，可选本地库 |
| `database.host / port / user / name` | `db / 5432 / nexus / nexus` |
| `database.password_file` | 必填其一；密码文件，尾部换行会被去掉 |
| `database.url` | 接入旧库/外部库时使用；与 password_file 互斥 |
| `database.max_connections` | `24`，范围 4–128 |
| `auth.admin_path` | `/admin` |
| `auth.public_base_url` | 主入口；启用 Google 时必填 |
| `auth.allowed_origins` | `[]`，额外入口数组 |
| `auth.session_hours` | `24`，范围 1–168 |
| `auth.initial_username / initial_password` | 初始管理员；密码只在新库生效 |
| `turnstile.enabled` | `false`，本地密码登录验证开关 |
| `turnstile.site_key / secret_key` | 启用时同时必填 |
| `turnstile.timeout_seconds` | `10`，范围 1–30 |
| `oidc.issuer_url` | `https://accounts.google.com` |
| `oidc.client_id / client_secret` | 可选 Google 登录，两项同时配置 |
| `map.api_key / tile_url` | 可选地图参数 |
| `limits.geo_cache_mb` | `16`，范围 1–256 |
| `limits.ingest_concurrency` | `64`，范围 4–512 |
| `limits.live_queue_capacity` | `8192`，范围 512–65536 |
| `limits.log_queue_capacity` | `16384`，范围 1024–131072 |

分段数据库配置用连接参数传递密码，无需 URL 编码。若使用 `database.url`，密码中的 `@ : / ? # %` 等字符仍需正确编码。PostgreSQL 调优直接编辑 `config/postgresql.conf`；数据库镜像所需的固定 `POSTGRES_*` 初始化项保留在 Compose 内，密码值不使用环境变量传递。

## 6. GeoIP、更新与备份

自行取得合法的 GeoLite2 City 数据库，放入 `geo-data/GeoLite2-City.mmdb`，确认非 root 用户可读后启用 Compose 注释中的挂载。无本地库时使用外部 IP 地理查询，网络和限流可能影响定位；旧维表/缓存不会因补上文件立即全部刷新。

只修改配置时：

```bash
docker compose run --rm --no-deps nexus --config /etc/nexus/nexus.toml --check-config
docker compose up -d --no-deps --no-build --force-recreate nexus
```

重新创建可确保编辑器原子替换后的挂载文件也生效。更新正式镜像先执行 `docker compose pull nexus`，再重新创建应用容器；仅修改配置不需要重新构建。源码部署可使用 `docker compose build nexus`。同名标签更新前记录旧镜像 digest，回退时使用对应的旧配置。

```bash
mkdir -p backups
docker compose exec -T db pg_dump -U nexus -d nexus -Fc > backups/nexus.dump
```

同时备份私有配置、密码文件、代理配置和数据库实际版本。数据库存放在 `./pgdata`，不能随意删除或更换 PG 主版本。TimescaleDB 恢复应遵循其 pre/post restore 步骤，不给 pg_restore 使用 `-j`。[官方恢复步骤](https://www.tigerdata.com/docs/deploy/self-hosted/backup-and-restore/logical-backup)

服务端镜像没有 shell，检查配置使用二进制的 `--check-config` 和容器日志。
