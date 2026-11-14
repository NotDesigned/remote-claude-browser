# CPA：按用户管理的订阅 API

可选的 CLIProxyAPI（CPA）把独立授权的 Claude Code 账号接到兼容 API。工作台内的 CPA 实例按用户隔离：每个专用实例使用自己的配置、OAuth 凭据和持久卷；浏览器 Cookie 不会自动变成 CPA 授权。

本实现运行未修改的 CPA，不调用 ClaudeBox 的 `/prompt`，也不启动 `claude -p` 子进程；流式输出和协议转换由 CPA 完成。CPA 固定为 **8.0.68**，上游镜像摘要写在 `deploy/Dockerfile.cpa`，不跟随 `latest`。

## 在工作台里使用

1. 打开右上角或配置选择页中的「代理与 API」，切换到「CPA 授权与 Key」。
2. 创建自己的 CPA 实例并启动。每个用户最多一个专用实例；管理员还可以建立一个共享实例。共享实例的启动、授权凭据和 Key 由管理员管理，普通用户只能查看其状态。
3. 在「添加 Claude 授权」中，代理默认选中当前浏览器配置绑定的出口，也可手动选择其他可用节点；没有当前配置或配置未绑定可用节点时，必须先选择节点，不能使用部署默认出口。生成授权链接，在新页面完成 Claude OAuth。回调到本机地址不可达时，把完整回调 URL 或授权码粘贴回面板，再检查授权状态。
4. 授权成功后，在凭据列表中分别选择代理节点，或停用、启用、删除该凭据。新授权会保存本次所选节点；后续每个凭据的代理与浏览器配置独立设置，不会因浏览器切换出口自动改变。
5. 生成外部 API Key。完整 Key 只显示这一次，保存后再关闭面板；列表只显示前缀，可随时撤销。

新 Key 以 `rcpa_` 开头；迁移导入的旧 Key 保持原值。工作台网关按 Key 摘要查询归属，路由到唯一 CPA 实例：

| 用途 | 地址与认证 |
| --- | --- |
| OpenAI 兼容 Base URL | `https://browser.example.com/v1`，使用生成的 Key |
| Anthropic Messages | `https://browser.example.com/v1/messages`，支持 Bearer 或 `x-api-key` |
| 模型列表 | `GET https://browser.example.com/v1/models`，使用同一 Key |
| 工作台管理 API | `/api/cpa/instances/*`，使用工作台登录 Cookie |

工作台登录用于管理；外部 Key 用于模型调用。不同实例的外部 Key 不能管理凭据，也不能调用其他实例。浏览器网页登录、Claude Code OAuth 和外部调用 Key 是三种独立身份。

## 启用按用户实例

在浏览器服务的 Compose 文件列表中增加 [`compose.runtime.yml`](../compose.runtime.yml)。全新部署可以使用：

```bash
docker compose -f compose.yml -f compose.runtime.yml up -d --build
```

长期使用时把相同文件列表保存到 `.env` 的 `COMPOSE_FILE`。已有部署应在现有文件列表后追加 `compose.runtime.yml`，保留已有的出站、入口和私有覆盖文件。浏览器配置必须明确绑定节点，未分配时不能打开；CPA 新增授权和修改凭据出口同样要求明确的节点；实例内部启动和既有未绑定凭据仍保留原部署出站配置，不自动迁移已有绑定。已有 `EGRESS_PROXY`/`compose.proxy.yml` 不需要迁走。

用户 CPA 模块需要 Docker bridge 网络，不兼容 `compose.hostnet.yml`。已有主机网络部署应先由部署者移除该覆盖文件、确认 bridge 下的端口和媒体连接，再追加运行时模块；公网入口仍可由同机或独立 VPS 管理。

这个覆盖文件增加两个运行时边界：

- 浏览器服务内的 root broker 提供固定的浏览器和 Mihomo 网络操作；网关与 Chrome 仍以非 root 用户运行。配置绑定节点后，在专用网络命名空间内运行浏览器及对应 Mihomo 出口。
- 独立 `cpa-broker` 通过固定模板建立 CPA 容器，只有它挂载 Docker socket。工作台通过 Unix socket 请求实例操作，不能提交任意 Docker 参数。CPA 实例只连接 internal 网络，经认证的运行时代理访问外网。

