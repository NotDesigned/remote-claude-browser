# 参与开发

> 读者：改代码的开发者和发布版本的维护者

小而可测、带来明确兼容性或部署收益的改动最容易审阅。漏洞请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。

## 开发环境

使用 Node 22.23.1（`.nvmrc`）和 pnpm 9.15.9：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

`package.json` 里的每个脚本都经过 `scripts/limited-run.sh` 运行。装了 `deploy/remote/` 里 `claude-maintenance.slice` 的主机上，它用 `systemd-run` 限制 CPU、内存和并发，并加一把项目锁；其他机器（笔记本、CI）上直接运行命令。在资源紧张的主机上启用这些限制：

```bash
install -m 644 deploy/remote/claude.slice deploy/remote/claude-maintenance.slice /etc/systemd/system/
systemctl daemon-reload
```

达到限额时任务会变慢或失败，查看日志，不要去掉限额重试。

### 本地运行

根目录的 `pnpm dev` 只启动查看器（Vite，`127.0.0.1:5173`），它把 `/ws`、`/s/`、`/api/`、`/gate`、`/logout` 转发给 `http://127.0.0.1:3000` 上的网关。网关要另开一个终端启动：

```bash
# 终端 1：网关，默认监听 127.0.0.1:3000（GATEWAY_HOST、GATEWAY_PORT）
MIRROR_E2E=1 CHROME_PATH=/path/to/chrome pnpm --filter @mirror/gateway dev
# 终端 2：查看器
pnpm dev
```

网关依赖 `pnpm build` 生成的注入脚本，改了 `packages/agent` 后要重新构建。没有设置 `CHROME_USER_DATA_DIR` 时，浏览器数据放在临时目录。

不接入出口运行时，浏览器配置在正式模式下打不开（`409 EXIT_REQUIRED`）。`MIRROR_E2E=1` 允许不绑定节点直接打开，但同时**关闭全部访问控制**，只能用于本机开发；`NODE_ENV=production` 时网关拒绝启动。要连同出口和 CPA 一起调试，用 Docker：

```bash
docker compose -f compose.yml -f compose.runtime.yml up -d --build
```

变量的含义见 [docs/configuration.md](docs/configuration.md)。

## 测试

