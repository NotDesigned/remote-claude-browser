# CPA：按用户管理的订阅 API

可选的 CLIProxyAPI（CPA）把独立授权的 Claude Code 账号接到兼容 API。工作台内的 CPA 实例按用户隔离：每个专用实例使用自己的配置、OAuth 凭据和持久卷；浏览器 Cookie 不会自动变成 CPA 授权。

本实现运行未修改的 CPA，不调用 ClaudeBox 的 `/prompt`，也不启动 `claude -p` 子进程；流式输出和协议转换由 CPA 完成。CPA 固定为 **8.0.68**，上游镜像摘要写在 `deploy/Dockerfile.cpa`，不跟随 `latest`。

## 在工作台里使用

1. 打开「工作台 → API」。配置选择页和浏览器内均可进入，无需先启动浏览器。
2. 创建自己的 CPA 实例并启动。每个用户最多一个专用实例；管理员还可以建立一个共享实例。共享实例的启动和授权凭据由管理员管理；所有启用的工作台用户都能生成、查看和撤销自己的共享调用 Key。管理员可以查看共享 Key 的所有者并撤销任意共享 Key。
3. 在「添加 Claude 授权」中，代理默认选中当前浏览器配置绑定的出口，也可手动选择其他可用节点，不能使用部署默认出口。生成链接后，在出口一致的远程浏览器中打开授权页；没有当前匹配的浏览器时，使用「选择同出口浏览器」，选择已有配置或新建，随后自动打开授权。修改所选代理会清除面板中的旧链接；已有待完成授权可在实例卡片取消。把完整回调 URL 或授权码粘贴回面板，后台会独立确认结果并保存绑定，关闭面板不会中断确认。回调草稿按用户、实例和授权会话保存于当前标签页，切换管理页、实例或刷新后仍保留；提交、完成或取消后清除。新增授权期间已有凭据继续提供调用。
4. 授权成功后，在凭据列表中分别选择代理节点，或停用、启用、删除该凭据。新授权会保存本次所选节点；后续每个凭据的代理与浏览器配置独立设置，不会因浏览器切换出口自动改变。
5. 生成外部 API Key。新 Key 归当前工作台用户所有，调用对应实例的账号池。完整 Key 只显示这一次，保存后再关闭面板；列表只显示前缀和所有者，可随时撤销。使用共享池不需要查看或管理其中的授权凭据。

新 Key 以 `rcpa_` 开头；迁移导入的旧 Key 保持原值。工作台网关按 Key 摘要查询归属，路由到唯一 CPA 实例：

| 用途 | 地址与认证 |
| --- | --- |
| OpenAI 兼容 Base URL | `https://browser.example.com/v1`，使用生成的 Key |
| Anthropic Messages | `https://browser.example.com/v1/messages`，支持 Bearer 或 `x-api-key` |
| 模型列表 | `GET https://browser.example.com/v1/models`，使用同一 Key |
| 工作台管理 API | `/api/cpa/instances/*`，使用工作台登录 Cookie |

工作台登录用于管理；外部 Key 用于模型调用。不同实例的外部 Key 不能管理凭据，也不能调用其他实例。浏览器网页登录、Claude Code OAuth 和外部调用 Key 是三种独立身份。

停用工作台用户会使其调用 Key 失效、结束浏览器会话并停止私有 CPA，资料和 Key 记录保留。重新启用后共享 Key 恢复可用，私有 CPA 需要手动启动。「删除用户与数据」会永久移除该用户的私有 CPA 容器、配置/授权/面板卷和全部个人调用 Key，同时删除其浏览器资料与私有代理来源。其他用户及共享实例保留；清理失败时账号保持停用，可重试删除。

登录工作台后，从「工作台 → API」选择实例，点击「打开原生管理页面」。每个实例使用 `/api/cpa/instances/<id>/manage/management.html`，沿用工作台登录并逐请求检查管理权限；管理密钥由服务端代用。私有实例只允许本人进入，共享实例由管理员进入。`/management.html` 跳转到当前用户的私有实例，未创建私有实例的管理员可进入共享实例。实例需要先启动。

原生面板使用固定版本的官方 HTML，构建镜像时核验 SHA256，不在打开页面时下载。面板状态按用户和实例隔离。对外 `/v1` 调用 Key、Claude OAuth 和出口绑定继续通过工作台管理；原生页面用于实例配置、统计和诊断。下文兼容部署中的独立原生面板仍使用旧 CPA 管理密钥。

