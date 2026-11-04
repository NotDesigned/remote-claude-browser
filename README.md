# Remote Claude Browser

通过服务器 A 的网页操作服务器 B 上的 Claude 浏览器。需求见 [requirement.md](requirement.md)。

本项目基于 [Remote Browser](https://github.com/mystxcal/remote-browser) 修改，固定上游版本记录在 [UPSTREAM_COMMIT](UPSTREAM_COMMIT)，原始介绍保留在 [UPSTREAM.md](UPSTREAM.md)。

## 实际部署

- **A**：Caddy 提供 HTTPS，SSH 隧道将请求转发到 B 的本机端口；A 不运行 Claude 页面。
- **B**：独立非 root 用户运行 Chromium、页面采集与控制 Agent，保留浏览器沙箱。
- **客户端**：接收受约束的 DOM 或文本增量，不执行 Claude 原始脚本；登录态留在 B。
- 浏览器控制使用进程内 CDP 管道，不开放公网 CDP；B 的 Agent 监听 `127.0.0.1:3010`。
- B 的 Profile 位于 `/var/lib/claude-browser/profile`，部署替换运行目录时保留它。

隐私目标是将站点可观察的浏览器环境迁移到 B；这不保证匿名，也不保证通过站点验证。

## 使用

1. 打开 <https://claude.example.com>，输入本项目的访问密码。
2. 网页自动分配一个独立会话并打开 Claude，复用 B 的登录状态；需要时在远程页面手动登录。
3. 顶部的“聊天 / 页面 / 画面”在同一页面内切换视图：日常用“聊天”；登录、设置等网页操作用“页面”。
4. 登录、验证码或复杂页面显示不全时，切到“画面”查看 B 的实际浏览器图像并手动操作，完成后切回即可；所有视图共用 B 上同一会话。

访问密码由 **B 的 `/etc/claude-browser/agent.env`** 中的 `MIRROR_ACCESS_PASSWORD` 控制；A 上的同名文件是维护脚本使用的副本。它与 Claude 账户密码不同；不要把该文件提交到仓库。

更改密码时，在 A 上执行 `ssh -t remote-server 'sudoedit /etc/claude-browser/agent.env'`，修改 `MIRROR_ACCESS_PASSWORD`，再执行 `ssh remote-server 'sudo systemctl restart claude-browser'` 生效。同步更新 A 的同名文件，供部署和诊断使用。重启保留 Claude Profile，但会中断当前远程页面，请先处理未发送的草稿。

只改密码不会撤销已记住的访问设备。如需所有设备重新输入密码，同时为 B 的 `MIRROR_ACCESS_SECRET` 设置新的随机值，再重启；A 的维护副本也应同步。可在终端执行 `openssl rand -hex 32` 生成该随机值。无需更改 `MIRROR_AUTH_SECRET` 或清除 Claude Profile。

当前最多分配 **16 个独立会话**。其他客户端直接访问同一入口，同一设备打开多个窗口会分别占用会话名额，在线客户端数按设备统计。各自拥有独立窗口、标签页、输入、滚动、视口和视图模式。同一会话新打开的页面自动接管，旧页面停止输入与重连并显示提示。

资源状态在右上角 ⋯ 菜单的“服务状态”里：在线设备数（按设备统计）、会话占用／16（含等待回收的离线会话）、CPU（按 B 全部逻辑核折算为 0–100%）、内存（整机用量／总量）和延迟。数据超过 10 秒未更新时显示为“—”。名额已满或内存紧张时，顶部会出现提示条。

关闭网页后无需手动释放：断开全部连接后保留约 60 秒以便刷新与重连，随后自动关闭远程窗口并回收名额；正在生成回复时暂缓，完成后回收。“结束会话”用于立即释放。重开已回收的页面会重新申请自己的会话。所有会话共用当前 Claude 账号，历史、设置、额度及退出登录仍会相互影响；任一会话登录或刷新令牌后，约 5 秒内同步到共享存储和所有已打开的会话，停在登录页的会话会自动回到 Claude；Chrome 进程故障与整体资源争用也仍共享。

会话准入按 B 的实际 cgroup 内存硬上限计算，预留至少 300 MiB 或配额的 10% 给新页面。整机可用内存低于 256 MiB 时也会提示资源紧张。16 路真实长对话与生成负载的峰值尚未压测。

各会话可同时使用图像模式。图像编码按会话独立登记和释放，切回其他视图、关闭远程页、切换标签页或断开全部观看连接后停止该会话的采集。

页面和画面视图默认显示标签栏和地址栏，可在标签栏右侧或 ⋯ 菜单隐藏；隐藏后顶栏显示紧凑的后退、刷新和网址，远端打开新窗口时标签栏自动出现。⋯ 菜单还可以另开独立会话、结束本会话、切换外观（跟随系统／浅色／深色）。

聊天草稿按会话保留在本机；操作结果未知时不会自动重发，应先核对远端页面。页面显示正在同步时，等待同步完成再输入。

两种页面均支持本机中文输入法。图像模式先点击远端输入框，再切换本机输入法；候选窗口在本机显示，确认后的完整文本写入 B。操作者在文字页面使用本机系统光标，观看者仍可看到远端回放光标。

地址栏右侧 `RTT` 是客户端经 A 到 B 网关的网络往返采样，不包含网页执行和回放。展开后显示实际采用的 DOM 回放缓冲；图像模式不使用此缓冲。

网关连通与网页进程健康分别检查。网页崩溃时会清除旧缓存、丢弃待处理输入，并在原标签页自动重载。一分钟内最多自动恢复两次，失败后显示刷新提示。图像模式启动及首帧均有时限，缺首帧时只补一次受限截图，失败自动退回 DOM。B 设置 `MIRROR_CLIENTS=16`，每个会话首次打开 `MIRROR_START_URL=https://claude.ai/new`，保留原 Profile。会话登记存于 Profile 下的 `client-sessions.json`，需要稳定的 `MIRROR_AUTH_SECRET` 维持设备身份。

当前 B 设置 `MIRROR_CANVAS_SNAPSHOTS=0`，关闭采集器可选的画布位图 Worker，避免其临时 Blob 资源初始化触发 Chrome 的来源校验崩溃。图标字体、DOM 和原生图像模式不依赖该 Worker；复杂画布请使用图像模式。

图像模式的清晰度在 ⋯ 菜单选择，按设备记住：高（最大 2560×1440，JPEG 质量 80，每 2 帧取 1 帧，默认）、中（1600×900，质量 65，每 2 帧取 1 帧）、低（960×540，质量 50，每 3 帧取 1 帧）。帧以二进制 JPEG 传输，并按客户端确认控制在途帧数，网速慢时显示最新画面而不是积压旧帧。

## 单核 A 的资源约束

CPU 百分比按一个逻辑 CPU 计算，内存额度覆盖所在 cgroup 的所有子进程。

| 主机与范围                 | CPU 上限       | 内存硬上限 |
| -------------------------- | -------------- | ---------- |
| A：`claude.slice` 项目合计 | 50%            | 1 GiB      |
| A：维护任务                | 35%            | 960 MiB    |
| A：SSH tunnel              | 15%            | 64 MiB     |
| B：浏览器与显示合计        | 380%（3.8 核） | 3584 MiB   |
| B：浏览器及 Agent          | 350%（3.5 核） | 3328 MiB   |
| B：Xvfb 显示               | 20%            | 128 MiB    |

B 已升级为 4 个逻辑 CPU、4 GB 内存，浏览器的内存软上限为 3072 MiB，浏览器与显示合计软上限为 3328 MiB。各会话共用这份资源预算，新增会话仍需通过内存准入检查。

维护入口为 [scripts/limited-run.sh](scripts/limited-run.sh)：通过 systemd 施加总额度，并用 `flock` 串行。构建及测试设置单 worker，维护进程降低调度优先级。不要在 A 直接启动上游完整 CI 或并行浏览器验收。

维护任务的线程及进程合计上限为 256，项目合计为 320；旧的 128/192 上限会阻止测试 Chromium 创建必要线程。CPU 和内存额度仍按上表限制。

## 构建、测试与部署

前置条件：A 安装 Node 22.23.1 以上的 22.x、pnpm 9.15.9、systemd、Caddy，并可通过 `ssh remote-server` 连接 B。B 已安装 Node 22、Chrome、Xvfb、ffmpeg（画面模式的 H.264 编码，缺失时退回 JPEG）、字体及网络隔离工具，准备好非 root 服务用户、Profile 目录和 `/etc/claude-browser/agent.env`。

首次使用维护入口前，在 A 安装资源 slice：

```sh
install -m 644 deploy/remote/claude.slice deploy/remote/claude-maintenance.slice /etc/systemd/system/
systemctl daemon-reload
bash scripts/limited-run.sh pnpm install --frozen-lockfile --child-concurrency=1
```

日常命令均经过资源限制，按顺序执行：

```sh
pnpm build
pnpm typecheck
pnpm test
bash deploy/remote/deploy.sh
```

`pnpm test` 仅运行单元测试，不自动启动浏览器。以下端到端测试仅手动、受限执行：

```sh
pnpm test:semantic
pnpm test:remote
```

浏览器测试需要单独准备测试 Chromium。`test:remote` 会控制已部署的远端会话并导航测试页面，只应在未使用正式会话时执行。

`bash scripts/limited-run.sh pnpm exec tsx scripts/renderer-recovery-smoke.mts` 仅在 A 的临时浏览器中模拟网页崩溃，验证原标签页恢复及恢复后的图像帧，不连接正式会话。

`bash scripts/limited-run.sh pnpm exec tsx scripts/input-latency-smoke.mts` 使用一个临时 Chromium 中的两个本地测试页面，验证本机光标，以及两种视图将“分析AI问题”和后续原生中文完整输入到测试远端；不连接正式会话。`scripts/latency-probe.mjs` 仅被动采样 A 到 B 网关的 RTT 与事件频率，不发送控制输入。

`bash scripts/limited-run.sh pnpm exec tsx scripts/two-client-smoke.mts` 使用一个临时 Chrome 和两个客户端，验证输入、视口、模式、弹窗、下载、剪贴板、跨会话拒绝、重连及名额复用，不连接正式 Claude。前端会话流程另由 `scripts/client-ui-smoke.mjs` 验证。

部署脚本在 A 构建并打包，将版本化运行目录放入 B 的 `/opt/claude-browser/releases/`，更新 `current` 链接并重启服务。HTTPS 站点配置参考 [deploy/remote/Caddyfile](deploy/remote/Caddyfile)，应合并到现有 Caddy 配置。

## 状态与排查

```sh
# A：入口和隧道
systemctl status caddy claude-tunnel --no-pager
journalctl -u claude-tunnel -n 30 --no-pager
systemctl show claude.slice -p CPUQuotaPerSecUSec -p MemoryCurrent -p MemoryMax
curl --fail https://claude.example.com/healthz

# B：浏览器和虚拟显示
ssh remote-server 'systemctl status claude-browser claude-display --no-pager'
ssh remote-server 'journalctl -u claude-browser -n 30 --no-pager'
```

资源配置位于 [deploy/remote](deploy/remote)。达到额度后任务会变慢或失败，应查看服务状态与日志，不要通过移除额度重试。

## 验证状态与授权

受控测试覆盖文本差分、持久化操作回执、独立会话、并发图像和无需导航的连续标题更新。生产 Chromium 验收覆盖真实 Claude 的中文发送、公式、流式同步、停止生成、草稿恢复、附件读取、文件下载、历史切换，以及 DOM 选区替换、发送清空和本机剪贴板。记录保存在 `artifacts/`。

文字聊天体验诊断使用已构建的界面与本地模拟服务，运行 `bash scripts/limited-run.sh pnpm exec tsx scripts/native-chat-audit.mjs`，结果保存到 `artifacts/native-chat-audit.json`。它覆盖跨对话草稿、前置条件冲突、流式选区与滚动、手机入口、结构化文本和页面恢复生命周期。公式渲染耗时包含 A 的限额调度影响，缓存恢复探针使用模拟生命周期事件。生产测试中的请求确认、首段回复、空闲轮询和资源样本保存在 `artifacts/native-chat-production-smoke.json`。

WebKit 26.0 的生产触屏验收通过匿名模式切换、模型菜单、编辑器聚焦、中文输入、发送按钮激活和提交内容一致性检查。用户已确认 iPhone 上的匿名切换与输入后发送按钮正常。较新的 Linux WebKit 测试进程在匿名模式切换后原生崩溃，该引擎的完整回归仍未通过。16 会话满负载压测仍待完成。

保留上游 Apache-2.0 授权及第三方声明：[LICENSE](LICENSE)、[NOTICE](NOTICE)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。上游安全边界见 [docs/security.md](docs/security.md)。
