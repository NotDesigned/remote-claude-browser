# CPA：Claude Code 订阅 API

可选的 CLIProxyAPI（CPA）服务把单独授权的 Claude Code 账号接到兼容 API。浏览器工作台继续运行，CPA 的登录与 Chrome Cookie、工作台用户互相独立。

参考 [ClaudeBox](https://github.com/ArmanJR/claudebox) 的独立容器和持久化凭据思路。本实现运行未修改的 CPA，不调用 ClaudeBox 的 `/prompt`，也不启动 `claude -p` 子进程；流式输出和协议转换由 CPA 完成。CPA 固定为 **8.0.68**，上游镜像摘要写在 `deploy/Dockerfile.cpa`，不跟随 `latest`。

## 地址和身份

单机 HTTPS 部署中，假设 `PUBLIC_HOST=browser.example.com`：

| 用途 | 地址 | 身份 |
| --- | --- | --- |
| 浏览器工作台 | `https://browser.example.com/` | 原工作台用户名、密码 |
| CPA 面板 | `https://browser.example.com/management.html`，或 `/cpa` 跳转 | `.env` 中的 `CPA_MANAGEMENT_KEY` |
| OpenAI 兼容 Base URL | `https://browser.example.com/v1` | `.env` 中的 `CPA_API_KEY` |
| Anthropic 兼容 Base URL | `https://browser.example.com` | 同一 `CPA_API_KEY`；SDK 自行追加 `/v1/messages` |
| 模型列表 | `https://browser.example.com/v1/models` | `Authorization: Bearer <CPA_API_KEY>` |

CPA 面板的服务器地址填 `https://browser.example.com`，不要加 `/v1`。面板页面公开可加载，配置与凭据管理 API 必须带管理密钥；OAuth 回调接口由待完成的 OAuth state/PKCE 流程校验。浏览器工作台的登录 Cookie 不授予 CPA 管理权限。模型 API 和管理 API 使用不同密钥，调用密钥不能管理账号。

纯本机部署不加 HTTPS 文件时，地址改为 `http://127.0.0.1:8317`。宿主机的 `8317` 和 OAuth 回调 `54545` 都只绑定 IPv4 回环，不直接向公网开放。

## 启用

需要已有 `.env`，并设置可用的 `EGRESS_PROXY` 分享链接或 Xray outbound JSON。CPA 不会自动继承浏览器容器中的 TUN。

已有单机 HTTPS 部署，先确认 `.env` 中的文件列表包含：

```dotenv
COMPOSE_FILE=compose.yml:compose.proxy.yml:compose.https.yml
PUBLIC_HOST=browser.example.com
MIRROR_PUBLIC_ORIGIN=https://browser.example.com
```

然后从仓库根目录运行（Node 22.23.1）：

```bash
node scripts/setup-cpa.mjs
docker compose up -d --build cpa caddy
docker compose ps
node scripts/cpa.mjs status
```

脚本在 `.env` 中补充两个不同的随机密钥，并把 `compose.cpa.yml:compose.cpa.https.yml` 追加到文件列表。不会重写现有 VLESS 链接、浏览器密码和资源设置。密钥不会打印到终端，`.env` 保持仅文件所有者可读写。

纯本机、不运行 Caddy 时：

```bash
node scripts/setup-cpa.mjs
docker compose up -d --build cpa
```

也可以显式指定文件，顺序如下；所需环境变量仍从 `.env` 读取：

```bash
docker compose -f compose.yml -f compose.proxy.yml -f compose.https.yml \
  -f compose.cpa.yml -f compose.cpa.https.yml up -d --build cpa caddy
```

`compose.cpa.https.yml` 用 `deploy/Caddyfile.cpa` 替换单机 Caddy 配置，并把 Caddy 接入 CPA 私有网络。以下路径直接交给 CPA，其他路径继续交给浏览器网关：

```text
/v1/*
/management.html
/v0/management/*
/v8/management/*
```

两条反代都配置 `flush_interval -1`，支持 SSE 和 WebSocket。此覆盖文件用于单机 Caddy；双机入口需要把同样路径转发到服务端的 CPA 回环端口，并另建受保护的隧道，原有只转发 `3010` 的隧道不会自动转发 CPA。

## 授权 Claude Code

1. 打开面板，用 `CPA_MANAGEMENT_KEY` 登录。
2. 在 OAuth 登录页选择 Claude，打开 CPA 生成的授权链接，用自己的 Pro/Max 账号完成官方授权。
3. 本机浏览器会回到 `http://localhost:54545/callback`。从其他设备登录，或回环不可达时，把浏览器地址栏中的完整回调 URL 粘贴到 CPA 面板的手动回调入口。
4. 确认授权文件出现、账号状态正常，然后执行 `node scripts/cpa.mjs status` 查看可用模型。

也可以用 CLI 生成同一授权链接：

```bash
node scripts/cpa.mjs login
node scripts/cpa.mjs login-status '<返回的 state>'
```

回调 URL 包含一次性授权码，应提交给 CPA，不要放入仓库、日志或聊天记录。初次未授权时，健康检查通过、模型列表为空是正常状态；这还不能证明上游推理可用。

## 客户端调用

在客户端中配置上表对应的 Base URL 和 `CPA_API_KEY`。初始配置关闭模型列表的名称伪装，避免 Anthropic 列表中的别名无法用于 OpenAI 兼容接口。模型名从 `/v1/models` 获取，不在配置里假定某个模型始终可用。常见接口包括：

```text
GET  /v1/models
POST /v1/messages
POST /v1/chat/completions
POST /v1/responses
```

Claude Code 订阅额度与浏览器会话容量无关。`MIRROR_CLIENTS=16` 不代表订阅允许 16 路 API 并发；限额和可用模型仍由上游决定。此部署保留 CPA 原有兼容行为，不额外注入自定义伪装参数，也不保证免风控。订阅授权是否适用于具体用途，应参考 [Anthropic 的当前说明](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account)。

## 出口与资源

```text
客户端 → Caddy → CPA（私有网络）→ Xray SOCKS → EGRESS_PROXY → 上游
```

- CPA 只连接 Docker 的 internal 网络，没有直接互联网路由。`cpa-egress` 同时连接私有网和出口网，以 TCP SOCKS 提供出站。代理停用时请求失败，不会改成 CPA 直接连接上游。
- 宿主机的两个回环端口由 `cpa-egress` 原样转发到 CPA，兼容 Docker Desktop 的宿主 NAT 回程；CPA 本身不因此取得外网路由。公网 Caddy 则直接从私有网络访问 CPA。
- 该 SOCKS 端口不发布到宿主机；其目的地址规则拒绝私有网段、云元数据地址及 `EGRESS_BLOCK`。域名通过 Xray 的 DoH 解析，只有代理节点自身的域名使用 `EGRESS_BOOTSTRAP_DNS`。
- `cpa` 以 UID 10003、`cpa-egress` 以 UID 10002 运行，均无 Linux capabilities、根文件系统只读。一次性 `cpa-init` 只负责初始化卷和权限，不接网络。
- CPA 默认内存与内存加 Swap 均为 `512m`，CPU 上限 `1`；独立 Xray 的内存与总内存均为 `128m`，CPU 上限 `0.5`。这些是容器上限，不是实测占用，不占用浏览器容器原有的内存配额。
- 请求全文日志和调试日志默认关闭。错误日志写入受保护的临时文件系统，容器重建后清除。

## 配置持久化、升级和密钥

三个独立命名卷：

| 卷 | 容器路径 | 内容 |
| --- | --- | --- |
| `cpa-config` | `/config` | CPA 的运行配置；面板中的设置保存到这里 |
| `cpa-auth` | `/auth` | OAuth 登录资料和 CPA 的持久状态；按密钥备份保护 |
| `cpa-static` | `/static` | 官方面板的 `management.html`；首次访问下载，后续不自动更新 |

普通初始化和重启保留已有配置，所以在面板中修改后，卷内配置是运行时依据；修改 `.env` 中的两个 CPA 密钥不会自动覆盖已有配置。需要按 `.env` 重新初始化配置时，执行：

```bash
docker compose stop cpa
docker compose run --rm --no-deps cpa-init init --force
docker compose up -d cpa
```

这会重置面板设置和调用密钥，但保留 `cpa-auth` 内的 OAuth 文件。执行前先备份配置。初始配置采用 JSON（合法 YAML），CPA 后续可能将其保存为 YAML。

升级时先审查 `deploy/Dockerfile.cpa` 的版本和摘要，再构建并运行验收：

```bash
docker compose build cpa cpa-egress
pnpm smoke:cpa
docker compose up -d cpa caddy
```

备份前停 CPA，再备份项目的 `cpa-config`、`cpa-auth` 卷；不要只备份 `.env`。命名卷带有 Compose 项目前缀，可用 `docker compose config --volumes` 与 `docker volume ls` 核对。不要在保留登录状态时使用 `docker compose down -v`。

## 检查和关闭

```bash
docker compose ps
docker compose logs --tail=50 cpa cpa-egress
node scripts/cpa.mjs status
pnpm smoke:cpa
```

`smoke:cpa` 使用独立项目、模拟上游和临时凭据，检查 Caddy 路由、管理/API 鉴权、Messages、Chat Completions、SSE、直连阻断、代理中断和配置重启保留；不使用真实订阅账号。测试结束会删除自己的容器和卷。

暂停：`docker compose stop cpa cpa-egress`。彻底关闭 CPA 入口时，从 `.env` 的 `COMPOSE_FILE` 移除两个 CPA 文件，执行 `docker compose up -d --no-deps caddy` 恢复原 Caddy 路由；再执行 `docker compose up -d --remove-orphans` 清理停用的服务，保留命名卷供以后恢复。