## 启用按用户实例

在浏览器服务的 Compose 文件列表中增加 [`compose.runtime.yml`](../compose.runtime.yml)。全新部署可以使用：

```bash
docker compose -f compose.yml -f compose.runtime.yml up -d --build
```

长期使用时把相同文件列表保存到 `.env` 的 `COMPOSE_FILE`。已有部署应在现有文件列表后追加 `compose.runtime.yml`，保留已有的出站、入口和私有覆盖文件。浏览器配置必须明确绑定节点，未分配时不能打开；CPA 新增授权和修改凭据出口同样要求明确的节点；空实例可直接启动，但没有默认互联网出口。历史未绑定凭据会停用，选择节点后再启用；已有明确绑定保持不变。已有 `EGRESS_PROXY`/`compose.proxy.yml` 不需要迁走。

用户 CPA 模块需要 Docker bridge 网络，不兼容 `compose.hostnet.yml`。已有主机网络部署应先由部署者移除该覆盖文件、确认 bridge 下的端口和媒体连接，再追加运行时模块；公网入口仍可由同机或独立 VPS 管理。

这个覆盖文件增加两个运行时边界：

- 浏览器服务内的 root broker 提供固定的浏览器和 Mihomo 网络操作；网关与 Chrome 仍以非 root 用户运行。配置绑定节点后，在专用网络命名空间内运行浏览器及对应 Mihomo 出口。
- 独立 `cpa-broker` 通过固定模板建立 CPA 容器，只有它挂载 Docker socket。工作台通过 Unix socket 请求实例操作，不能提交任意 Docker 参数。CPA 实例只连接 internal 网络，经认证的运行时代理访问外网。

浏览器数据仍在原 `data` 卷。运行时不会把旧单独 CPA 的 OAuth 文件自动导入某个用户；原服务可以保持运行，新的用户实例独立授权。

公网入口正常转发整个浏览器服务即可，包括 `/api/cpa/instances/*` 和 `/v1/*`。不必对外发布 CPA 管理端口或 Docker socket。同机及独立 VPS 的入口示例见 [`examples/caddy/`](../examples/caddy/README.md)。

### 从旧独立 CPA 迁移

旧的独立 CPA 服务（`compose.cpa.yml`）已移除。仍保留其数据卷时，迁移应先明确旧数据属于哪个工作台用户，再建立或检查该用户的私有实例；管理员私有实例与共享池是不同目标。一起备份工作台数据库、旧配置及授权卷，停止旧实例的写入后复制授权，已有目标授权发生冲突时先处理冲突。

`deploy/cpa-migration.mjs` 的 `mergeCpaMigrationConfig(legacy, target)` 保留旧业务配置，包括路由、上游、日志和模型/API 配置；目标实例保留自己的服务监听、内部调用与管理密钥、授权目录和运行时代理地址。旧外部调用 Key 通过内部的 `store.importKey(instanceId, name, token)` 登记摘要，原 Key 不变；重复导入同实例保持幂等，跨实例冲突会拒绝。该导入方法没有公开 HTTP 接口。

迁移完成后，入口应把整个 `/v1/*` 转给工作台，让网关查询 Key 归属。已有本机证书或自定义 Caddyfile 时，只调整对应路由并保留证书路径和传输设置。

## 工作台管理 API

所有路径都要求工作台登录；权限由实例和代理来源的所有者决定。共享实例的启停、凭据与授权管理仅限管理员；`/keys` 路径允许普通用户管理本人 Key，管理员可管理全部共享 Key。客户端不会取得实例内部管理密钥、订阅地址或节点密码。

```text
GET    /api/cpa/instances
POST   /api/cpa/instances                         {scope: "user" | "shared"}
POST   /api/cpa/instances/:id/start
POST   /api/cpa/instances/:id/stop
POST   /api/cpa/instances/:id/check
GET    /api/cpa/instances/:id/credentials
PATCH  /api/cpa/instances/:id/credentials/status   {name, disabled}
PATCH  /api/cpa/instances/:id/credentials/proxy    {name, proxyId: string}
DELETE /api/cpa/instances/:id/credentials?name=…
POST   /api/cpa/instances/:id/oauth                {provider: "claude", proxyId: string}
GET    /api/cpa/instances/:id/oauth                recover pending authorizations (manager only)
GET    /api/cpa/instances/:id/oauth/status?state=…
POST   /api/cpa/instances/:id/oauth/callback       {state, code? | redirectUrl?}
POST   /api/cpa/instances/:id/oauth/cancel
GET    /api/cpa/instances/:id/keys
POST   /api/cpa/instances/:id/keys                 {name}
DELETE /api/cpa/instances/:id/keys/:keyId
```

