# 构建与验证

## Rust

两项目使用 Rust 2024 edition，要求 Rust 1.93+。服务端依赖 OpenSSL 开发库与 pkg-config；Agent 的 SQLite 使用 bundled 模式，需要 C 编译器。Linux Debian/Ubuntu 可安装 `build-essential pkg-config libssl-dev`。

```bash
cd server
cargo test --locked
cargo build --locked
node --test tests/traffic-runtime.test.cjs
```

```bash
cd agent
cargo fmt --all --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
python3 tests/recovery.py target/debug/nexus-agent
```

服务端使用 `target/debug/nexus --config /path/to/nexus.toml`；本机运行时将 `server.frontend_asset_dir` 设为仓库 `server/templates/assets` 的绝对路径。探针使用 `target/debug/nexus-agent --config /path/to/nexus-agent.toml`。两者支持 `--check-config`，不读取应用环境变量。测试工具自身的路径/数据库选择变量仍只用于测试。

## 双域名浏览器回归

需要 Node.js、Playwright、Chrome/Chromium、openssl 与一个发布本机端口的可销毁 PostgreSQL 容器。测试会自行创建/清理独立数据库，模拟代理改写 Host，先验证代理域名被单域名策略拒绝，再只改变允许列表验证真实轨迹恢复。同时验证旧环境变量不干扰 TOML，以及 Turnstile 开启拒绝空 token、关闭后恢复登录。

```bash
docker run -d --name nexus-qa-db -e POSTGRES_PASSWORD=local-test-only -p 127.0.0.1:55439:5432 postgres:17-alpine
cd server
npm install --no-save playwright
cargo build --locked
QA_POSTGRES_CONTAINER=nexus-qa-db CHROME_PATH=/path/to/chrome node tests/proxy-origin-browser.cjs
```

用 `NEXUS_BIN` 可指定已编译的二进制路径。测试完成后自行删除测试容器。其他历史浏览器测试有独立的 QA 服务/fixture 前提，详见各脚本开头，不要对生产数据库运行 fixture SQL。

## 数据库与身份集成测试

默认 `cargo test` 会跳过 3 项需要数据库的测试。创建独立数据库，用服务端初始化 schema 后，设置 `NEXUS_TEST_DATABASE_URL`：

```bash
NEXUS_TEST_DATABASE_URL='postgres://test_user:test_password@127.0.0.1:5432/nexus_test' cargo test --locked -- --ignored --test-threads=1
```

覆盖旧管理员迁移与会话版本失效、Google OIDC 模拟完整回调/浏览器绑定/重放拒绝、聚合查询与内存设置恢复。`server/tests/fixtures/oidc-test-only.pem` 是测试专用签名密钥，不用于线上认证。

## 镜像构建与发布

单架构本机构建：

```bash
docker build -t nexus:config-test server
docker build -t nexus-agent:config-test agent
```

配置文件版沿用 `:1.0` 镜像标签与 1.0.0 程序版本。发布前运行回归测试、记录旧 digest，并更新迁移说明。多架构构建需要支持 amd64/arm64 的 Buildx builder；`VCS_REF` 必须对应发布源码提交。

```bash
docker buildx build --platform linux/amd64,linux/arm64 --build-arg VCS_REF="$(git rev-parse HEAD)" -t utoptop/nexus:1.0 --push server
docker buildx build --platform linux/amd64,linux/arm64 --build-arg VCS_REF="$(git rev-parse HEAD)" -t utoptop/nexus-agent:1.0 --push agent
docker buildx imagetools inspect utoptop/nexus:1.0
docker buildx imagetools inspect utoptop/nexus-agent:1.0
```

同名发布后还应重新拉取镜像执行新装验收，并核对 `org.opencontainers.image.revision`。旧版回退须同时恢复其环境变量配置。

Agent Docker build 会先运行单元测试再编译 release。服务端测试需要 `tests/` 的测试专用 fixture，发布前在源码环境运行；生产构建上下文排除测试、数据、凭据和历史备份。

## 实际 Docker 日志检查

```bash
docker build -t nexus-agent-bench-fixture agent/tests/performance
cd agent
AGENT_IMAGE=nexus-agent:config-test python3 tests/docker_smoke.py
```

测试只创建自身命名的容器/网络，验证真实 Docker 日志帧、三种访问日志、stdout/stderr、游标重连和 SIGTERM。`tests/performance` 中的旧结果是更名前版本的历史样本，不代表 Nexus 1.0 在任意主机上的容量保证。

## 无环境文件的新装验收

先按上文构建 `nexus:config-test`、`nexus-agent:config-test` 和日志 fixture 镜像，确保 Playwright 与 Chrome 可用，再执行：

```bash
cd server
CHROME_PATH=/path/to/chrome node tests/config-compose-smoke.cjs
```

该脚本复制真实 Compose/TOML 模板，创建独立项目和数据卷，不生成 `.env`，验证数据库密码文件、配置检查、登录、真实探针采集以及两个入口的动态轨迹；结束后仅清理自己的测试资源。可用 `NEXUS_IMAGE` / `AGENT_IMAGE` 指定其他配置文件版测试镜像。

## 3D 地球高清渲染回归

```bash
cd server
DASHBOARD_FIXTURE_PATH=/tmp/observatory-preview.html cargo test --locked render_dashboard_fixture
CHROME_PATH=/path/to/chrome node tests/globe-resolution-browser.cjs
CHROME_PATH=/path/to/chrome node tests/globe-fullscreen-browser.cjs
```

高清回归检查实际画布像素、4K/2K 地表纹理与球面网格，覆盖 Retina、原生 4K、手机、设备像素比变化、WebGL 降级/恢复和隐藏视图停止绘制。默认截图目录为 `/tmp/nexus-artifacts`；可用 `GLOBE_ARTIFACT_DIR` 改写。

桌面 GPU 画布上限为全屏 8294400 / 总览 2073600 像素；手机和低内存设备为 2000000 / 1000000 像素，最高 DPR 2。实际大小还受窗口、GPU 上限和慢帧降载约束。`bufferBytes` 统计纹理（含 mipmap）及绘制缓冲，不包含浏览器管理的 framebuffer/MSAA 内存。


## 访客过滤与地球回放验收

生成最新 dashboard fixture 后，运行 `node server/tests/globe-visitors-browser.cjs`，验证域名精确匹配、浏览器偏好保存、访客滚动位置、内容转义、地球回放/暂停/倍速/跳转/停止以及手机横竖屏控件。

`config-compose-smoke.cjs` 还会向独立数据库写入大小写、URL、端口、相似域名和空域名样例，验证统计、历史、热力和回放在 SQL 聚合及 LIMIT 前过滤，随后用真实探针验证实时过滤、原始日志保留及地球回放。该脚本的服务端镜像必须包含本次更新。
