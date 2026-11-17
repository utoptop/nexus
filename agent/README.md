# Nexus Agent

```bash
cp config/nexus-agent.toml.example config/nexus-agent.toml
# 编辑 server_url、auth_token、node_ip 等参数后：
docker compose pull nexus-agent
docker compose run --rm --no-deps nexus-agent --config /etc/nexus-agent/nexus-agent.toml --check-config
docker compose up -d --no-build
```

当前 `utoptop/nexus-agent:1.0` 已更新为配置文件版，版本号保持不变。旧部署需先迁移配置，保留原状态卷和绑定信息，再拉取镜像。

详见[探针部署](../docs/AGENT.md)、[迁移说明](../docs/MIGRATION.md)和[故障排查](../docs/TROUBLESHOOTING.md)。