实例列表分别返回容器进程状态、授权就绪状态、出口状态和待完成授权标识；可管理标识控制实例与凭据操作，不限制用户领取共享调用 Key。Key 列表包含 `userId` 与 `username`，普通用户只收到本人条目。生成 Key 的响应含一次性 `token`，后续列表不再返回完整值。凭据返回 `proxyId: null` / `needsBinding: true` 表示需要绑定出口，不能启用；新增授权和修改凭据出口不再接受空值或 `deployment-default`。

## 出口与当地时间

每份 Claude 凭据保存明确的 `proxy_url` 和 IANA `timezone`。授权完成、修改节点、启动恢复及手动检查出口时，网关按该节点的实际出口元数据同步这两项。出口进程自动恢复后，后台循环读取已缓存的健康信息；检测到时区变化时只更新对应凭据的时区。CPA 8.0.68 原生使用凭据 `timezone` 生成当地 `currentDate`；这不是一个自定义 HTTP 头，也不会重写用户自行提交的日期或对话内容。已有对话的日期还可能由 CPA 的会话日期固定逻辑保留。

面板中的「检查出口」只检查节点联网与出口地址，不发起模型生成，不验证订阅余额或证明 Claude 账号一定可调用。列表读取当前出口进程状态，不会自动启动节点；只有管理者能查看凭据、出口 IP 和时区，普通共享池使用者只看到汇总状态。

添加授权期间，已有授权继续提供 API 调用。启动恢复只把全局 `requests.proxy-url` 改为无法使用的内部出口，保留其他配置、实例 ID、授权文件及外部 Key；未绑定凭据不会回退到部署出口或第一个节点。

## 持久化与验收

`data` 卷中的 `/data/profile/cpa.sqlite` 保存实例归属、内部连接密钥、外部 Key 摘要、Key 使用者归属和凭据代理绑定；`/data/runtime/secret` 保存内部出口令牌的生成密钥。这些文件与浏览器资料一起受保护备份，恢复时保留 `/data/runtime` 的 root:root、0700 和密钥文件的 root:root、0600。每个动态实例还有三个独立卷，名称形如 `remote-browser-<instanceId>-config`、`-auth`、`-static`，其中实例 ID 以 `cpa-` 开头；实际名称以 `docker volume ls` 为准。停实例保留这些卷。备份时一起保存工作台元数据与 CPA 配置、授权卷，只有一个部分不足以恢复原实例。

升级到个人 Key 权限时，已有私有 Key 自动归对应实例所有者，已有共享 Key 归初始管理员，Key 内容保持不变。历史共享 Key 无法推断曾分发给谁；若已分发，应让使用者领取个人 Key 后撤销旧共享 Key。数据库迁移在事务中完成，迁移后没有无用户归属的调用 Key。

先构建 CPA 引擎镜像，再执行不使用真实账号的隔离验收：

```bash
docker build -f deploy/Dockerfile.cpa --target cpa -t remote-claude-browser-cpa:local .
bash scripts/limited-run.sh env CPA_TENANCY_SMOKE=1 node scripts/cpa-tenancy-smoke.mjs
```

该测试创建自己的两个临时 CPA 实例、独立卷及 internal 网络，检查凭据/Key 隔离、每凭据代理与时区修改、OAuth 路由，以及两个相反时区下真正发往本地模拟 HTTPS 上游的日期，结束后清理自己的容器与卷。它不使用正式订阅账号，也不能证明真实上游推理成功。设置 `CPA_BROKER_ENGINE_IMAGE` 可选择测试引擎镜像。

前端使用 `bash scripts/limited-run.sh node scripts/network-ui-smoke.mjs` 验收本地模拟接口下的来源管理、CPA 授权和 Key 操作、320px 手机布局；不会访问真实订阅。
