# 故障排查

## 在线、有网速，但没有动态轨迹

在线/网速来自节点上报和 HTTP 快照；轨迹来自访问事件的 WebSocket 通道，两条链路独立。

1. 浏览器开发者工具 Network → WS，检查 `<auth.admin_path>/ws`。
2. 若源域名正常、代理域名失败，先将代理的完整 HTTPS origin 加入 `auth.allowed_origins`，重建应用容器后重新登录。
3. 若 WebSocket 已连接，检查代理容器是否输出支持的访问日志，Agent 是否监控了正确容器。
4. 若列表增加但地理位置异常，检查 GeoIP、节点坐标、当前筛选条件与视觉设置。

| 现象 | 检查项 |
| --- | --- |
| WS 101，持续收到消息 | 浏览器链路正常，继续看事件来源和筛选条件 |
| WS 401 | Cookie/登录会话失效；Secure Cookie 是否通过 HTTPS 发送 |
| WS 403 | auth.public_base_url、auth.allowed_origins、实际 Origin；日志会给出拒绝的 Origin/Host |
| WS 404 | auth.admin_path、代理路径重写或新旧镜像路径不一致 |
| WS 400/426 | HTTP 升级、Upgrade/Connection 转发与上游协议 |
| WS 502/503 | 代理上游地址、端口、容器网络和后端健康检查 |
| 连接建立后周期性断开 | 代理 tunnel/read timeout、会话撤销、过多页面或客户端消费过慢 |
| Agent `no matching containers` | auto 仅匹配 nginx/haproxy；改为明确容器名或 ID |
| Agent 上传 401/403 | API key、Authorization 透传；API 是否误套浏览器登录 |
| Agent 上传 413 | 请求体限制；Agent 会缩小批次，单条仍过大时保留并告警 |
| Agent 上传 503 | 服务端背压、数据库或节点写入失败；队列会保留重试 |
| 网速缺失/虚高 | network_interfaces、host 网络、虚拟网卡重复累计、故障后补报 |
| 节点 Unknown 或落在默认位置 | 本地 GeoLite2 文件、外部 IP 查询、历史缓存与节点定位 |
| 管理页数据库共享内存错误 | 数据库 shm_size、work_mem、并行聚合与磁盘空间 |

## 常用命令

服务端目录：

```bash
docker compose ps
docker compose logs --tail=100 nexus
docker compose logs --tail=100 db
docker compose exec -T db pg_isready -U nexus -d nexus
```

探针目录：

```bash
docker compose ps
docker compose logs --tail=100 nexus-agent
docker ps --format '{{.Names}}\t{{.Image}}'
docker logs --tail=20 你的代理容器
```

不要把包含 API key、Cookie 或数据库密码的完整配置直接公开。排障时提供响应状态、脱敏日志和转发规则通常已足够。

## 配置不生效或启动失败

当前重新发布的 `:1.0` 镜像只读取 `--config` 指定的 TOML，不读取 `.env` 或旧应用环境变量。旧缓存镜像也可能显示 1.0.0，必须先完成配置迁移，再 pull 并重新创建容器；检查镜像 digest / OCI revision，而不是只看版本号。

```bash
docker compose run --rm --no-deps nexus --config /etc/nexus/nexus.toml --check-config
docker compose up -d --no-deps --no-build --force-recreate nexus
```

配置需在重启时重新加载。推荐重新创建容器，确保编辑器原子替换后的挂载文件可见。检查实际挂载路径、文件权限、TOML 段名与字段类型，尤其注意 origin 和容器名称列表使用数组。密码文件与 `database.url` 不能同时配置。

## Turnstile 开关

关闭验证使用 `[turnstile] enabled = false`；即使保留密钥也不会验证。开启时两把密钥必须同时填写，页面和后端使用同一开关。开启后缺少 token 或校验失败会返回登录页，显示“人机验证未通过”。检查 Cloudflare 允许的主机名、密钥配对和网络连通性，详见[身份管理](AUTHENTICATION.md)。

## 镜像内没有 shell

服务端使用 Distroless nonroot，预期没有 bash/sh。通过 `docker compose logs`、代理日志、数据库服务和外部健康检查排障。Agent 镜像使用 Alpine，但无需进入容器修改二进制或配置。

## Google 登录失败

`redirect_uri_mismatch`：回调必须与 Google 客户端配置逐字一致。`pending`：账号等待管理员启用。`csrf`/state 失败：重新从主入口发起，不跨域切换登录流程，检查 HTTPS Cookie。详见[身份管理](AUTHENTICATION.md)。
