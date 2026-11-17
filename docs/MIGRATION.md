# 从 IP Logger / logger-agent 迁移到 Nexus 1.0

Nexus 1.0 正式使用 `utoptop/nexus:1.0` 和 `utoptop/nexus-agent:1.0`。协议、数据库表与探针队列结构保留兼容；应用可分步升级。已有部署不需要重新导入访问记录或重新创建数据库。

## 服务端：在旧部署目录中升级

1. 备份数据库与原 `.env`、Compose 文件。
2. 保留数据库镜像、数据库名/用户/密码、`pgdata` 挂载路径、网络与端口。不能把新装 Compose 中的 `nexus` 数据库用户直接套到已有 `admin/iplogger` 数据库。
3. 在旧 Compose 的应用服务中，仅把 `image` 改成 `utoptop/nexus:1.0`。原服务键和容器名可以暂时保持 `ip-logger`，避免意外创建并行实例。
4. 保证 `.env` 注入应用容器。源域名和代理域名同时使用时设置：

```dotenv
PUBLIC_BASE_URL=https://origin.example.com
ALLOWED_ORIGINS=https://nexus.example.com
```

5. 若旧服务键是 `ip-logger`，在旧目录运行：

```bash
docker compose pull ip-logger
docker compose up -d --no-deps --no-build --force-recreate ip-logger
docker compose logs --tail=100 ip-logger
```

新镜像的默认程序是 `/app/nexus`；如果旧 Compose 手工指定 `command: /app/ip_logger` 或自定义 entrypoint，应删除该覆盖并使用镜像默认命令。

保留原来的 `3002:3000` 等端口映射即可继续使用既有 HAProxy 上游，无需为品牌改名而调整代理。重新登录后验证 `<ADMIN_PATH>/ws`。较早账号版本的管理员会迁移，旧会话可能需要重新登录。内部 `iplogger_session` Cookie 名保留以减少升级中断，这不影响页面品牌。

## Agent：保留持久卷与绑定信息

在旧 Agent Compose 中把镜像改为 `utoptop/nexus-agent:1.0`，保留旧服务键 `logger-agent`、卷名、挂载位置和以下配置：`SERVER_URL`、`NODE_IP`、`NETWORK_INTERFACES`。

新镜像默认状态目录是 `/var/lib/nexus-agent`。如果旧卷仍挂在 `/var/lib/logger-agent`，显式保留：

```yaml
services:
  logger-agent:
    image: utoptop/nexus-agent:1.0
    environment:
      STATE_DIR: /var/lib/logger-agent
    # 保留你原来的卷定义，例如：
    volumes:
      - agent-data:/var/lib/logger-agent
      - /var/run/docker.sock:/var/run/docker.sock:ro
```

这是合并片段，不是完整 Compose；其他原有配置仍需保留。然后：

```bash
docker compose pull logger-agent
docker compose up -d --no-deps --no-build --force-recreate logger-agent
docker compose logs --tail=100 logger-agent
```

默认命令已变为 `nexus-agent`，删除旧的二进制 command 覆盖。不要同时运行两个探针读取同一个持久目录，也不要同时运行新旧探针对同一来源重复计数。

## 移到新仓库目录时

Compose 项目名、服务名和相对路径会影响实际卷及数据目录。新装的 `nexus-agent_agent-data` 与旧目录自动生成的卷名通常不同。迁移已有 Agent 卷时，在新 Compose 使用明确的外部卷名：

```yaml
volumes:
  agent-data:
    external: true
    name: 这里填写docker-volume-ls中原来的卷名
```

新服务端目录中的 `./pgdata` 也不是旧目录的数据。先保持旧部署运行，通过备份/恢复或明确的绝对数据路径完成迁移；不要直接启动一套空数据库后误认为旧记录丢失。

状态目录绑定节点身份、上报 URL 与网卡选择。若同时换域名导致 `SERVER_URL` 改变，应先排空旧队列，再按新绑定使用新的状态目录；不要通过删除绑定记录强行混用未确认数据。

## 回退

升级前记录旧镜像 digest 与数据库备份。需要回退时优先回退应用镜像并保留数据；数据库 schema 或数据格式是否仍兼容应先在备份副本验证。不要直接覆盖或清空生产数据库来回退版本。
