# remote-cc：让 Claude Code 使用浏览器配置的身份和出口

[remote-cc](https://github.com/NotDesigned/remote-cc) 在服务器上运行 Claude Code，命令和文件留在用户自己的电脑上。和本项目联动后，`remote-cc --rcb 配置` 启动的 Claude Code：

- 使用这个浏览器配置登录的 Claude 账号（remote-cc 账号 `rcb-<配置 id>`，启动前核对邮箱）；
- 全部网络流量经这个配置绑定的节点出去，出口 IP 必须等于工作台记录的出口，否则拒绝启动；
- 时区设为该出口的时区。

两个项目各自部署，可以在同一台机器上，也可以分开；remote-cc 只通过下面的 HTTPS 接口和本项目联系。部署和命令见 remote-cc 的 `deploy/README.md`。

```text
用户的电脑（remote-cc，客户端令牌）──读配置、要会话授权、一键登录──► 工作台
remote-cc 服务器上的出口主机（rcc-egress，主机令牌）──兑换会话授权──► 工作台
用户的电脑 ──ssh──► 服务器上的用户容器 ──会话授权──► 出口主机 ──节点──► 外网
```

## 批准连接

两种令牌都不需要手工复制，都由工作台里的一次批准产生：

- **电脑**：在电脑上运行 `remote-cc rcb login https://browser.example.com`，终端显示一个连接码（如 `ABCD-EFGH`）和链接 `https://browser.example.com/?remote-cc=ABCD-EFGH`，并尝试在本机浏览器打开链接。用户本人打开链接（没有登录时先登录，连接码会保留下来），工作台打开「代理与 API → remote-cc」，连接码已填好；核对它与终端里的一致后点「查看」，再点「批准」。也可以直接在这个页面输入连接码。
- **出口主机**：在 remote-cc 服务器上安装出口主机时（`remote-cc server egress --rcb URL root@服务器`）同样显示连接码和链接，由工作台的**管理员**批准；普通用户看到的批准按钮是灰的。

批准页会显示请求来源的 IP、客户端（User-Agent）和发起时间，用来确认是自己刚刚运行的命令。**令牌属于点「批准」的那个用户**：批准别人发来的链接或连接码，就是让对方以你的身份读取你的配置、使用你的节点，所以只批准自己刚刚发起、终端里连接码完全一致的请求。

- 连接码 10 分钟内有效；同一个 IP 最多 5 个、全站最多 200 个等待确认的请求，被批准或拒绝的请求不再占名额。
- 批准后，令牌只交给发起请求的那台机器一次；工作台只保存它的 SHA-256 摘要。
- 令牌名就是电脑的主机名，或出口主机的地址（多实例时带实例名）。每个用户每种令牌最多 20 个。
- 来源 IP 取决于网关信任的反向代理（`MIRROR_TRUSTED_PROXIES`）；没有正确配置时，显示的是代理的地址。

## 一键登录 Claude Code

`remote-cc login --rcb 配置` 在服务器上、经该配置的节点运行 `claude auth login`。remote-cc 从 Claude Code 的输出里识别出登录链接，交给工作台：

1. 这个配置的浏览器正开着时，工作台在其中新开一个标签页打开登录链接（优先用户正在看的那个会话）；没开时，用户打开这个配置后自动打开。
2. 用户在这个浏览器里点「授权」。工作台从这个配置的页面地址里取得授权码，交还 remote-cc，remote-cc 把它输入 Claude Code。用户已经在终端里打过字时，改为打印授权码让用户自己粘贴，以免混在一起。
3. 登录完成后，remote-cc 核对 Claude Code 登录的邮箱和这个配置的 Claude 邮箱，不一致时提示重新登录（会话启动时也会拒绝）。

等待中的登录显示在「代理与 API → remote-cc → 等待完成的 Claude Code 登录」，带发起的电脑名，可以点「取消」。每个配置同时只有一个登录，新的替换旧的；登录请求 15 分钟后过期。打开登录页的那个浏览器会话关掉时，登录回到等待状态，下次打开这个配置时重新打开。

**手动粘贴**一直可用：链接没有识别出来、工作台连不上、登录被取消或过期、15 分钟没完成时，remote-cc 会提示，用户自己打开 Claude Code 打印的链接（最好在这个配置的浏览器里打开，这样账号和出口一致），把授权码粘贴回终端即可。

## 会话授权

工作台不把节点配置交给用户的电脑，也不交给出口主机一份全部节点的列表。每次启动会话（以及 `login`、`status` 等经节点运行的账号命令），remote-cc 用客户端令牌向工作台要一份**会话授权**：工作台签名的「这个用户可以经节点 N 运行配置 P」，10 分钟内有效，只能由已批准的出口主机兑换。

出口主机收到会话的授权后，用主机令牌向工作台兑换：工作台再次确认这个用户仍然启用、仍然有绑定该节点的这个配置，然后返回该节点的完整配置（含凭据）和用户 id，并记下「这台出口主机为这个用户拿到过这个节点」。

- **启动会话需要工作台可达**：要授权、兑换授权都要连工作台。工作台不可达时新会话无法启动。
- **运行中的会话不受工作台暂时不可达影响**：出口主机每 5 分钟只为正在运行的节点、按用户逐个复查（`?user=`）。复查得到 404/403（该用户被停用、配置不再绑定这个节点、节点被删除）时停止这个用户的这个节点；节点配置变化时也停止，下次启动用新配置；连不上、5xx 等不明确的回答保持运行。被停止的节点上，正在运行的会话会断网，需要重新启动。
- 出口主机按「remote-cc 用户 + 工作台用户 + 节点」分别运行网络命名空间和 Mihomo，不同用户即使用同一个节点，也不共用连接、DNS 缓存，撤销一个用户也只影响他自己。

## 出口和时区如何一致

出口主机用同一份节点配置和同版本 Mihomo 运行节点，DNS 同样经节点解析，所以与本项目浏览器的出口一致；出口 IP 由节点服务器决定（例如节点优先用 IPv6 时，两边都是 IPv6 出口）。会话启动时 remote-cc 在节点的网络命名空间里：

1. 查询实际出口 IP，必须等于工作台记录的出口；
2. 把 `TZ` 设为工作台记录的时区；
3. 这个配置的浏览器已经登录 Claude 时，Claude Code 登录的邮箱必须与之相同（没有登录时拒绝；用 setup-token 登录、没有邮箱时只提示不比较）。

工作台还没有这个配置的出口记录时，remote-cc 先请工作台经该节点检查一次并记下，检查失败就拒绝启动。实际出口与记录不同时，remote-cc 请工作台重新检查一次：出口确实变了，就用新的记录重试一次；工作台看到的仍是旧出口，说明出口主机到节点的路径和工作台不同，拒绝启动。

## 令牌能读到什么

| 令牌 | 前缀 | 交给 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- | --- |
| 客户端（电脑） | `rcck_` | 用户电脑上的 remote-cc | 读本人的浏览器配置：名称、Claude 邮箱、是否登录、节点 id 和名称、出口 IP、城市、国家、时区；为本人的配置要会话授权；请工作台重新检查出口；在本人配置的浏览器里打开 Claude Code 登录链接并取回授权码 | 读不到 Cookie、浏览器数据、节点配置和凭据；只接受 Claude Code 的登录链接，不能让浏览器打开别的网址 |
| 出口主机 | `rcch_` | remote-cc 服务器上的 `rcc-egress` | 兑换会话授权，得到该会话节点的完整配置（含凭据）；复查自己兑换过的节点 | 没有授权就拿不到任何节点，也不能列出节点或配置；只在所属用户是启用的管理员时有效 |

会话授权只说明用户、配置和节点，本身不含节点凭据；拿到它的人还需要一个主机令牌才能兑换。

## 撤销

- **断开一台电脑或出口主机**：「代理与 API → remote-cc」里对应的「断开」，立即生效。电脑上的 `remote-cc rcb logout` 只删除本机保存的令牌，不会让它失效。
- **账户变化**：用户自己改密码，或管理员修改用户的密码或角色、停用或删除用户时，这个用户的所有 remote-cc 令牌一起删除，需要重新批准。管理员被降级后，他批准的出口主机令牌立即失效。
- 撤销客户端令牌后，这台电脑不能再启动会话；已经在运行的会话不会因此中断。要让运行中的会话停止，停用用户或改掉配置的节点，出口主机最多 5 分钟内复查到后停止。
- 撤销主机令牌后，出口主机不能再兑换授权；连续两轮复查（最多约 10 分钟）被拒绝后，它停止所有节点。要继续使用，在服务器上重新运行 `server egress`。

## 接口

remote-cc 调用的接口都在 `/api/remote-cc/v1/` 下，不使用工作台登录 Cookie，每次请求自己认证（`Authorization: Bearer <令牌>`）；所有 remote-cc 接口都返回 `cache-control: no-store`。

```text
# 批准连接（无令牌）
POST /api/remote-cc/v1/devices            {kind: "client" | "host", name} → {deviceCode, userCode, verifyUrl, interval, expiresIn}
POST /api/remote-cc/v1/devices/token      {deviceCode} → 202 {status: "pending"} | {status: "approved", token}；拒绝或过期 410

# 客户端令牌
GET  /api/remote-cc/v1/profiles           → {profiles: [{id, name, email, signedIn, unavailable, node: {id, name} | null, exit: {ip, city, country, timeZone, checkedAt} | null}]}
POST /api/remote-cc/v1/profiles/:id/grant → {grant, expiresAt, node: {id, name}}
POST /api/remote-cc/v1/profiles/:id/check → {exit: {ip, city, country, timeZone, checkedAt}}，经节点重新检查并记录
POST /api/remote-cc/v1/profiles/:id/logins {url} → {id, status: "waiting" | "opened"}
GET  /api/remote-cc/v1/logins/:id         → {status} | {status: "done", code}；取消或过期后 404

# 主机令牌
POST /api/remote-cc/v1/egress/redeem      {grant} → {node: {id, name, proxy}, userId}；proxy 为 Mihomo 节点配置
GET  /api/remote-cc/v1/egress/nodes/:id?user=<userId> → 200 {node} | 404
```

工作台页面使用的接口（登录 Cookie）：

```text
GET    /api/remote-cc/tokens
DELETE /api/remote-cc/tokens/:id
GET    /api/remote-cc/devices/:code           → {request: {userCode, kind, name, createdAt, expiresAt, ip, userAgent}}
POST   /api/remote-cc/devices/:code/approve   出口主机只有管理员能批准
POST   /api/remote-cc/devices/:code/deny
GET    /api/remote-cc/logins                  → {logins: [{id, profileId, profileName, status, createdAt, tokenName}]}
DELETE /api/remote-cc/logins/:id              只能取消自己的登录，204
```

令牌摘要和「出口主机拿到过哪些节点」保存在 `/data/profile/remote-cc.sqlite`，备份时与其他工作台数据一起保存。等待中的批准和登录只在内存里，网关重启后需要重新发起。会话授权用 `MIRROR_AUTH_SECRET` 派生的密钥签名；没有设置它时每次重启换一把，重启前领到、还没兑换的授权失效，重新启动会话即可。

## 限制

- 出口主机的运营者（remote-cc 服务器的管理员）能看到在这台主机上运行过会话的用户的节点配置和凭据，只在自己信任的服务器上使用别人的节点。
- 会话授权不绑定某一台出口主机：任何已批准的出口主机都能兑换它。授权只在会话启动时短暂出现，10 分钟后失效。
- `rcb-*` 账号的 Claude 凭据保存在服务器上的用户容器里，服务器管理员可以读到；这与 remote-cc 普通账号相同。
- 出口检查只核对 IP，时区直接按记录设置，不比较浏览器指纹等其他信号；工作台记录的出口来自最近一次检查，节点变化后要重新检查（remote-cc 发现出口不一致时会自动请工作台检查一次）。
- 撤销客户端令牌不会结束已经在运行的会话（见「撤销」）。
- 一键登录依赖工作台看到登录回调页的地址；在别的浏览器里完成授权时，只能手动粘贴授权码。
