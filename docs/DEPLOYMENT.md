# Nexus 服务端部署

## 1. 安装方式与端口

正式镜像为 `utoptop/nexus:1.0`，支持 Linux amd64/arm64。仓库根目录 Compose 创建 Nexus 与 TimescaleDB，数据库不向宿主机发布端口。应用默认仅监听宿主 `127.0.0.1:3001`，容器内监听 `0.0.0.0:3000`。

宿主 HAProxy/Nginx 使用 `127.0.0.1:3001`。如果代理与应用在同一 Docker 网络，使用 `nexus:3000`；容器内的 `127.0.0.1` 指向代理容器自身。默认网络名是 `nexus_nexus`，可把现有代理接入该网络，或者在 Compose 中配置已有外部网络。

如果需要远程代理直接连接宿主端口，在 `.env` 设置 `NEXUS_BIND=0.0.0.0`，并按网络拓扑限制该端口的访问来源。`NEXUS_PORT=3002` 可沿用既有 3002 端口。无需修改镜像内的 3000 端口。

## 2. 首次配置与启动

```bash
git clone https://github.com/utoptop/nexus.git
cd nexus
cp .env.example .env
openssl rand -hex 24
```

将随机值写入 `DB_PASSWORD`，设置独立的 `ADMIN_INITIAL_PASSWORD`（至少 12 字符）以及实际 HTTPS `PUBLIC_BASE_URL`。Google 配置可以留空。修改模板中 `nexus.example.com` 后执行：

```bash
docker compose config --quiet
docker compose pull
docker compose up -d --no-build
docker compose ps
docker compose logs --tail=100 nexus
```

数据库启动完成后应用会初始化表结构及初始管理员。`ADMIN_INITIAL_*` 只在没有已有管理员的数据库上生效，不会重置旧账号密码。

打开 `https://你的域名/admin`。首次登录后进入设置创建 API key，并记录供探针使用。API key 与管理密码、Google Client Secret 是不同的凭据。

Compose 示例把数据库密码拼入 PostgreSQL URL，因此新装推荐十六进制密码。接入现有数据库时保留原密码；若包含 `@ : / ? # %` 等 URI 字符，应提供正确 URL 编码的 `DATABASE_URL`，不要为迁就示例而直接改数据库密码。

## 3. 域名、TLS 与 WebSocket

代理必须完整转发 `/admin/...` 与 `/api/...`，不剥离 `/admin`。管理实时连接是 `/admin/ws`；修改 `ADMIN_PATH=/console` 后则是 `/console/ws`。探针上报始终是根路径 `/api/track_batch` 和 `/api/node/metrics`。

