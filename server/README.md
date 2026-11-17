# Nexus 1.0 服务端

镜像：[`utoptop/nexus:1.0`](https://hub.docker.com/r/utoptop/nexus)，支持 `linux/amd64` 与 `linux/arm64`。

使用仓库根目录的 `.env.example` 与 `docker-compose.yaml` 完成新装；不要在已有数据库上直接套用新装配置。

[项目首页](../README.md) · [完整部署](../docs/DEPLOYMENT.md) · [账号与多域名](../docs/AUTHENTICATION.md) · [迁移](../docs/MIGRATION.md)

源码构建要求 Rust 1.93+；启动需要 `DATABASE_URL`，并从工作目录 `templates/assets` 或 `FRONTEND_ASSET_DIR` 加载资源。内置初始化测试可通过 `cargo test --locked` 运行。
