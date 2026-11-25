# remote-cc 接口契约

> 读者：接入方（remote-cc 的开发者，以及审查两者集成的人）

[remote-cc](https://github.com/NotDesigned/remote-cc) 在服务器上运行 Claude Code，命令和文件留在用户自己的电脑上。它可以用某个浏览器配置的 Claude 账号、节点和出口时区启动 Claude Code。两个项目各自部署，只通过本文描述的 HTTPS 接口联系。本文只写 Remote Claude Browser（RCB）一侧；remote-cc 的命令流程见它的[连接 RCB](https://github.com/NotDesigned/remote-cc/blob/main/docs/usage.md#rcb)，工作台里的操作见[使用 · remote-cc](usage.md#remote-cc)和[管理 · 出口主机](admin.md#egress-hosts)。

```text
用户的电脑（remote-cc，客户端令牌）──读配置、要会话授权、登录 Claude Code──► 工作台
remote-cc 的出口主机（主机令牌）──兑换会话授权、复查节点──► 工作台
```

<a id="identity"></a>

## 电脑和 RCB 账号的对应关系

- 一个令牌属于**点「批准」的那个 RCB 用户**。电脑凭它读取这个用户的浏览器配置、为这个用户的配置要会话授权；批准别人发来的请求，就是让对方以你的身份使用你的配置和节点。
- 一个 RCB 用户可以批准多台电脑，每台一个客户端令牌，令牌名是电脑的主机名。remote-cc 服务器上的服务器用户和 RCB 用户互不对应：同一台电脑可以用任意服务器用户启动会话，用到的配置和节点都按令牌所属的 RCB 用户判断。
- 主机令牌属于批准它的管理员，令牌名是出口主机的地址（多实例时带实例名）。兑换会话授权时，工作台返回授权里那个 RCB 用户的 id，出口主机按它区分用户。
- remote-cc 为某个配置保存的 Claude 账号在服务器上，由 remote-cc 管理；remote-cc 的用户名规则见它的[用户名规则](https://github.com/NotDesigned/remote-cc/blob/main/deploy/README.md#user-names)。

<a id="approval"></a>

## 批准流程：连接码的有效期和上限

两种令牌都由工作台里的一次批准产生，不需要手工复制。remote-cc 发起请求（`POST /api/remote-cc/v1/devices`），得到连接码（如 `ABCD-EFGH`）和链接 `https://browser.example.com/?remote-cc=ABCD-EFGH`，然后轮询直到用户批准或拒绝。

- 连接码 10 分钟内有效。同一个 IP 最多 5 个、全站最多 200 个等待确认的请求；已批准或已拒绝的请求不再占名额（`remote-cc/flows.ts`）。
- 用户没有登录时，链接里的连接码在登录后保留下来。
- 批准页显示请求来源的 IP、客户端（`User-Agent`）和发起时间。来源 IP 取决于网关信任的反向代理（`MIRROR_TRUSTED_PROXIES`），没有配置好时显示的是代理的地址。
- 出口主机的请求只有管理员能批准。
- 批准后，令牌只交给发起请求的那一方一次；工作台只保存它的 SHA-256 摘要。
- 每个用户每种令牌最多 20 个（`remote-cc/store.ts`）。

<a id="tokens"></a>

## 客户端令牌和主机令牌的权限

| 令牌       | 前缀    | 交给                   | 能做什么                                                                                                                                                                              | 不能做什么                                                                                         |
| ---------- | ------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 客户端令牌 | `rcck_` | 用户电脑上的 remote-cc | 读本人的浏览器配置（名称、Claude 邮箱、是否登录、节点的 id 和名称、出口 IP、城市、国家、时区）；为本人的配置要会话授权；请工作台重新检查出口；提交 Claude Code 的登录链接并取回授权码 | 读不到 Cookie、浏览器数据、节点配置和凭据；只接受 Claude Code 的登录链接，不能让浏览器打开别的网址 |
| 主机令牌   | `rcch_` | remote-cc 的出口主机   | 兑换会话授权，得到该节点的完整配置（含凭据）；复查自己兑换过的节点                                                                                                                    | 没有会话授权就拿不到任何节点，也不能列出节点或配置                                                 |

界面上，客户端令牌列在「已连接的电脑」，主机令牌列在「出口主机」。

- 令牌所属的用户必须是启用的；主机令牌所属的用户还必须是管理员。不满足时请求返回 401。
- 启用了单点登录时，**没有本地密码**的用户超过 `MIRROR_OIDC_REVALIDATE_DAYS` 没有用单点登录进入工作台，他的两种令牌都返回 401 `REMOTE_CC_SIGN_IN`，登录一次工作台即恢复（见[环境变量 · 单点登录](configuration.md#单点登录oidc)）。

<a id="grants"></a>

## 会话授权的签发、兑换和复查

工作台不把节点配置交给用户的电脑，也不交给出口主机一份全部节点的列表。

1. **签发**：每次启动会话（以及经节点运行的账号命令），remote-cc 用客户端令牌请求 `POST /api/remote-cc/v1/profiles/:id/grant`。工作台签名一份「这个用户可以经节点 N 运行配置 P」的会话授权，10 分钟内有效（`remote-cc/flows.ts`）。配置没有可用节点时返回 409。会话授权本身不含节点凭据。
2. **兑换**：出口主机用主机令牌请求 `POST /api/remote-cc/v1/egress/redeem`。工作台再次确认这个用户仍然启用、仍然有绑定该节点的这个配置，然后返回该节点的 Mihomo 配置（含凭据）和用户 id，并记下「这台出口主机为这个用户取得过这个节点」。条件不满足时返回 403。
3. **复查**：出口主机定期用 `GET /api/remote-cc/v1/egress/nodes/:id?user=<用户 id>` 复查正在运行的节点。用户已停用、配置不再绑定这个节点或节点已删除时返回 404，工作台同时忘掉这条记录；出口主机据此停止这个节点。复查的周期和出口主机收到各种回答时的处理见 remote-cc 的[出网机制](https://github.com/NotDesigned/remote-cc/blob/main/docs/architecture.md#egress)。

会话授权用 `MIRROR_AUTH_SECRET` 派生的密钥签名；没有设置它时每次重启换一把，重启前签发、还没兑换的授权失效，重新启动会话即可。会话授权不绑定某一台出口主机，任何已批准的出口主机都能兑换它。

启动会话需要工作台可达；运行中的会话不受工作台暂时不可达的影响。

**出口和时区的一致**：工作台为每个配置记录最近一次检查到的出口 IP、城市、国家和时区，通过配置列表交给 remote-cc。还没有记录、或 remote-cc 实测的出口与记录不同时，remote-cc 调用 `POST /api/remote-cc/v1/profiles/:id/check`，工作台经该节点重新检查并更新记录；检查失败返回 503。remote-cc 启动时如何比对出口、时区和 Claude 邮箱，见它的[启动时的检查](https://github.com/NotDesigned/remote-cc/blob/main/docs/usage.md#rcb-checks)。

<a id="login"></a>

## 登录横幅

remote-cc 登录 Claude Code 时，把 Claude Code 打印的登录链接交给工作台（`POST /api/remote-cc/v1/profiles/:id/logins`），然后轮询结果：

- 工作台只接受 Claude Code 的登录链接（Claude 域名上的 `/oauth/authorize`，回调地址也在 Claude 域名上），其他网址返回 400。
- 每个配置同时只有一个等待中的登录，新的替换旧的；登录请求 15 分钟后过期（`remote-cc/flows.ts`）。
- 工作台不会自动打开新标签页。这个配置的浏览器里出现登录横幅，用户点「打开授权页」后才在新标签页打开登录链接；等待中的登录也列在「网络与接入」→「remote-cc」，带发起的电脑名，可以在那里打开或「取消」。
- 用户在这个浏览器里点「授权」后，工作台从这个配置的页面地址或回调页的文字里取得授权码，交给轮询的 remote-cc。
- 打开授权页的那个浏览器会话关掉时，登录回到等待状态，横幅再次出现。
- 取消或过期后，轮询返回 404。remote-cc 这时改为让用户手动粘贴授权码。

<a id="revocation"></a>

## 撤销和对运行中会话的影响

- **断开一台电脑或出口主机**：在「网络与接入」→「remote-cc」点「断开」，立即生效。remote-cc 一侧删除本机保存的令牌不会让令牌失效。
- **账户变化**：用户自己改密码，或管理员修改用户的密码或权限、停用或删除用户时，这个用户的所有 remote-cc 令牌一起删除，需要重新批准。管理员被降级后，他批准的主机令牌立即失效。
- 撤销客户端令牌后，这台电脑不能再启动会话；已经在运行的会话不会因此中断。要让运行中的会话停下，停用用户或改掉配置的节点：出口主机下一次复查得到 404 后停止这个节点，运行在上面的会话断网。
- 撤销主机令牌后，出口主机不能再兑换授权，复查也被拒绝；它何时停止全部节点见 remote-cc 的[出网机制](https://github.com/NotDesigned/remote-cc/blob/main/docs/architecture.md#egress)。

<a id="api"></a>

## `/api/remote-cc/v1` 和工作台接口

remote-cc 调用的接口都在 `/api/remote-cc/v1/` 下，不使用工作台登录 Cookie，每次请求自己认证（`Authorization: Bearer <令牌>`）。所有 remote-cc 接口都返回 `cache-control: no-store`。

```text
# 批准连接（无令牌）
POST /api/remote-cc/v1/devices            {kind: "client" | "host", name} → {deviceCode, userCode, verifyUrl, interval, expiresIn}
POST /api/remote-cc/v1/devices/token      {deviceCode} → 202 {status: "pending"} | {status: "approved", token}；拒绝或过期 410

# 客户端令牌
GET  /api/remote-cc/v1/profiles           → {profiles: [{id, name, email, signedIn, unavailable, node: {id, name} | null, exit: {ip, city, country, timeZone, checkedAt} | null}]}
POST /api/remote-cc/v1/profiles/:id/grant → {grant, expiresAt, node: {id, name}}
POST /api/remote-cc/v1/profiles/:id/check → {exit: {ip, city, country, timeZone, checkedAt}}
POST /api/remote-cc/v1/profiles/:id/logins {url} → {id, status: "waiting" | "opened"}
GET  /api/remote-cc/v1/logins/:id         → {status} | {status: "done", code}；取消或过期后 404

# 主机令牌
POST /api/remote-cc/v1/egress/redeem      {grant} → {node: {id, name, proxy}, userId}；proxy 为 Mihomo 节点配置
GET  /api/remote-cc/v1/egress/nodes/:id?user=<userId> → 200 {node} | 404
```

错误返回 `{error, message}`（`error` 是错误码）；令牌无效、所属用户不可用或需要重新单点登录时都是 401。

工作台页面使用的接口（工作台登录 Cookie）：

```text
GET    /api/remote-cc/tokens
DELETE /api/remote-cc/tokens/:id
GET    /api/remote-cc/devices/:code           → {request: {userCode, kind, name, createdAt, expiresAt, ip, userAgent}}
POST   /api/remote-cc/devices/:code/approve   出口主机只有管理员能批准
POST   /api/remote-cc/devices/:code/deny
GET    /api/remote-cc/logins                  → {logins: [{id, profileId, profileName, status, createdAt, tokenName}]}
DELETE /api/remote-cc/logins/:id              只能取消自己的登录，204
```

<a id="storage"></a>

## 存储

令牌摘要和「出口主机取得过哪些节点」保存在 `remote-cc.sqlite`，和其他工作台数据一起备份（见[部署 · 备份](deployment.md#备份)）。等待中的批准请求和登录只在内存里，网关重启后要重新发起。

<a id="compatibility"></a>

## 兼容版本

当前版本需要 remote-cc ≥ 0.7.0：配置卡片上提示的命令是 `remote-cc account login --rcb <配置>`。接口和锚点的每次变化都写在 [CHANGELOG](../CHANGELOG.md) 里，注明需要的 remote-cc 版本。

## 限制

- 出口主机的运营者能看到在这台主机上运行过会话的用户的节点配置和凭据。只在自己信任的服务器上使用别人的节点。
- remote-cc 为配置保存的 Claude 凭据在服务器上的用户容器里，服务器的管理员能读到。
- 工作台记录的出口来自最近一次检查，只核对 IP；时区直接按记录设置，不比较浏览器指纹等其他信号。
- 撤销客户端令牌不会结束已经在运行的会话（见[撤销](#revocation)）。
- 授权码只能在这个配置的浏览器里自动取回；在别的浏览器里完成授权时，只能手动粘贴。