参考 [HAProxy](../deploy/haproxy.cfg) 或 [Nginx](../deploy/nginx.conf) 示例，将证书、域名和实际上游端口改为本机值。保留浏览器的 Host、Origin、Cookie 与代理协议头；不能用伪造 Origin 规避来源校验。HAProxy 会处理 WebSocket 升级，`timeout tunnel` 控制已建立连接的空闲超时。[HAProxy 官方说明](https://www.haproxy.com/documentation/haproxy-configuration-tutorials/protocol-support/websocket/)

多入口示例：

```dotenv
PUBLIC_BASE_URL=https://origin.example.com
ALLOWED_ORIGINS=https://nexus.example.com,https://status.example.com
```

允许列表只填写完整 origin（协议 + 主机 + 非默认端口），不能带 `/admin`、查询参数或通配符。设置主域名后，新版会校验 WebSocket 和写操作的 Origin。页面与节点 GET 查询成功，但轨迹不动，可能正是遗漏代理域名导致的 403。

浏览器 F12 → Network → WS 中应看到握手 `101`，并持续收到二进制消息。多个域名需分别登录；更换管理路径后也建议重新登录。

## 4. 本地 GeoLite2 City 数据库

自行取得 `GeoLite2-City.mmdb`，保存到 `geo-data/`，确保文件存在且容器非 root 用户可以读取，再启用 Compose 中的挂载：

```yaml
services:
  nexus:
    volumes:
      - ./geo-data/GeoLite2-City.mmdb:/app/GeoLite2-City.mmdb:ro
```

```bash
docker compose up -d --no-deps --no-build --force-recreate nexus
```

没有本地库时，应用使用外部 IP 地理查询。网络不可达、外部限流或数据库没有该地址时，位置可能显示 Unknown。当前 GeoIP 缓存/维表会保留结果，不能假定补上数据库后所有历史坐标立即刷新。节点可在设置中用公网 IP 重新定位。

## 5. 配置表

| 变量 | 默认值 / 说明 |
| --- | --- |
| `DB_PASSWORD` | Compose 必填，数据库用户 `nexus` 的密码 |
| `DATABASE_URL` | 二进制必填；根 Compose 自动设置为内部数据库 URL |
| `ADMIN_INITIAL_USERNAME` | `admin`，仅新库初始化使用 |
| `ADMIN_INITIAL_PASSWORD` | 新库必填，至少 12 字符 |
| `ADMIN_PATH` | `/admin`；可设置 `/console` 等非根路径 |
| `PUBLIC_BASE_URL` | 主 HTTPS origin；启用 Google 时必填 |
| `ALLOWED_ORIGINS` | 额外信任的浏览器 origin，逗号分隔 |
| `SESSION_HOURS` | `24`，范围 1–168 |
| `NEXUS_BIND` / `NEXUS_PORT` | Compose 端口绑定，默认 `127.0.0.1` / `3001` |
| `LISTEN_ADDR` | 二进制监听地址，默认 `0.0.0.0:3000`；通常不需在容器中改动 |
| `TZ` | 镜像默认 `Asia/Shanghai` |
| `RUST_LOG` | 镜像默认 `info`；故障排查可用 `info,nexus=debug` |
| `OIDC_ISSUER_URL` | `https://accounts.google.com` |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | 可选；详见身份管理说明 |
| `CF_TURNSTILE_SITE_KEY` / `CF_TURNSTILE_SECRET_KEY` | 可选登录验证配置 |
| `CARTO_API_KEY` | 可选地图 key；`MAP_API_KEY` 是别名 |
| `MAP_TILE_URL` | 可选自定义地图瓦片 URL |
| `DB_MAX_CONNECTIONS` | `24`，应用连接池限制 |
| `GEO_CACHE_MB` | `16`，地理缓存预算 |
| `INGEST_CONCURRENCY` | `64`，访问摄入并发上限 |
| `LIVE_QUEUE_CAPACITY` | `8192`，实时事件通道容量 |
| `LOG_QUEUE_CAPACITY` | `16384`，数据库日志通道容量 |
| `PG_MAX_CONNECTIONS` | `80`，数据库连接上限 |
| `PG_SHARED_BUFFERS` | `128MB` |
| `PG_EFFECTIVE_CACHE_SIZE` | `512MB`，规划器估计值，不是直接内存分配 |
| `PG_WORK_MEM` | `4MB`，每个排序/哈希操作的预算，不是数据库总内存 |

应用会限制部分预算变量的有效范围。总内存还包括数据库、连接、页面缓存和并发查询；应根据真实流量监测并调整。

## 6. 日志、更新和备份

```bash
docker compose logs -f --tail=100 nexus
docker compose logs --tail=100 db
docker compose pull nexus
docker compose up -d --no-deps --no-build --force-recreate nexus
```

默认数据库目录为 `./pgdata`。应用镜像无 shell，排查时优先使用应用日志、Compose 状态和数据库客户端，不依赖进入应用容器执行 bash。

数据库逻辑备份：

```bash
mkdir -p backups
docker compose exec -T db pg_dump -U nexus -d nexus -Fc > backups/nexus.dump
```

备份还应包含 `.env`、反向代理配置以及 PostgreSQL/TimescaleDB 的实际版本信息。备份文件不加入 Git。恢复时使用单独的新数据库，启用相同版本的 TimescaleDB，在恢复前后调用 `timescaledb_pre_restore()` / `timescaledb_post_restore()`；不要给 TimescaleDB 的 `pg_restore` 使用 `-j`。先在隔离环境验证恢复再切换应用连接。[官方恢复步骤](https://www.tigerdata.com/docs/deploy/self-hosted/backup-and-restore/logical-backup)

应用更新通常只拉取 `nexus` 服务，避免无意升级 `latest-pg17` 数据库标签。正式环境可把数据库镜像固定为经验证的版本或 digest；数据库主版本升级应独立执行。

## 7. 验收

1. `/admin` 登录成功，页面显示 NEXUS。
2. `/admin/ws` 返回 101；使用额外域名时分别验证。
3. Agent 上报后节点显示在线，网卡活动时有速度数据。
4. 访问被监控代理，确认 Docker access log 有支持格式的公网客户端记录。
5. 管理页面的访问计数增加并画出动态轨迹。
6. 暂停 Agent，约 30 秒未报告后节点显示离线；重新启动后恢复。