| 命令                                            | 内容                                                                                                                                                                     | 需要                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `pnpm run ci`                                   | rrweb 版本检查、构建、类型检查、`pnpm test`、`test:rtc-media`、`test:browser-lifecycle`、`format:check`                                                                  | `CHROME_PATH`                                                                                               |
| `pnpm test`                                     | 各包单元测试和 `test:deployment`                                                                                                                                         | —                                                                                                           |
| `pnpm test:deployment`                          | `deploy/` 下的辅助脚本：时区、出站代理、Xray 下载、CPA 迁移、`cpa-broker`、`profile-broker`                                                                              | —                                                                                                           |
| `pnpm test:users-ui`                            | 「管理后台」的用户、会话和资源，本地模拟服务                                                                                                                             | 先构建查看器，`CHROME_PATH`                                                                                 |
| `pnpm test:network-ui`                          | 「代理与 API」：代理来源、CPA 授权和 Key、手机布局，本地模拟接口                                                                                                         | 先构建查看器，`CHROME_PATH`                                                                                 |
| `pnpm test:profiles-ui`                         | 配置选择页：新建、恢复、状态刷新和手机布局                                                                                                                               | 先构建查看器，`CHROME_PATH`                                                                                 |
| `pnpm test:profiles-webkit`                     | 同上，用 WebKit 运行                                                                                                                                                     | Playwright WebKit 及其运行依赖                                                                              |
| `pnpm test:browser-lifecycle`                   | 跨站前进、后退和快照恢复                                                                                                                                                 | `CHROME_PATH`                                                                                               |
| `pnpm test:rtc-media`                           | 页面模式里视频的 canvas-WebRTC 媒体通道                                                                                                                                  | `CHROME_PATH`                                                                                               |
| `pnpm test:pixel-ui`                            | 画面模式的界面：切换视图、缩放和工具栏，本地模拟服务                                                                                                                     | 先构建，`CHROME_PATH`                                                                                       |
| `pnpm test:mobile-input`                        | 手机上的触摸、滚动、拖动和画面模式的平移，本地模拟服务                                                                                                                   | 先构建，`CHROME_PATH`                                                                                       |
| `pnpm probe:oopif`                              | 跨站子框架的目标生命周期和 rrweb 映射，确认 Chrome 的行为仍符合实现的假设                                                                                                | 先构建，`CHROME_PATH`                                                                                       |
| `pnpm check:compose`                            | 对部署文档列出的每个 compose 组合执行 `docker compose config`                                                                                                            | Docker Compose                                                                                              |
| `pnpm smoke:compose`                            | 用 `compose.yml` 和 `compose.runtime.yml` 构建全部镜像并做端到端检查（沙箱、防火墙、CPA 实例的隔离、经真实登录的页面镜像）；`SMOKE_HOSTNET=1` 改测 `compose.hostnet.yml` | Docker；Docker 使用 AppArmor 时先 `sudo scripts/install-apparmor.sh`；设置 `CHROME_PATH` 时还会真实登录一次 |
| `pnpm smoke:browser-filesystem`                 | 浏览器的文件系统边界：私有 `/proc` 和显示、只读挂载、拒绝符号链接和别人的目录                                                                                            | Docker，`SERVER_IMAGE` 选择镜像                                                                             |
| `pnpm smoke:profile-egress`                     | 按配置的 Mihomo 出口：HTTP/UDP/DNS、断流阻断、私有 CDP；`PROFILE_EGRESS_STOCK_CPA=1` 时加一次 CPA 推理请求                                                               | Docker，`PROFILE_EGRESS_MIHOMO` 指向固定版本的 Mihomo，`PROFILE_EGRESS_SMOKE_IMAGE` 选择镜像                |
| `pnpm smoke:cpa-tenancy`                        | 两个临时 CPA 实例之间的凭据和 Key 隔离、按凭据的代理和时区                                                                                                               | Docker，先构建 CPA 引擎镜像（见下）                                                                         |
| `bash scripts/proxy-smoke.sh`                   | `compose.proxy.yml` 的 Xray TUN、UDP、断流阻断和重启；`PROXY_SMOKE_HOSTNET=1` 改测主机网络                                                                               | Docker                                                                                                      |
| `node --test examples/caddy/ingress.test.mjs`   | 用固定版本的 Caddy 解析两个入口示例                                                                                                                                      | Docker                                                                                                      |
| `pnpm check:fingerprint [镜像] [配置数]`        | 用临时容器新开几个浏览器配置，查看指纹网站的判定                                                                                                                         | Docker，正在运行的服务端                                                                                    |
| `pnpm check:host`                               | 检查 Docker、Compose v2、Docker API 版本、用户命名空间和 AppArmor 配置文件                                                                                               | —                                                                                                           |
| `pnpm audit:prod`                               | 生产依赖的高危漏洞                                                                                                                                                       | —                                                                                                           |
| `pnpm test:remote`                              | 控制一个已部署的远程会话并打开测试页面；只在没有人使用正式会话时运行                                                                                                     | 正在运行的服务端                                                                                            |
| `scripts/*-smoke.mts`（`pnpm exec tsx <脚本>`） | 渲染进程崩溃恢复、输入延迟和中文输入、两个客户端并发等，用临时浏览器，不连接正式会话                                                                                     | `CHROME_PATH`                                                                                               |

查看器的构建命令是 `pnpm --filter @mirror/viewer... run build`。CPA 引擎镜像：

```bash
docker build -f deploy/Dockerfile.cpa --target cpa -t remote-claude-browser-cpa:local .
```

CI 的完整步骤见 `.github/workflows/ci.yml`。

## 改动准则

