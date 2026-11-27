# 环境变量

> 读者：部署者（查表）

服务端读取仓库根目录的 `.env`，入口机读取 `client/.env`。两个文件都不进 Git，不要提交填好的文件。`scripts/bootstrap.sh` 会为服务端生成 `.env`，`.env.example` 列出了每个变量的示例。

改完 `.env` 后执行 `docker compose up -d` 让它生效。各 compose 文件的组合方式见[部署 · 可用的 compose 组合](deployment.md#可用的-compose-组合)。

## 服务端（`.env`）

### 基本

| 变量                     | 必填 | 默认                 | 说明                                                                                                                                                                                                                                                        |
| ------------------------ | :--: | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPOSE_FILE`           |  是  | `compose.yml`        | Docker Compose 自己读取的文件列表，用 `:` 分隔。要打开浏览器配置，必须包含 `compose.runtime.yml`                                                                                                                                                            |
| `MIRROR_ACCESS_PASSWORD` |  是  | 无                   | 初始管理员的密码，至少 8 个字符。只在用户数据库为空时使用；之后修改它不会改变任何用户的密码。Compose 要求它非空                                                                                                                                             |
| `MIRROR_ADMIN_USERNAME`  |  否  | `admin`              | 初始管理员的用户名。只在用户数据库为空时使用，之后修改它不会给已有用户改名                                                                                                                                                                                  |
| `MIRROR_AUTH_SECRET`     |  是  | 无                   | 至少 16 个字符（`production-guard.ts`），用 `openssl rand -hex 32` 生成并保持不变。用于签名设备和会话归属，以及派生 remote-cc 会话授权的签名密钥。轮换它不会撤销用户的工作台登录                                                                            |
| `MIRROR_PUBLIC_ORIGIN`   |  是  | 无                   | 用户实际打开的来源，例如 `https://browser.example.com`；本机试用写 `http://127.0.0.1:3010`（`scripts/bootstrap.sh` 默认写入它）。来自其他来源的 WebSocket 和表单提交会被拒绝；单点登录的回调地址也由它推出。没有设置时网关拒绝启动（`production-guard.ts`） |
| `MIRROR_START_URL`       |  否  | `https://claude.ai/` | 新会话打开的第一个页面                                                                                                                                                                                                                                      |
| `MIRROR_IDLE_GRACE_MS`   |  否  | 900000（15 分钟）    | 一个会话的所有设备都断开后，过多久关闭它的远程页面，单位毫秒（`session/resource-policy.ts`）；必须是不小于 0 的整数，否则网关拒绝启动                                                                                                                       |
| `SERVER_IMAGE`           |  否  | 本地构建             | 预构建的服务端镜像，例如 `ghcr.io/notdesigned/remote-claude-browser-server:v0.5.0`；和两个 CPA 镜像用同一个版本标签，见[部署 · 安装](deployment.md#安装)                                                                                                                                                                          |
| `TZ`                     |  否  | `Etc/UTC`            | 服务进程和日志的时区。无效的 IANA 时区名会让容器启动失败。浏览器的时区不看它，而是跟随各自的出口（见[使用 · 当地时间](usage.md#当地时间)）。`docker compose exec server date -Is` 显示服务进程的时间                                                        |

### 网络和入口

| 变量            |             必填              | 默认             | 说明                                                                                             |
| --------------- | :---------------------------: | ---------------- | ------------------------------------------------------------------------------------------------ |
| `SERVER_BIND`   |              否               | `127.0.0.1`      | 网关在宿主机上发布的地址。放在反向代理或隧道后面时保持回环地址                                   |
| `SERVER_PORT`   |              否               | `3010`           | 网关在宿主机上发布的端口                                                                         |
| `SERVER_SUBNET` |              否               | `172.31.66.0/24` | `browser` 网络的 IPv4 子网，和其他网络冲突时修改。这个网段里的反向代理可以设置 `X-Forwarded-For` |
| `EGRESS_POLICY` |              否               | `on`             | `off` 会让网页能访问私有网络和这台宿主机                                                         |
| `EGRESS_BLOCK`  |              否               | 空               | 额外禁止网页访问的地址，逗号分隔。填上这台机器的公网 IP：容器看不到它                            |
| `PUBLIC_HOST`   | 使用 `compose.https.yml` 时是 | 无               | 同机 Caddy 服务的域名                                                                            |
| `HTTP_PORT`     |              否               | `80`             | 同机 Caddy（`compose.https.yml`）发布的 HTTP 端口                                                |
| `HTTPS_PORT`    |              否               | `443`            | 同机 Caddy（`compose.https.yml`）发布的 HTTPS 端口                                               |

### 资源

| 变量                | 默认   | 说明                                                                                                                      |
| ------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| `SERVER_MEMORY`     | `4g`   | 容器的内存上限。会话按可用内存准入，见[部署 · 资源与超时](deployment.md#资源与超时)                                       |
| `SERVER_MEMSWAP`    | `0`    | 内存加交换分区的上限，`0` 交给 Docker 决定                                                                                |
| `SERVER_CPUS`       | `0`    | CPU 上限，`0` 表示可以用宿主机的全部 CPU                                                                                  |
| `SERVER_PIDS_LIMIT` | `4096` | 容器内进程和线程的总数上限。每个浏览器配置的 Chromium 都要用到几百个线程，见[部署 · 资源与超时](deployment.md#资源与超时) |

### 出口运行时和 CPA（`compose.runtime.yml`）

| 变量                      | 默认                                     | 说明                                 |
| ------------------------- | ---------------------------------------- | ------------------------------------ |
| `CPA_RUNTIME_NETWORK`     | `remote-browser-cpa-runtime`             | 服务端和 `cpa-broker` 之间的 Docker 内部网络的名称。`cpa-broker` 只管理属于这个网络的 CPA 实例，同一台 Docker 主机上的每个部署要用不同的名称 |
| `CPA_INSTANCE_SUBNETS`    | `10.254.0.0/16`                          | 每个 CPA 实例自己的内部网络从这里分一个 `/28`，前缀长度 8 到 26。和宿主机已有的网络冲突时修改，见[部署 · CPA](deployment.md#cpa) |
| `CPA_BROKER_ENGINE_IMAGE` | `remote-claude-browser-cpa:local`        | CPA 实例使用的镜像，例如 `ghcr.io/notdesigned/remote-claude-browser-cpa:v0.5.0`；换了镜像，`cpa-broker` 会重建各个实例 |
| `CPA_BROKER_IMAGE`        | `remote-claude-browser-cpa-broker:local` | `cpa-broker` 的镜像，例如 `ghcr.io/notdesigned/remote-claude-browser-cpa-broker:v0.5.0` |

### 部署级出站代理（`compose.proxy.yml`）

| 变量                   | 默认      | 说明                                                                                                                                                                                                                       |
| ---------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EGRESS_PROXY`         | 无        | 使用 `compose.proxy.yml` 时必填。分享链接（`socks5://`、`http://`、`https://`、`ss://`、`vless://`、`vmess://`、`trojan://`、`hy2://`）或一段 Xray outbound JSON。需要 `EGRESS_POLICY=on`。值里有 `$` 时用单引号括起整个值 |
| `EGRESS_BOOTSTRAP_DNS` | `1.1.1.1` | 解析代理服务器自己域名的 DNS 服务器，只能写 IPv4 地址。这次查询不经过代理                                                                                                                                                  |

用法见[部署 · 部署级出站代理](deployment.md#部署级出站代理)。

### AliasMode 内核（`compose.fingerprint.yml`）

| 变量                      | 默认                        | 说明                                                                                                                                                                                  |
| ------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FINGERPRINT_BROWSER_DIR` | 无                          | 使用 `compose.fingerprint.yml` 时必填。`scripts/setup-fingerprint.sh` 安装的 AliasMode 目录的绝对路径                                                                                 |
| `FINGERPRINT_FONTS_DIR`   | `./local/fingerprint-fonts` | 使用 `compose.fingerprint.yml` 时，AliasMode 的 Windows、Mac 身份显示的字体所在目录，下分 `windows/`、`macos/`；只挂给浏览器，见[部署 · AliasMode 内核](deployment.md#aliasmode-内核) |
| `MIRROR_BROWSER_ENGINE`   | `aliasmode`                 | 之后新建的配置用哪个内核：`aliasmode` 或 `chromium`。已有配置保留自己的内核                                                                                                           |

### 收件箱（Resend）

四个变量都为空时不启用收件箱。配置步骤见[部署 · 收件箱](deployment.md#收件箱)。

| 变量                       | 说明                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `RESEND_API_KEY`           | 有读取收件权限的 Resend API Key；设置了 `RESEND_VERIFICATION_FROM` 时还要有发信权限 |
| `RESEND_WEBHOOK_SECRET`    | `email.received` Webhook 的签名密钥                                                 |
| `RESEND_RECEIVING_DOMAIN`  | 收件域名，逗号分隔，第一个是默认域名                                                |
| `RESEND_VERIFICATION_FROM` | 可选。已在 Resend 验证过的发件地址，设置后用户可以绑定已有地址                      |

### 页面模式

| 变量                  | 默认         | 说明                                                                                                                                                           |
| --------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIRROR_CANVAS_SITES` | 人机验证服务 | 页面模式会采样哪些网站的 canvas，逗号分隔；`none` 表示一个都不采样。空表示只采样 hCaptcha、reCAPTCHA、Cloudflare 和 Arkose 的验证页（`protocol/src/agent.ts`） |
| `MIRROR_INPUT_ACKS`      | `shadow`                          | 页面模式的输入确认。`off` 不发确认；`shadow` 发确认，工作台只统计（见[排查 · 输入未同步](troubleshooting.md#输入未同步)）；`on` 工作台按确认判断远程输入框是否跟上，不再按固定的约 1 秒。其他值时网关拒绝启动 |
| `MIRROR_PROXY_INPUT`     | `on` | 页面模式的单写者输入（实验）。`on` 时，输入框获得焦点后，打字先进入工作台本地的输入层，再以可信的按键和文字送到远程页面，回放里的输入框不在本地编辑（见[架构](architecture.md#页面模式和资源)）。需要输入确认：和 `MIRROR_INPUT_ACKS=off` 一起设置时，或取其他值时，网关拒绝启动。排查时可在工作台地址后加 `?input=legacy` 或 `?input=proxy`，只对这个标签页切换；`?inputlab=1` 显示它的诊断 |
| `MIRROR_LIVE_TREE`       | `1`                               | 网关是否为每个标签页保存当前的页面（实时树），从它补齐新加入、重连、切回标签页和出错的查看端。`0` 改回快照加有上限的变化记录，变化记录装满后要网页重拍整页快照。其他值时网关拒绝启动 |

### 单点登录（OIDC）

可选。设置 `MIRROR_OIDC_ISSUER` 后，登录页在用户名和密码下方多一个单点登录按钮，两种方式都能用。使用者一侧的操作见[使用 · 登录](usage.md#登录)，管理员看到的内容见[管理 · 单点登录的用户](admin.md#单点登录的用户)，信任边界见[安全 · 单点登录](security.md#单点登录)。

在身份提供方把工作台注册成**机密客户端**（confidential client）：

- 回调地址：`<MIRROR_PUBLIC_ORIGIN>/gate/oidc/callback`，例如 `https://browser.example.com/gate/oidc/callback`。
- 授权码流程，PKCE 用 `S256`；scope 为 `openid profile email`。
- 要按组指定管理员时，让 ID token 或 userinfo 带上 `groups` 声明。

| 变量                          |      必填      | 默认                   | 说明                                                                                                                                               |
| ----------------------------- | :------------: | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIRROR_OIDC_ISSUER`          |   启用时必填   | 空                     | 身份提供方的 issuer，和它的 discovery 文档里的写法完全一致（authentik 的形如 `https://auth.example.com/application/o/<应用>/`，末尾的 `/` 也要写） |
| `MIRROR_OIDC_CLIENT_ID`       | 设置 issuer 时 | 无                     | 工作台的客户端 ID                                                                                                                                  |
| `MIRROR_OIDC_CLIENT_SECRET`   | 设置 issuer 时 | 无                     | 工作台的客户端密钥，只写在 `.env` 里                                                                                                               |
| `MIRROR_OIDC_LABEL`           |       否       | `使用单点登录`         | 登录页按钮上的文字                                                                                                                                 |
| `MIRROR_OIDC_ADMIN_GROUP`     |       否       | 空                     | 这个组的成员是管理员。只作用于通过单点登录创建的用户，每次登录时同步；不会撤掉最后一个管理员                                                       |
| `MIRROR_OIDC_ALLOWED_DOMAINS` |       否       | 空                     | 允许登录的邮箱域名，逗号分隔，要求邮箱已验证（`email_verified`）。允许列表在**每次**单点登录时检查，不再满足的人无法再用单点登录进入               |
| `MIRROR_OIDC_ALLOWED_EMAILS`  |       否       | 空                     | 允许登录的邮箱，逗号分隔，要求邮箱已验证                                                                                                           |
| `MIRROR_OIDC_ALLOWED_GROUPS`  |       否       | 空                     | 允许登录的组，逗号分隔。三个允许列表都为空时，身份提供方放行的每个人都会得到一个账号                                                               |
| `MIRROR_OIDC_SESSION_DAYS`    |       否       | `7`                    | 单点登录得到的工作台登录的有效天数，1 到 60（`auth/oidc.ts`）                                                                                      |
| `MIRROR_OIDC_REVALIDATE_DAYS` |       否       | `30`                   | **没有本地密码**的用户超过这么多天没有单点登录时，其 remote-cc 令牌暂停使用，1 到 60（`auth/oidc.ts`）                                             |
| `MIRROR_OIDC_SCOPES`          |       否       | `openid profile email` | 覆盖请求的 scope，一般不用改                                                                                                                       |
| `MIRROR_OIDC_REDIRECT_URI`    |       否       | 由公开来源推出         | 覆盖回调地址，一般不用改：默认是 `<MIRROR_PUBLIC_ORIGIN>/gate/oidc/callback`。入口把工作台放在另一个地址下时才设置它                                 |

## 入口机（`client/.env`）

用于 `client/` 里带 SSH 隧道的入口，见[部署 · 独立入口机和 SSH 隧道](deployment.md#独立入口机和-ssh-隧道)。

| 变量                      | 必填 | 默认        | 说明                                                                             |
| ------------------------- | :--: | ----------- | -------------------------------------------------------------------------------- |
| `PUBLIC_HOST`             |  是  | 无          | 用户打开的域名，解析到这台入口机                                                 |
| `SERVER_SSH_HOST`         |  是  | 无          | 服务端的 SSH 地址                                                                |
| `SERVER_SSH_PORT`         |  否  | `22`        | 服务端的 SSH 端口                                                                |
| `SERVER_SSH_USER`         |  否  | `root`      | 在 `authorized_keys` 里放了隧道公钥的那个用户                                    |
| `SERVER_PORT`             |  否  | `3010`      | 和服务端 `.env` 里的 `SERVER_PORT` 一致                                          |
| `HTTP_BIND`               |  否  | `0.0.0.0`   | Caddy 发布的地址                                                                 |
| `HTTP_PORT`, `HTTPS_PORT` |  否  | `80`, `443` | Caddy 发布的端口，宿主机已经占用时修改                                           |
| `TUNNEL_IMAGE`            |  否  | 本地构建    | 预构建的隧道镜像，例如 `ghcr.io/notdesigned/remote-claude-browser-tunnel:v0.5.0` |
| `TUNNEL_PORT`             |  否  | `3010`      | 只用 `compose.tunnel-only.yml` 时，隧道发布到入口机回环地址上的端口              |

## 写在 compose 文件里的变量

下面这些不从 `.env` 读取。要改，在自己的覆盖文件里给 `server` 服务的 `environment` 加上，再把这个文件加进 `COMPOSE_FILE`。

| 变量                                      | 默认                              | 说明                                                                                                                                                               |
| ----------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MIRROR_TRUSTED_PROXIES`                  | `SERVER_SUBNET` 的值              | 可以设置 `X-Forwarded-For` 的代理地址，逗号分隔。它决定日志、登录限速和 remote-cc 批准页看到的来源 IP                                                              |
| `MIRROR_DISABLE_RTC`                      | 不设置                            | `1` 关闭页面模式里经 WebRTC 播放视频                                                                                                                               |
| `MIRROR_SCREEN_GRAB`                      | 开启                              | `0` 关闭画面模式直接截取显示内容，改用 Chromium 的截屏                                                                                                             |
| `XVFB_SCREEN`                             | `12800x2880x24`                   | 每个浏览器配置的私有虚拟显示的尺寸。显示占用的资源随运行中的配置增加                                                                                               |
| `MIRROR_USERS_DB`                         | `<数据目录>/profile/users.sqlite` | 用户数据库的路径；收件箱数据库放在它旁边。放在持久、受保护的存储上，并纳入[备份](deployment.md#备份)                                                               |
| `MIRROR_ACCOUNTS_DIR`                     | `<数据目录>/profile-accounts`     | 默认配置以外的浏览器配置存放 Chrome 资料的目录                                                                                                                     |
| `MIRROR_PROXY_SUBSCRIPTION_ALLOW_PRIVATE` | 不设置                            | `1` 允许订阅地址指向私有、回环、链路本地和其他保留地址。不设置时，导入和刷新订阅只连接公网地址（`net/public-target.ts`），任何登录的用户都不能借订阅让网关访问内网 |
| `MIRROR_CANVAS_SNAPSHOTS` | `0`（`compose.yml`）             | 页面模式是否采样 canvas。`0` 不采样；不设置时按 `MIRROR_CANVAS_SITES` 采样 |
| `MIRROR_SUBMIT_GUARD`    | `shadow`                          | 按回车前核对远程输入框的文字和工作台显示的是否一致。`off` 不核对；`shadow` 只统计结果（日志 `submit guard:`）；`on` 不一致时不发送回车（尚未默认开启）。其他值时网关拒绝启动 |
| `MIRROR_LIVE_TREE_RING_EVENTS` | `2000`                      | 每个标签页留多少个最近的增量，用来只补发查看端缺的部分；更早的查看端改发合成的快照 |
| `MIRROR_LIVE_TREE_RING_BYTES` | `2097152`（2 MiB）           | 同上，按字节计的上限 |
| `MIRROR_LIVE_TREE_TAB_MAX_NODES` | `400000`                  | 一个文档的实时树超过这么多节点时，这个文档改用快照加变化记录 |
| `MIRROR_LIVE_TREE_TAB_MAX_MB` | `48`                         | 同上，按估算的内存（MB）计 |
| `MIRROR_LIVE_TREE_TOTAL_MAX_MB` | 内存的 10%，最多 `256`      | 所有标签页的实时树加在一起的上限（MB）。超出时最久没看的后台标签页先放掉实时树，下次有人要看时再向网页要快照 |
| `MIRROR_LIVE_TREE_MAX_SIDECAR` | `20000`                     | 每个文档按顺序保存的样式表增删改的条数上限，超出时向网页要一次快照把它们合并进样式表 |
| `MIRROR_LIVE_TREE_VERIFY` | `0`                              | `1` 时，标签页空闲下来、自上次核对后又有 500 次以上的变化，最多每 30 秒向网页要一次快照，和实时树逐个节点比较；一致时不发给查看端，不一致时换用网页的快照。诊断用 |
| `MIRROR_FFMPEG`          | `ffmpeg`                          | 画面模式截取显示用的 ffmpeg 程序 |
| `MIRROR_DIAGNOSTIC_STDERR` | 不设置                          | `1` 把 Chromium 的标准错误输出写进服务端日志，排查浏览器启动失败时用；日志会变多 |
| `MIRROR_EXIT_LOOKUP_URL` | `https://ipwho.is/`               | 检查出口时，经节点查询出口地址和时区的服务。测试用来指向本地的替身，一般不用改 |
| `MIRROR_ASSET_MAX_BYTES` | `67108864`（64 MB）               | 经代理的单个网页资源的字节上限，超过即中断且不写入磁盘缓存。见[部署 · 资源与超时](deployment.md#资源与超时) |
| `MIRROR_AGENT_HARDENING` | 开启                              | `0` 退回旧的采集脚本：替换的内置函数带 `__rrweb_original__` 标记、采集时临时插入隐藏 iframe、跨域 frame 的消息用固定名字、向上滚动时派发非可信的滚轮事件，rrweb 自己采集字体和 canvas。只在排查新行为引起的问题时使用。见[威胁模型 · 页面能否察觉](security.md#页面能否察觉) |
| `MIRROR_ASSET_DIRECT_FALLBACK` | `range`                     | 浏览器取不到网页资源时，网关能否改用自己的网络下载（网站能从 TLS 特征看出不是浏览器）。`range` 只有分段请求（音视频拖动）由网关下载，其他返回 502；`off` 分段请求也不下载；`all` 旧行为，取不到就由网关下载。其他值网关拒绝启动。各种情况的次数见管理页概览接口的 `assetLanes` |

`cpa-broker` 服务的 `environment` 里还有这些，一般不用改：

| 变量                     | 默认                     | 说明 |
| ------------------------ | ------------------------ | ---- |
| `CPA_BROKER_EGRESS`      | `server:8781`            | CPA 实例的 `runtime-egress:8781` 转到的地址：服务端在 `CPA_RUNTIME_NETWORK` 上经认证的代理 |
| `CPA_BROKER_SOCKET_GID`  | `10001`                  | `cpa-broker` 的 Unix socket 所属的组，也就是网关进程的组 |
| `CPA_DOCKER_SOCKET`      | `/var/run/docker.sock`   | 容器内 Docker socket 的路径 |
| `CPA_BROKER_CONTAINER`   | 容器的主机名             | `cpa-broker` 自己的容器，它要把这个容器接入各个实例的网络。只在给它设置了 `hostname` 时才需要 |

Compose 把密码和签名密钥作为容器的环境变量传入。能查看容器或控制 Docker 守护进程的人都能读到它们，而控制 Docker 守护进程本身就等于宿主机的 root。

## 构建参数

| 参数            | 默认          | 说明                                                                                                                                                   |
| --------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DEBIAN_MIRROR` | Debian 官方源 | 构建服务端镜像时字体那一层用的 Debian 镜像源，例如 `docker compose build --build-arg DEBIAN_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian server` |

## 在 Docker 之外开发

| 变量                   | 说明                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| `CHROME_PATH`          | Chromium 或 Google Chrome 的绝对路径                                             |
| `CHROME_HEADFUL`       | `1` 以有窗口方式运行浏览器，需要 `DISPLAY`                                       |
| `CHROME_USER_DATA_DIR` | 浏览器资料、上传和下载的位置；不设置时用临时目录，退出时删除                     |
| `GATEWAY_HOST`         | 网关监听的地址，默认 `127.0.0.1`                                                 |
| `GATEWAY_PORT`         | 网关监听的端口，默认 `3000`                                                      |
| `VIEWER_PORT`          | Vite 的端口，默认 `5173`                                                         |
| `VITE_GATEWAY_URL`     | Vite 转发到的网关地址，默认 `http://127.0.0.1:3000`                              |
| `MIRROR_E2E`           | `1` 打开测试专用的路由，并关闭全部访问控制；`NODE_ENV=production` 时网关拒绝启动 |
| `BROWSER_CDP_URL`      | 连接一个已经在运行的 Chrome 的调试地址，代替网关自己启动的浏览器；这时只能用默认配置，画面模式不能直接截取显示 |
