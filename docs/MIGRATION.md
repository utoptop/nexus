# 从环境变量迁移到配置文件

当前 `utoptop/nexus:1.0` 与 `utoptop/nexus-agent:1.0` 已同版本重新发布，使用 `nexus.toml` / `nexus-agent.toml`，取消 `.env` 和应用环境变量读取。原环境变量版也使用 1.0 标签，因此必须先迁移配置，再拉取镜像并重新创建容器；版本字符串本身不能区分这两次构建，可用镜像 digest 或 OCI revision 标签核对。

数据库表、探针协议、SQLite 队列与 Cookie 名保持兼容。迁移配置不需要清空数据库、重建账号或删除队列。

## 1. 服务端保留原部署

1. 备份原 Compose、`.env` 和数据库，记录原服务名、镜像 digest、端口、卷路径。
2. 从 `config/nexus.toml.example` 复制一份私有 TOML。
3. 删除模板里的 `database.password_file`，把原 `DATABASE_URL` 原样放到 `database.url`，保留原用户名、库名、编码后的密码和数据库服务名。
4. 按下表迁移其他字段，检查文件后将它只读挂载到 `/etc/nexus/nexus.toml`。
5. 删除应用的旧 `env_file`、应用参数 `environment`、自定义旧二进制 command/entrypoint；保留原数据库服务配置、数据挂载、网络与宿主端口。

```toml
[database]
url = "postgres://原用户:原URL编码密码@原数据库服务:5432/原数据库"

[auth]
public_base_url = "https://origin.example.com"
allowed_origins = ["https://proxy.example.com"]
admin_path = "/admin"
```

已有管理员可不填写 `initial_password`，初始化字段不会覆盖原账号。

```yaml
services:
  ip-logger: # 保留你原来的服务键
    image: utoptop/nexus:1.0
    volumes:
      - ./config/nexus.toml:/etc/nexus/nexus.toml:ro
    # 其他原网络、端口等配置继续保留
```

确认旧 Compose 应用镜像已改为 `utoptop/nexus:1.0` 并挂载好 TOML，然后在旧部署目录执行：

```bash
docker compose pull ip-logger
docker compose run --rm --no-deps ip-logger --config /etc/nexus/nexus.toml --check-config
docker compose up -d --no-deps --no-build --force-recreate ip-logger
```

如果旧 Compose 显式设置了旧 `command` 或 `entrypoint`，需删除后使用新镜像默认入口。不要启动新装 Compose 替换旧数据库。保留 `3002:3000` 等原端口即可继续使用既有 HAProxy 上游。

## 2. 字段对应

| 旧环境变量 | 新配置字段 |
| --- | --- |
| `DATABASE_URL` | `[database] url` |
| `DB_MAX_CONNECTIONS` | `[database] max_connections` |
| `LISTEN_ADDR` / `RUST_LOG` | `[server] listen_addr / log_filter` |
| `FRONTEND_ASSET_DIR` | `[server] frontend_asset_dir` |
| `ADMIN_PATH` / `PUBLIC_BASE_URL` | `[auth] admin_path / public_base_url` |
| `ALLOWED_ORIGINS` | `[auth] allowed_origins`，由逗号字符串改为数组 |
| `SESSION_HOURS` | `[auth] session_hours` |
| `ADMIN_INITIAL_USERNAME` / `ADMIN_INITIAL_PASSWORD` | `[auth] initial_username / initial_password` |
| `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | `[oidc] issuer_url / client_id / client_secret` |
| `CF_TURNSTILE_SITE_KEY` / `CF_TURNSTILE_SECRET_KEY` | `[turnstile] site_key / secret_key`，另设 `enabled = true` 才启用 |
| `CARTO_API_KEY` / `MAP_API_KEY` | `[map] api_key` |
| `MAP_TILE_URL` | `[map] tile_url` |
| `GEO_CACHE_MB` / `INGEST_CONCURRENCY` | `[limits] geo_cache_mb / ingest_concurrency` |
| `LIVE_QUEUE_CAPACITY` / `LOG_QUEUE_CAPACITY` | `[limits] live_queue_capacity / log_queue_capacity` |
| `NEXUS_BIND` / `NEXUS_PORT` | 修改 Compose 的 `ports` |
| `PG_*` 调优项 | 新装可用 `config/postgresql.conf`；旧库保留原数据库配置 |
| `DB_PASSWORD` | 新装使用 `config/postgres-password`；旧库继续原连接密码 |

原先填了 Turnstile 密钥的实例，迁移时务必明确选择 `enabled = true` 或 `false`；默认关闭，不再根据某一把密钥是否存在隐式启用。

## 3. Agent 保留队列

复制 `agent/config/nexus-agent.toml.example`，把原配置对应到小写字段：

```toml
server_url = "https://origin.example.com/api/track_batch"
auth_token = "原API密钥"
node_ip = "原节点公网IP"
monitor_containers = ["haproxy-main"]
network_interfaces = ["eth0"]
state_dir = "/var/lib/logger-agent" # 如果原卷挂在这里，继续使用原路径
```

`BATCH_SIZE`、`QUEUE_MAX_EVENTS`、`QUEUE_MAX_BYTES`、`DOCKER_SOCKET`、`METRICS_URL` 分别对应同名小写字段。容器选择与网卡选择改为数组；`monitor_containers = ["auto"]` 对应原 auto，空网卡选择用 `[]`。

将 TOML 挂载到 `/etc/nexus-agent/nexus-agent.toml`，保留原服务键、Docker Socket、host 网络和状态卷；删除旧应用 `environment` 及旧二进制入口覆盖。将探针镜像设置为 `utoptop/nexus-agent:1.0`，执行 `docker compose pull 原探针服务名`，再检查配置并重新创建探针。

状态目录绑定上报 URL、节点 IP 与网卡集合。这次迁移保持这些值不变，就能继续读取原队列。轮换 API key 不改变绑定。需要同时改上报域名时，先排空队列，再单独迁移绑定；不要修改数据库内的绑定记录绕过检查。

## 4. 目录、权限与回退

移动 Compose 目录或改变项目名会影响默认卷名。新装 `nexus-agent_agent-data` 通常不是旧卷。迁移到新目录时用 `external: true` 和原卷名，或继续旧目录；服务端 `./pgdata` 同样必须指向原数据。

TOML 中的相对路径以 TOML 所在目录为基准。示例使用容器绝对路径，避免状态卷挂载与配置不一致。配置需让容器用户可读，并限制宿主上其他用户读取。

配置改完后重新创建应用容器，无需删除数据。回退需同时恢复旧镜像与旧环境变量配置；只恢复旧镜像而保留 TOML 启动方式会失败。数据库回退先在备份副本验证，不执行 `down -v` 或清空持久目录。