浏览器数据仍在原 `data` 卷。运行时不会把旧单独 CPA 的 OAuth 文件自动导入某个用户；原服务可以保持运行，新的用户实例独立授权。

公网入口正常转发整个浏览器服务即可，包括 `/api/cpa/instances/*` 和 `/v1/*`。不必对外发布 CPA 管理端口或 Docker socket。同机及独立 VPS 的入口示例见 [`examples/caddy/`](../examples/caddy/README.md)。

### 旧独立 CPA 的入口与迁移

尚未迁移时，原 `compose.cpa.yml`/`compose.cpa.https.yml` 可继续使用。兼容模板 `compose.runtime.https.yml` 按 `rcpa_` 前缀把新 Key 的 `/v1/*` 请求交给工作台，其他调用及旧管理面板继续交给旧 CPA。

迁移应先明确旧数据属于哪个工作台用户，再建立或检查该用户的私有实例；管理员私有实例与共享池是不同目标。一起备份工作台数据库、旧配置及授权卷，停止旧实例的写入后复制授权，已有目标授权发生冲突时先处理冲突。

`deploy/cpa-migration.mjs` 的 `mergeCpaMigrationConfig(legacy, target)` 保留旧业务配置，包括路由、上游、日志和模型/API 配置；目标实例保留自己的服务监听、内部调用与管理密钥、授权目录和运行时代理地址。旧外部调用 Key 通过内部的 `store.importKey(instanceId, name, token)` 登记摘要，原 Key 不变；重复导入同实例保持幂等，跨实例冲突会拒绝。该导入方法没有公开 HTTP 接口。

迁移完成后，入口应把整个 `/v1/*` 转给工作台，让网关查询 Key 归属；继续按前缀分流会把导入的旧 Key 错送到旧实例。旧管理面板仍可单独保留，迁移验收后再停旧 CPA。已有本机证书或自定义 Caddyfile 时，只调整对应路由并保留证书路径和传输设置。

## 工作台管理 API

所有路径都要求工作台登录；权限由实例和代理来源的所有者决定。共享实例管理仅限管理员。客户端不会取得实例内部管理密钥、订阅地址或节点密码。

```text
GET    /api/cpa/instances
POST   /api/cpa/instances                         {scope: "user" | "shared"}
POST   /api/cpa/instances/:id/start
POST   /api/cpa/instances/:id/stop
GET    /api/cpa/instances/:id/credentials
PATCH  /api/cpa/instances/:id/credentials/status   {name, disabled}
PATCH  /api/cpa/instances/:id/credentials/proxy    {name, proxyId: string}
DELETE /api/cpa/instances/:id/credentials?name=…
POST   /api/cpa/instances/:id/oauth                {provider: "claude", proxyId: string}
GET    /api/cpa/instances/:id/oauth/status?state=…
POST   /api/cpa/instances/:id/oauth/callback       {state, code? | redirectUrl?}
GET    /api/cpa/instances/:id/keys
POST   /api/cpa/instances/:id/keys                 {name}
DELETE /api/cpa/instances/:id/keys/:keyId
```

实例列表只返回状态与可管理标识。生成 Key 的响应含一次性 `token`，后续列表不再返回完整值。已有凭据返回 `proxyId: null` 表示尚未绑定目录节点，可能仍使用迁移前的部署出口；新增授权和修改凭据出口不再接受空值或 `deployment-default`。

## 持久化与验收

`data` 卷中的 `/data/profile/cpa.sqlite` 保存实例归属、内部连接密钥、外部 Key 摘要和凭据代理绑定；`/data/runtime/secret` 保存内部出口令牌的生成密钥。这些文件与浏览器资料一起受保护备份，恢复时保留 `/data/runtime` 的 root:root、0700 和密钥文件的 root:root、0600。每个动态实例还有三个独立卷，名称形如 `remote-browser-<instanceId>-config`、`-auth`、`-static`，其中实例 ID 以 `cpa-` 开头；实际名称以 `docker volume ls` 为准。停实例保留这些卷。备份时一起保存工作台元数据与 CPA 配置、授权卷，只有一个部分不足以恢复原实例。

先构建 CPA 引擎镜像，再执行不使用真实账号的隔离验收：