- 保留语义 DOM 路径，不要换成纯画面的远程桌面。
- 保持 CDP 私有，Chromium 沙箱保持开启。
- 所有 `@rrweb/*` 包用同一个精确版本。
- 行为改动要配确定性的单元测试或测试夹具。
- 宁可发新快照、做有上限的恢复，也不要无上限的队列或脆弱的修补逻辑。
- 不要提交真实凭据、私人页面截图、浏览器配置数据或下载的文件。
- 只格式化你改过的文件：`pnpm exec prettier --write <文件>`。`pnpm format` 会改动整个仓库。

## 文档

文档和代码在同一个 PR 里改。规则、每个主题归哪个文件、术语表见 [docs/documentation.md](docs/documentation.md)。提交前运行 `pnpm docs:check`。

## Pull request

说明要解决的问题、选择的边界、验证用的命令，以及安全或兼容性上的取舍。无关的重构分开提交。PR 模板里的「影响的文档」必填。

提交贡献即表示你同意按 Apache License 2.0 授权。

## 发布

发布 PR 要逐项勾选以下各项。

### 版本和记录

- [ ] 根目录和 `packages/*` 的每个 `package.json` 版本号、git tag（`vX.Y.Z`）和 `CHANGELOG.md` 标题三处一致。
- [ ] `CHANGELOG.md` 把「未发布」改成新版本和日期，四节（新增 / 变更 / 移除 / 升级步骤）都写全，并更新文件末尾的链接：`[未发布]` 比较新 tag 到 `HEAD`，新增新版本的 tag 链接。
- [ ] 接口有变化时，CHANGELOG 写明需要的 remote-cc 版本，[docs/remote-cc.md](docs/remote-cc.md) 的「兼容性」一节同步更新。
- [ ] `docs/documentation.md`「对外锚点」列出的锚点都还在，指向 remote-cc `main` 分支的链接都能打开。
- [ ] [docs/deployment.md](docs/deployment.md) 的升级、备份、清除数据和回退说明与这个版本一致。

### 质量

- [ ] Node 和 pnpm 版本在 `package.json`、`.nvmrc` 和 CI 里一致。
- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm audit:prod`
- [ ] `CHROME_PATH=/path/to/chrome pnpm run ci`
- [ ] `pnpm docs:check`
- [ ] [docs/deployment.md](docs/deployment.md#可用的-compose-组合) 列出的每个 compose 组合都能通过 `docker compose config`，`client/compose.yml` 也一样。
- [ ] `pnpm smoke:compose`、`pnpm smoke:profile-egress`、`pnpm smoke:cpa-tenancy`、`bash scripts/proxy-smoke.sh`、`node --test examples/caddy/ingress.test.mjs`
- [ ] 在干净的 Linux Docker 主机上照 [README 快速开始](README.md#快速开始)原文走一遍，能打开一个浏览器配置。
- [ ] 开发模式（`pnpm dev` 加网关）和生产镜像都能启动，`/healthz` 返回 `"browser":true`。
- [ ] 重建服务端容器后，浏览器配置和用户都还在。

### 安全和许可

- [ ] 密钥扫描覆盖工作区和发布历史中的每个提交。
- [ ] 示例只用占位符。
- [ ] CDP 没有对外发布，Chromium 仍以非 root 用户运行并开启沙箱。
- [ ] 测试产物里没有私人页面数据。
- [ ] 改动的工作树是有意的，没有内部日志、调研截图、浏览器配置、下载、凭据或私人路径。
- [ ] `LICENSE`、`NOTICE` 和 `THIRD_PARTY_NOTICES.md` 是最新的：其中的版本与 `deploy/fetch-*.mjs`、`deploy/Dockerfile.cpa`、`scripts/setup-fingerprint.sh` 里固定的版本一致，新依赖的许可证已确认并写进 lockfile。

### 打 tag

- [ ] 发布提交上的 CI 全部通过。
- [ ] 推送 tag 后，`Images` 工作流发布了 `remote-claude-browser-server` 和 `remote-claude-browser-tunnel` 两个镜像；记下镜像对应的源码提交。
- [ ] 发布说明里包含已知限制和升级步骤（链接到 CHANGELOG）。
