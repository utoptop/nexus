# Nexus Agent 部署与日志采集

## 1. 运行方式

镜像：`utoptop/nexus-agent:1.0`，程序：`nexus-agent`，版本：1.0.0。要求 Linux Docker 主机，使用 host 网络读取宿主网卡计数器，并挂载 Docker Unix Socket。可监控其他 Compose 项目的容器。

在节点上取得仓库 `agent/` 目录，执行：

```bash
cp .env.example .env
```

填写：

```dotenv
SERVER_URL=https://nexus.example.com/api/track_batch
AUTH_TOKEN=后台设置中生成的API密钥
NODE_IP=203.0.113.10
MONITOR_CONTAINERS=auto
NETWORK_INTERFACES=eth0
```

`NODE_IP` 换成本节点真实公网 IPv4/IPv6，`eth0` 换成实际出口网卡；不知道接口名时可留空使用自动过滤。之后：

```bash
docker compose config --quiet
docker compose pull
docker compose up -d --no-build
docker compose logs -f nexus-agent
```

Docker Socket 授权探针读取容器元数据和日志，应只交给可信镜像。挂载 `:ro` 不等同于 Docker API 权限隔离；需要更细粒度权限时可另设仅允许所需读取接口的 Socket 代理。

## 2. 采集范围

`MONITOR_CONTAINERS=auto` 只自动选择**容器名或镜像名**含 `nginx`、`haproxy` 的运行容器。自定义命名或其他来源应显式指定名称/ID：

```dotenv
MONITOR_CONTAINERS=edge-haproxy,public-nginx
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

| 变量 | 说明 |
| --- | --- |
| `SERVER_URL` | 必填，完整 `/api/track_batch` 地址 |
| `AUTH_TOKEN` | 必填，后台 API key |
| `NODE_IP` | 必填，节点身份 IP |
| `MONITOR_CONTAINERS` | `auto` 或逗号分隔的容器名/ID |
| `NETWORK_INTERFACES` | 空值排除 lo/docker/veth/br-/wg/tun/tap；或指定 `eth0,eth1` |
| `BATCH_SIZE` | `500`，范围 1–2000；请求体同时限制为 512 KiB |
| `QUEUE_MAX_EVENTS` | `50000`，范围 2000–10000000 |
| `QUEUE_MAX_BYTES` | `67108864`，队列记录字节预算；SQLite/WAL/索引另占磁盘 |
| `STATE_DIR` | 镜像默认 `/var/lib/nexus-agent`；直接运行默认 `./data` |
| `DOCKER_SOCKET` | 默认 `/var/run/docker.sock` |
| `METRICS_URL` | 默认从 `SERVER_URL` 推导 `/api/node/metrics`；二进制可直接设置，Compose 自定义时加入 environment |

不要把 `/admin` 加到上报 API 前面。登录用户名、管理员密码、Google Secret 都不能代替 `AUTH_TOKEN`。

## 5. 队列、重试与迁移

日志采集独立于握手成功，记录与游标在同一个 SQLite 事务提交。HTTP 2xx 后删除相应队列；503/429 等遵循 Retry-After，其他暂时性失败退避重试。401/403 等保留记录并告警。413 会缩小批次；队列满时施加背压，不丢弃最旧的未确认记录。

状态目录绑定节点 IP、上报地址和网卡选择。token 可正常轮换；改变绑定信息前先排空队列，再使用新的状态目录。升级必须保留卷，不能执行 `down -v`。旧版本迁移时可显式保留 `/var/lib/logger-agent` 作为 STATE_DIR，详见[迁移说明](MIGRATION.md)。

容器日志保留时间不足、日志时间倒退、磁盘故障或主机突然掉电可能超出补读保障。SIGTERM 会尝试在 15 秒内停止采集并提交缓冲；Compose 提供 20 秒退出宽限期。

## 6. 流量与确认边界

网络采样和上传相互独立，未确认流量与网卡基线持久化。协议兼容既有的 `rx_bytes_total/tx_bytes_total/rx_speed_bps/tx_speed_bps` 字段；服务端目前按 `speed × 2` 累计，因此 Agent 用尚未确认字节数折算两秒值。补发阶段可能出现速度尖峰。

访问批次没有端到端幂等 ID，服务端也不是逐条落盘后才 ACK。响应丢失/重试可能重复，ACK 后服务端异常也存在尚未落盘窗口。不要把本地可靠队列描述成端到端 exactly-once。未来若调整协议，需要同时升级采集时间、累计计数与持久确认机制。