```bash
docker build -f deploy/Dockerfile.cpa --target cpa -t remote-claude-browser-cpa:local .
bash scripts/limited-run.sh env CPA_TENANCY_SMOKE=1 node scripts/cpa-tenancy-smoke.mjs
```

该测试创建自己的两个临时 CPA 实例、独立卷及 internal 网络，检查凭据/Key 隔离、每凭据代理修改和 OAuth 路由，结束后清理自己的容器与卷。它不使用正式订阅账号，也不能证明真实上游推理成功。设置 `CPA_BROKER_ENGINE_IMAGE` 可选择测试引擎镜像。

前端使用 `bash scripts/limited-run.sh node scripts/network-ui-smoke.mjs` 验收本地模拟接口下的来源管理、CPA 授权和 Key 操作、320px 手机布局；不会访问真实订阅。

## 兼容：原来的独立 CPA 服务

以下保留原 `compose.cpa.yml` 的配置和运维方式。它是单独的共享 CPA 服务，不会被工作台的用户实例接管，也不会自动迁移其中的 OAuth 资料。

### 地址和身份

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

### 启用

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

### 授权 Claude Code

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

### 客户端调用

在客户端中配置上表对应的 Base URL 和 `CPA_API_KEY`。初始配置关闭模型列表的名称伪装，避免 Anthropic 列表中的别名无法用于 OpenAI 兼容接口。模型名从 `/v1/models` 获取，不在配置里假定某个模型始终可用。常见接口包括：

```text
GET  /v1/models
POST /v1/messages
POST /v1/chat/completions
POST /v1/responses
```

Claude Code 订阅额度与浏览器会话容量无关。`MIRROR_CLIENTS=16` 不代表订阅允许 16 路 API 并发；限额和可用模型仍由上游决定。此部署保留 CPA 原有兼容行为，不额外注入自定义伪装参数，也不保证免风控。订阅授权是否适用于具体用途，应参考 [Anthropic 的当前说明](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account)。

### 出口与资源

```text
客户端 → Caddy → CPA（私有网络）→ Xray SOCKS → EGRESS_PROXY → 上游
```

- CPA 只连接 Docker 的 internal 网络，没有直接互联网路由。`cpa-egress` 同时连接私有网和出口网，以 TCP SOCKS 提供出站。代理停用时请求失败，不会改成 CPA 直接连接上游。
- 宿主机的两个回环端口由 `cpa-egress` 原样转发到 CPA，兼容 Docker Desktop 的宿主 NAT 回程；CPA 本身不因此取得外网路由。公网 Caddy 则直接从私有网络访问 CPA。
- 该 SOCKS 端口不发布到宿主机；其目的地址规则拒绝私有网段、云元数据地址及 `EGRESS_BLOCK`。域名通过 Xray 的 DoH 解析，只有代理节点自身的域名使用 `EGRESS_BOOTSTRAP_DNS`。
- `cpa` 以 UID 10003、`cpa-egress` 以 UID 10002 运行，均无 Linux capabilities、根文件系统只读。一次性 `cpa-init` 只负责初始化卷和权限，不接网络。
- CPA 默认内存与内存加 Swap 均为 `512m`，CPU 上限 `1`；独立 Xray 的内存与总内存均为 `128m`，CPU 上限 `0.5`。这些是容器上限，不是实测占用，不占用浏览器容器原有的内存配额。
- 请求全文日志和调试日志默认关闭。错误日志写入受保护的临时文件系统，容器重建后清除。

### 配置持久化、升级和密钥

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

### 检查和关闭

```bash
docker compose ps
docker compose logs --tail=50 cpa cpa-egress
node scripts/cpa.mjs status
pnpm smoke:cpa
```

`smoke:cpa` 使用独立项目、模拟上游和临时凭据，检查 Caddy 路由、管理/API 鉴权、Messages、Chat Completions、SSE、直连阻断、代理中断和配置重启保留；不使用真实订阅账号。测试结束会删除自己的容器和卷。

暂停：`docker compose stop cpa cpa-egress`。彻底关闭 CPA 入口时，从 `.env` 的 `COMPOSE_FILE` 移除两个 CPA 文件，执行 `docker compose up -d --no-deps caddy` 恢复原 Caddy 路由；再执行 `docker compose up -d --remove-orphans` 清理停用的服务，保留命名卷供以后恢复。
