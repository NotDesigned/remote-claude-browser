# 环境变量

> 读者：部署者（查表）

服务端读取仓库根目录的 `.env`，入口机读取 `client/.env`。两个文件都不进 Git，不要提交填好的文件。`scripts/bootstrap.sh` 会为服务端生成 `.env`，`.env.example` 列出了每个变量的示例。

改完 `.env` 后执行 `docker compose up -d` 让它生效。各 compose 文件的组合方式见[部署 · 可用的 compose 组合](deployment.md#可用的-compose-组合)。

## 服务端（`.env`）

### 基本

| 变量                     |      必填      | 默认                 | 说明                                                                                                                                                                                                 |
| ------------------------ | :------------: | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPOSE_FILE`           |       是       | `compose.yml`        | Docker Compose 自己读取的文件列表，用 `:` 分隔。要打开浏览器配置，必须包含 `compose.runtime.yml`                                                                                                     |
| `MIRROR_ACCESS_PASSWORD` |       是       | 无                   | 初始管理员的密码，至少 8 个字符。只在用户数据库为空时使用；之后修改它不会改变任何用户的密码。Compose 要求它非空                                                                                      |
| `MIRROR_ADMIN_USERNAME`  |       否       | `admin`              | 初始管理员的用户名。只在用户数据库为空时使用，之后修改它不会给已有用户改名                                                                                                                           |
| `MIRROR_AUTH_SECRET`     |       是       | 无                   | 至少 16 个字符（`production-guard.ts`），用 `openssl rand -hex 32` 生成并保持不变。用于签名设备和会话归属，以及派生 remote-cc 会话授权的签名密钥。轮换它不会撤销用户的工作台登录                     |
| `MIRROR_PUBLIC_ORIGIN`   | 从公网访问时是 | 空                   | 用户实际打开的来源，例如 `https://browser.example.com`。来自其他来源的 WebSocket 会被拒绝；单点登录的回调地址也由它推出。只在本机试用时可以留空                                                      |
| `MIRROR_START_URL`       |       否       | `https://claude.ai/` | 新会话打开的第一个页面                                                                                                                                                                               |
| `MIRROR_IDLE_GRACE_MS`   |       否       | 900000（15 分钟）    | 一个会话的所有设备都断开后，过多久关闭它的远程页面，单位毫秒（`session/resource-policy.ts`）；必须是不小于 0 的整数，否则网关拒绝启动                                                                |
| `SERVER_IMAGE`           |       否       | 本地构建             | 预构建的服务端镜像，例如 `ghcr.io/notdesigned/remote-claude-browser-server:latest`                                                                                                                   |
| `TZ`                     |       否       | `Etc/UTC`            | 服务进程和日志的时区。无效的 IANA 时区名会让容器启动失败。浏览器的时区不看它，而是跟随各自的出口（见[使用 · 当地时间](usage.md#当地时间)）。`docker compose exec server date -Is` 显示服务进程的时间 |

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
| `CPA_RUNTIME_NETWORK`     | `remote-browser-cpa-runtime`             | CPA 实例所在的 Docker 内部网络的名称 |
| `CPA_BROKER_ENGINE_IMAGE` | `remote-claude-browser-cpa:local`        | CPA 实例使用的镜像                   |
| `CPA_BROKER_IMAGE`        | `remote-claude-browser-cpa-broker:local` | `cpa-broker` 的镜像                  |

### 部署级出站代理（`compose.proxy.yml`）

| 变量                   | 默认      | 说明                                                                                                                                                                                                                       |
| ---------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EGRESS_PROXY`         | 无        | 使用 `compose.proxy.yml` 时必填。分享链接（`socks5://`、`http://`、`https://`、`ss://`、`vless://`、`vmess://`、`trojan://`、`hy2://`）或一段 Xray outbound JSON。需要 `EGRESS_POLICY=on`。值里有 `$` 时用单引号括起整个值 |
| `EGRESS_BOOTSTRAP_DNS` | `1.1.1.1` | 解析代理服务器自己域名的 DNS 服务器，只能写 IPv4 地址。这次查询不经过代理                                                                                                                                                  |

用法见[部署 · 部署级出站代理](deployment.md#部署级出站代理)。

### AliasMode 内核（`compose.fingerprint.yml`）

| 变量                      | 默认        | 说明                                                                                                  |
| ------------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| `FINGERPRINT_BROWSER_DIR` | 无          | 使用 `compose.fingerprint.yml` 时必填。`scripts/setup-fingerprint.sh` 安装的 AliasMode 目录的绝对路径 |
| `MIRROR_BROWSER_ENGINE`   | `aliasmode` | 之后新建的配置用哪个内核：`aliasmode` 或 `chromium`。已有配置保留自己的内核                           |

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
| `MIRROR_OIDC_ALLOWED_DOMAINS` |       否       | 空                     | 允许**首次**登录的邮箱域名，逗号分隔，要求邮箱已验证（`email_verified`）                                                                           |
| `MIRROR_OIDC_ALLOWED_EMAILS`  |       否       | 空                     | 允许首次登录的邮箱，逗号分隔，要求邮箱已验证                                                                                                       |
| `MIRROR_OIDC_ALLOWED_GROUPS`  |       否       | 空                     | 允许首次登录的组，逗号分隔。三个允许列表都为空时，身份提供方放行的每个人都会得到一个账号                                                           |
| `MIRROR_OIDC_SESSION_DAYS`    |       否       | `7`                    | 单点登录得到的工作台登录的有效天数，1 到 60（`auth/oidc.ts`）                                                                                      |
| `MIRROR_OIDC_REVALIDATE_DAYS` |       否       | `30`                   | **没有本地密码**的用户超过这么多天没有单点登录时，其 remote-cc 令牌暂停使用，1 到 60（`auth/oidc.ts`）                                             |
| `MIRROR_OIDC_SCOPES`          |       否       | `openid profile email` | 覆盖请求的 scope，一般不用改                                                                                                                       |
| `MIRROR_OIDC_REDIRECT_URI`    |       否       | 由公开来源推出         | 覆盖回调地址，一般不用改。没有设置 `MIRROR_PUBLIC_ORIGIN` 时必须设置它                                                                             |

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
| `TUNNEL_IMAGE`            |  否  | 本地构建    | 预构建的隧道镜像，例如 `ghcr.io/notdesigned/remote-claude-browser-tunnel:latest` |
| `TUNNEL_PORT`             |  否  | `3010`      | 只用 `compose.tunnel-only.yml` 时，隧道发布到入口机回环地址上的端口              |

## 写在 compose 文件里的变量

下面这些不从 `.env` 读取。要改，在自己的覆盖文件里给 `server` 服务的 `environment` 加上，再把这个文件加进 `COMPOSE_FILE`。

| 变量                     | 默认                              | 说明                                                                                                  |
| ------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `MIRROR_TRUSTED_PROXIES` | `SERVER_SUBNET` 的值              | 可以设置 `X-Forwarded-For` 的代理地址，逗号分隔。它决定日志、登录限速和 remote-cc 批准页看到的来源 IP |
| `MIRROR_DISABLE_RTC`     | 不设置                            | `1` 关闭页面模式里经 WebRTC 播放视频                                                                  |
| `MIRROR_SCREEN_GRAB`     | 开启                              | `0` 关闭画面模式直接截取显示内容，改用 Chromium 的截屏                                                |
| `XVFB_SCREEN`            | `12800x2880x24`                   | 每个浏览器配置的私有虚拟显示的尺寸。显示占用的资源随运行中的配置增加                                  |
| `MIRROR_USERS_DB`        | `<数据目录>/profile/users.sqlite` | 用户数据库的路径；收件箱数据库放在它旁边。放在持久、受保护的存储上，并纳入[备份](deployment.md#备份)  |
| `MIRROR_ACCOUNTS_DIR`    | `<数据目录>/profile-accounts`     | 默认配置以外的浏览器配置存放 Chrome 资料的目录                                                        |

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
