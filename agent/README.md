# Nexus Agent 1.0

镜像：[`utoptop/nexus-agent:1.0`](https://hub.docker.com/r/utoptop/nexus-agent)，支持 `linux/amd64` 与 `linux/arm64`。

```bash
cp .env.example .env
# 填写 SERVER_URL、AUTH_TOKEN、NODE_IP；确认监控容器与出口网卡
docker compose pull
docker compose up -d --no-build
docker compose logs -f nexus-agent
```

[完整部署与日志格式](../docs/AGENT.md) · [旧版本迁移](../docs/MIGRATION.md) · [测试与构建](../docs/DEVELOPMENT.md)

运行目录包含持久化队列、日志游标及网络采样基线；升级时保留 `agent-data` 卷。默认读取 Docker Socket 的 stdout/stderr，不扫描容器内部普通日志文件。
