# Nexus Agent 部署与日志采集

## 1. 运行方式

当前 `utoptop/nexus-agent:1.0` 为 TOML 配置文件版，程序版本仍为 1.0.0。旧环境变量版应先迁移配置、保留状态卷，再拉取同名镜像。要求 Linux Docker 主机，使用 host 网络读取宿主网卡计数器，并挂载 Docker Unix Socket。

在仓库 `agent/` 目录执行：

```bash
cp config/nexus-agent.toml.example config/nexus-agent.toml
chmod 700 config
```

编辑对应字段：

```toml
server_url = "https://nexus.example.com/api/track_batch"
auth_token = "后台生成的API密钥"
node_ip = "203.0.113.10"
monitor_containers = ["auto"]
network_interfaces = ["eth0"]
```

`node_ip` 换为真实公网 IPv4/IPv6，网卡改为实际出口接口；自动过滤使用 `network_interfaces = []`。

```bash
docker compose pull nexus-agent
docker compose run --rm --no-deps nexus-agent --config /etc/nexus-agent/nexus-agent.toml --check-config
docker compose up -d --no-build
docker compose logs -f nexus-agent
```

应用不再读取旧环境变量。启动时通过 `--config` 选择文件，直接运行默认读取当前目录 `nexus-agent.toml`。修改配置后重新创建容器，配置文件不会自动热更新。

Docker Socket 授权探针读取容器元数据和日志，应只交给可信镜像。挂载 `:ro` 不等同于 Docker API 权限隔离；需要更细粒度权限时可另设仅允许所需读取接口的 Socket 代理。

## 2. 采集范围

`monitor_containers = ["auto"]` 只自动选择**容器名或镜像名**含 `nginx`、`haproxy` 的运行容器。自定义命名或其他来源应显式指定名称/ID：

```toml
monitor_containers = ["edge-haproxy", "public-nginx"]
```

每 10 秒重新发现。新容器首次从 Agent 启动时刻开始读取，不会默认灌入全部旧日志；已有游标的容器在重连/重启后继续补读。

只读取 Docker 日志接口暴露的 stdout/stderr。写入普通日志文件、仅发送到远程 syslog 或关闭 access log 的代理，不能仅靠挂载 Socket 自动采集。可先运行：

```bash
docker logs --tail=20 你的代理容器名
```

## 3. 支持的格式

### TRACK_L7

```text
TRACK_L7|8.8.8.8|{example.com}|
```

字段依次为标记、真实客户端 IP、访问 Host。HAProxy 可显式配置日志输出到 stdout，并使用：

```haproxy
global
    log stdout format raw local0

defaults
    log global
    mode http

frontend public_https
    # 其余 bind、证书与路由规则使用你现有配置
    capture request header Host len 512
    log-format "TRACK_L7|%ci|%hr|"
```

该示例假设这一个 request capture 是 Host；若已有其他捕获头，`%hr` 可能包含多个值，应将实际输出核对后再使用。CDN 场景的 `%ci` 可能是上游代理 IP，真实访客地址必须在可信代理链中正确取得。

### Nginx common/combined

```text
8.8.8.8 - - [17/Nov/2026:12:00:00 +0800] "GET /index.html HTTP/1.1" 200 123 "-" "browser"
```

### HAProxy HTTP

```text
haproxy[42]: 9.9.9.9:12345 [17/Nov/2026:12:00:00.000] frontend backend/server 0/0/1/2/3 200 123 - - ---- 1/1/1/1/0 0/0 "GET / HTTP/1.1"
```

普通格式没有 Host 时上报 `-`，不会把 Referer、frontend/backend 名或容器名当成访问域名。请求为完整 HTTP(S) URL 时可以提取 URL 的 Host。

当前不解析 Traefik/Nginx 的 JSON access log，也不把 HAProxy TCP 连接日志当成 HTTP 访问。无效、私网、回环、组播及节点自身 IP 会被过滤；超过 64 KiB 的日志或超过 512 字节的域名会被拒绝。默认计数是访问事件次数，不是去重人数。

## 4. 配置表

| TOML 字段 | 说明 |
| --- | --- |
| `server_url` | 必填，完整 `/api/track_batch` 地址 |
| `auth_token` | 必填，后台 API key |
| `node_ip` | 必填，节点身份 IP |
| `monitor_containers` | `["auto"]` 或容器名称/ID 数组 |
| `network_interfaces` | `[]` 自动排除 lo/docker/veth/br-/wg/tun/tap；或 `["eth0", "eth1"]` |
| `batch_size` | `500`，范围 1–2000，请求体同时限制为 512 KiB |
| `queue_max_events` | `50000`，范围 2000–10000000 |
| `queue_max_bytes` | `67108864`，范围 1 MiB–16 GiB，SQLite/WAL/索引另占磁盘 |
| `state_dir` | 默认 `/var/lib/nexus-agent`；直接运行可显式设为 `./data` |
| `docker_socket` | 默认 `/var/run/docker.sock` |
| `metrics_url` | 可选，默认从 server_url 推导 `/api/node/metrics` |

相对路径以 TOML 所在目录为基准。未知字段、字段类型错误、无效 URL/IP、缺少必填值或超范围数字会拒绝启动。不要把 `/admin` 加到上报 API 前面，管理密码不能代替 API key。

## 5. 队列、重试与迁移

日志采集独立于握手成功，记录与游标在同一个 SQLite 事务提交。HTTP 2xx 后删除相应队列；503/429 等遵循 Retry-After，其他暂时性失败退避重试。401/403 等保留记录并告警。413 会缩小批次；队列满时施加背压，不丢弃最旧的未确认记录。

状态目录绑定节点 IP、上报地址和网卡选择。token 可正常轮换；改变绑定信息前先排空队列，再使用新的状态目录。升级必须保留卷，不能执行 `down -v`。旧版本迁移时可显式保留 `/var/lib/logger-agent` 作为 `state_dir`，详见[迁移说明](MIGRATION.md)。

容器日志保留时间不足、日志时间倒退、磁盘故障或主机突然掉电可能超出补读保障。SIGTERM 会尝试在 15 秒内停止采集并提交缓冲；Compose 提供 20 秒退出宽限期。

## 6. 流量与确认边界

网络采样和上传相互独立，未确认流量与网卡基线持久化。协议兼容既有的 `rx_bytes_total/tx_bytes_total/rx_speed_bps/tx_speed_bps` 字段；服务端目前按 `speed × 2` 累计，因此 Agent 用尚未确认字节数折算两秒值。补发阶段可能出现速度尖峰。

访问批次没有端到端幂等 ID，服务端也不是逐条落盘后才 ACK。响应丢失/重试可能重复，ACK 后服务端异常也存在尚未落盘窗口。不要把本地可靠队列描述成端到端 exactly-once。未来若调整协议，需要同时升级采集时间、累计计数与持久确认机制。
