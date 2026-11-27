# 排查

> 读者：部署者

先看这几项：

```bash
docker compose ps
docker compose logs --tail=200 server
curl --verbose http://127.0.0.1:3010/healthz
```

正常的响应包含 `"ok":true`、`"browser":true` 和一个非负的页面数。

不要把 `docker compose config` 的输出、填好的 `.env`、浏览器配置、Cookie、私人页面快照或下载的文件贴进 issue，它们含有密钥或私人数据。

## Compose 拒绝配置

- 使用 Docker Compose v2 插件（`docker compose`），不要用旧的 Python 版 `docker-compose`。`pnpm check:host` 只读地检查前提条件。
- 提示缺少 `MIRROR_ACCESS_PASSWORD` 或 `MIRROR_AUTH_SECRET`：运行 `scripts/bootstrap.sh` 生成 `.env`，或照 `.env.example` 填写。
- 提示缺少 `EGRESS_PROXY`、`PUBLIC_HOST` 或 `FINGERPRINT_BROWSER_DIR`：`COMPOSE_FILE` 里有对应的可选文件，但没有设置它要的变量。
- 组合报错：只使用[部署 · 可用的 compose 组合](deployment.md#可用的-compose-组合)里列出的组合。

## 服务端不断重启

看 `docker compose logs --tail=100 server`：

- `Could not set the outbound firewall`：宿主机的内核或 Docker 拒绝了 iptables 规则。容器需要 `NET_ADMIN`；`EGRESS_POLICY=off` 可以不设防火墙运行，但网页就能访问私有网络。
- `Unsafe production configuration`：`.env` 里的 `MIRROR_AUTH_SECRET` 缺失或短于 16 个字符。
- 时区相关的错误：`TZ` 不是有效的 IANA 时区名。
- `Could not start the tunnel to EGRESS_PROXY`：部署级出站代理的写法不受支持或连不上，见[部署 · 部署级出站代理](deployment.md#部署级出站代理)。

容器根本起不来，`docker compose up` 报 `apparmor`、`remote-claude-browser` 或 `profile`：这台宿主机的 Docker 使用 AppArmor，但还没有加载服务端的配置文件。执行 `sudo scripts/install-apparmor.sh`，再 `docker compose up -d`。

`cpa-broker` 不健康或不断重启，看 `docker compose logs cpa-broker`：

- `needs Docker Engine 27.3 or newer`：升级 Docker。
- `requires an internal Docker network`：`CPA_RUNTIME_NETWORK` 指向一个已有的非内部网络，换一个名称。
- 健康检查失败而日志正常：它连不上 Docker 守护进程，检查 `/var/run/docker.sock`。

## Chromium 不健康

查看日志。常见原因：

- 内存或 `/dev/shm` 不够；
- 宿主机内核或容器运行时不允许 Chromium 创建沙箱需要的命名空间；
- 持久的浏览器配置目录属于别的 UID（浏览器以 UID/GID 10001 运行）。

镜像故意不加 `--no-sandbox`。修宿主机、运行时或数据卷的属主，不要削弱 Chromium 的隔离。

## 登录后又回到登录页

登录 Cookie 带 `Secure` 属性。本机试用时用 `http://127.0.0.1:3010`（浏览器允许回环地址上的 Secure Cookie），其他情况必须用 HTTPS；用局域网 IP 加明文 HTTP 访问一般会反复回到登录页。

初始管理员只在用户数据库为空时创建，之后修改 `.env` 不会改变密码，见[管理](admin.md#用户)。

## 单点登录失败

- 登录页没有单点登录按钮：`MIRROR_OIDC_ISSUER` 为空，或没有让新的 `.env` 生效。设置了 issuer 却缺少客户端 ID、客户端密钥或 `MIRROR_PUBLIC_ORIGIN` 时，网关启动失败，日志里写明缺什么。
- “暂时无法连接单点登录服务”：网关连不上身份提供方的 discovery 地址。核对 `MIRROR_OIDC_ISSUER` 与 discovery 文档里的 `issuer` 完全一致（包括末尾的 `/`），并确认服务端能访问它。
- “登录已过期或不是从这个浏览器发起的”：回调在另一个浏览器里打开，或超过 10 分钟（`auth/oidc.ts`）。重新从登录页开始。
- “单点登录校验失败”：常见原因是身份提供方登记的回调地址和 `<MIRROR_PUBLIC_ORIGIN>/gate/oidc/callback` 不一致，或客户端密钥不对。
- “你的单点登录账号没有使用这个工作台的权限”：此人第一次登录，不满足 `MIRROR_OIDC_ALLOWED_*` 的任何一项。
- “你的单点登录账号已不在这个工作台的允许范围内”：此人以前登录过，但现在不满足 `MIRROR_OIDC_ALLOWED_*` 的任何一项（例如被移出了允许的组）。

变量见[环境变量 · 单点登录](configuration.md#单点登录oidc)。

## 浏览器配置打不开

- `409 EXIT_REQUIRED`：这个配置没有绑定节点，或绑定的节点已被删除。在工作台里给它「设置出口」，见[使用 · 出口](usage.md#出口)。
- `503 PROXY_RUNTIME_DISABLED`“请在部署中启用独立出口运行时”：`COMPOSE_FILE` 里没有 `compose.runtime.yml`。
- “内存不足以启动另一个浏览器”或“内存较紧张”：内存准入拒绝了新会话，见下一节。

## 新会话打不开或页面进程崩溃

- 内存：在「管理后台」→「资源」查看服务内存和整机内存。等离线会话被回收，或调大 `SERVER_MEMORY`。准入规则见[部署 · 资源与超时](deployment.md#资源与超时)。
- PID：多个配置同时运行时可能先碰到 `SERVER_PIDS_LIMIT`，检查方法见[部署 · 资源与超时](deployment.md#资源与超时)。

## 出口检查失败

- 节点本身不可用：在「代理来源」里检查这个节点，或换一个节点。
- 宿主机用 Docker Desktop 时，它的透明代理会接管容器的 TCP 80/443 连接，干扰 Mihomo 和 VLESS、REALITY 等节点建立连接。通过 Docker Desktop 的设置接口把 `proxy.containers.transparentPorts` 设为 `""`（对应 `settings-store.json` 里的 `ContainersOverrideProxyTransparentPorts`）。这样镜像下载仍走代理，容器的连接不再被接管。镜像下载依赖代理时，不要把 **Containers proxy** 直接设为 **No proxy**，那样镜像拉取也会改为直连。
- 节点用 IPv6 上游时，确认宿主机有 IPv6 出站路由，并且 `browser` 网络是双栈（Docker Engine 27.3 或更新版本）。从只有 IPv4 的旧网络升级时，要先停止连接它的服务，再重建这个网络，数据卷保留。

## 远程浏览器的时间不对

浏览器的时区跟随出口，不看 `TZ`，也不看使用者设备的时区。在配置卡片上「检查出口」，看检测到的时区；时区和浏览器启动时不同时，结束这个配置的所有会话，等它不再「运行中」后重新打开。出口检测拿不到有效时区时浏览器不会启动，修好节点后重试。

`TZ` 只影响服务进程和日志，`docker compose exec server date -Is` 显示服务进程的时间。

## 查看端显示已断开

确认反向代理转发了 `/ws` 上的 WebSocket 升级，保留了 `Host`，也没有设置很短的响应超时，见[部署 · 公网入口](deployment.md#公网入口)。浏览器开发者工具里应该能看到一个同源的、保持打开的 WebSocket。

## 页面空白或错位

先在页面模式里等同步完成，再切到画面模式。容易让页面模式出问题的网站特征：封闭的 shadow DOM、多层嵌套的跨域 iframe、只用 canvas 或 WebGL 的界面、不常见的 CSS、快速替换整个文档。

报告问题时附上一个最小的公开网址或本地测试页，以及浏览器和网关的日志。

## 输入未同步

页面模式里打字时，工作台给每次输入编号，远程页面处理完后，网关把确认和远程输入框内容的校验值（不含文字本身）只发回打字的那个工作台（`MIRROR_INPUT_ACKS`，见[配置](configuration.md#写在-compose-文件里的变量)）。设为 `on` 时，工作台据此判断远程输入框是否已经跟上：校验值一致就结束等待，不一致就立即按远程的内容更新输入框。「输入未同步」仍只在远程页面没有接受输入时出现。

排查时在工作台地址后加 `?inputlab=1`（例如 `…/?sid=…&inputlab=1`），「连接」里的「诊断」会多出几行：「输入确认 p50 / p95」是从发出输入到确认、且本地回放已跟上的时间；「校验一致 / 不一致」是每段输入结束时两边输入框是否相同；「未确认即超时」是旧的固定等待在还有输入没确认时就结束的次数（会把旧文字写回，`shadow` 下大于 0 说明网络慢时值得开 `on`）；「仅确认已发出」是远程页面没有回报内容、只知道输入已发出的次数（页面里的脚本还不支持确认，或确认超时）。浏览器控制台里的 `window.__mirrorInputLab` 有同样的数字和最近的确认记录。

## 文字排版不同

镜像带有常见的 DejaVu、Liberation、Noto、中日韩和 emoji 字体。网页的远程字体会经网关代理，但字体加载失败和平台差异仍可能让排版不同。查看 `/s/…/a/…` 下的资源请求；影响使用时切到画面模式。

## 上传或下载失败

服务端把浏览器配置和传输中的文件放在 `data` 卷里，检查磁盘空间和网关日志。下载链接只能在同一个已登录的浏览器会话里兑换一次。

## 视频不可用

页面模式的视频经 WebRTC 直接从服务端发到使用者的设备，没有内置 TURN 服务，对称 NAT 后面的设备可能连不上（见[部署 · 视频和 WebRTC](deployment.md#视频和-webrtc)）。DRM 保护的媒体无法采集。切到画面模式；如果画面模式也不行，可能是网站在 Chromium 的合成层就禁止或遮挡了这些内容。

## remote-cc 连不上

- remote-cc 报 401：令牌已被断开，或所属用户被停用、修改了密码或权限，需要重新批准。只用单点登录、没有本地密码的用户长时间没有登录工作台时也是 401，登录一次工作台即可，见[接口契约 · 令牌](remote-cc.md#tokens)。
- 批准页显示的来源 IP 是反向代理的地址：设置 `MIRROR_TRUSTED_PROXIES`，见[部署 · 公网入口](deployment.md#公网入口)。

## 重置本地试用环境

只在没有任何需要保留的数据时使用：

```bash
docker compose down --volumes
docker compose up -d --build
```

这会删除所有用户、浏览器配置和网站登录资料。
