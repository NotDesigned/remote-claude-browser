# 部署

> 读者：部署者

服务端是一个 Docker Compose 项目：`compose.yml` 运行网关、Chromium 和 Xvfb，`compose.runtime.yml` 加上按浏览器配置的出口和按用户的 CPA 实例。服务端只提供 HTTP 和 WebSocket，默认只发布到宿主机的 `127.0.0.1:3010`。域名、TLS 证书、反向代理和跨主机通道由部署者管理，入口机可以就是服务端本身。

每个变量的含义见[环境变量](configuration.md)；工作台里的操作见[使用](usage.md)和[管理](admin.md)。

## 需要准备

| 项目     | 要求                                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 系统     | Linux，Docker Engine 27.3 或更新版本（`cpa-broker` 使用 Docker API 1.47，`browser` 网络需要 Docker 分配 IPv6 子网），Compose v2 插件                                  |
| 用户命名空间 | Chromium 的沙箱需要它：`user.max_user_namespaces` 大于 0；内核有 `kernel.unprivileged_userns_clone` 时它要是 1                                                        |
| AppArmor | Docker 使用 AppArmor 的宿主机（Ubuntu、Debian 默认如此）先加载服务端的配置文件，见[安装](#安装)。它允许 Chromium 创建用户命名空间，所以 Ubuntu 的 `kernel.apparmor_restrict_unprivileged_userns` 不用改 |
| 配置     | 建议至少 2 核 4 GB 内存，会话越多需要越多；在服务器上构建镜像时另需约 2 GB 可用内存                                                                                   |
| 磁盘     | 镜像约 3 GB，另加浏览器配置的数据，见[日志和磁盘](#日志和磁盘)                                                                                                        |
| 网络     | 能访问各个节点的服务器；节点用 IPv6 上游时，宿主机要有可用的 IPv6 出站路由                                                                                            |
| 公网     | 从公网访问时，另备域名、TLS 证书和反向代理                                                                                                                            |

`pnpm check:host` 只读地检查以上各项：Docker 和 Compose v2、Docker API 版本、用户命名空间，以及 AppArmor 配置文件是否已加载（读取 AppArmor 的状态需要 root）。

## 安装

```bash
git clone https://github.com/NotDesigned/remote-claude-browser.git
cd remote-claude-browser
sudo scripts/install-apparmor.sh   # Docker 不使用 AppArmor 时它什么都不做
COMPOSE_FILE=compose.yml:compose.runtime.yml ./scripts/bootstrap.sh
echo 'COMPOSE_FILE=compose.yml:compose.runtime.yml' >> .env
```

`scripts/install-apparmor.sh` 把 `deploy/apparmor/remote-claude-browser` 装进 `/etc/apparmor.d/` 并加载，重启后仍然有效。它是 Docker 默认的配置文件加上三项：允许每个浏览器配置的网络命名空间和文件系统用到的那几种挂载，只能挂到存放网络命名空间的目录和 `/run/remote-browser/` 下各个浏览器的根目录（以及用这个目录盖住容器的顶层目录），不允许把 `/proc`、`/sys` 挂到别处；允许创建用户命名空间；允许本配置文件内的进程互发信号。没有加载它时，Docker 使用 AppArmor 的宿主机上服务端容器启动不了。

`scripts/bootstrap.sh` 在没有 `.env` 时生成一个（随机的初始管理员密码和 `MIRROR_AUTH_SECRET`），启动服务，等健康检查通过后打印访问地址和密码；已有 `.env` 时不改动它。初始管理员的用户名是 `admin`，要改的话在第一次启动前设置 `MIRROR_ADMIN_USERNAME`。

接着编辑 `.env`：

```bash
# 用户实际打开的地址，必须完全一致，否则 WebSocket 连接和表单提交会被拒绝；不设置时服务拒绝启动
MIRROR_PUBLIC_ORIGIN=https://browser.example.com
# 这台机器的公网 IP。容器看不到它，要手动填，网页才碰不到这台机器上的服务
EGRESS_BLOCK=203.0.113.10
```

然后执行：

```bash
docker compose up -d
docker compose ps
```

不想在服务器上构建镜像时，改用预构建的镜像。四个镜像都要指定，版本标签和 `git checkout` 的版本一致（下面以 `v0.5.0` 为例），不要用会随时变化的 `latest`。每个版本发布时带三个标签：`v0.5.0` 和 `0.5.0` 指同一个镜像，`0.5` 跟随这个系列最新的补丁版本；`latest` 只跟随通过 CI 的 `main`，打版本标签不会移动它：

```bash
SERVER_IMAGE=ghcr.io/notdesigned/remote-claude-browser-server:v0.5.0
CPA_BROKER_IMAGE=ghcr.io/notdesigned/remote-claude-browser-cpa-broker:v0.5.0
CPA_BROKER_ENGINE_IMAGE=ghcr.io/notdesigned/remote-claude-browser-cpa:v0.5.0
# 只在入口机的 client/.env 里：
TUNNEL_IMAGE=ghcr.io/notdesigned/remote-claude-browser-tunnel:v0.5.0
```

把前三行写进 `.env`，然后执行 `docker compose pull && docker compose up -d --no-build`。镜像只在 CI 对同一个提交通过后发布，每个都带构建来源证明，可以用 `gh attestation verify oci://<镜像> --owner NotDesigned` 核对。

登录工作台后，先在「网络与接入」→「代理来源」导入节点，再新建浏览器配置，见[使用](usage.md)。

## 可用的 compose 组合

把选定的组合写进 `.env` 的 `COMPOSE_FILE`（用 `:` 分隔），以后的 `docker compose` 命令都会带上它。

| 组合                                                      | 用途                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `compose.yml:compose.runtime.yml`                         | 标准部署：按浏览器配置的出口和按用户的 CPA 实例                         |
| `compose.yml:compose.runtime.yml:compose.https.yml`       | 再加上同一台机器上的 Caddy 和自动证书，见[公网入口](#公网入口)          |
| `compose.yml:compose.runtime.yml:compose.fingerprint.yml` | 再加上 AliasMode 内核，见[AliasMode 内核](#aliasmode-内核)              |
| `compose.yml:compose.runtime.yml:compose.proxy.yml`       | 再加上部署级出站代理，见[部署级出站代理](#部署级出站代理)               |
| `client/compose.yml`                                      | 在单独的入口机上运行，见[独立入口机和 SSH 隧道](#独立入口机和-ssh-隧道) |
| `client/compose.yml:client/compose.tunnel-only.yml`       | 入口机上已经有反向代理时只运行隧道                                      |

后三个可选文件可以同时加在 `compose.runtime.yml` 之后。只有 `compose.yml` 而没有 `compose.runtime.yml` 时，服务能启动，但任何浏览器配置都打不开。

## 公网入口

入口需要满足：

- 把**整个站点**转发给网关，包括 `/gate`（含单点登录的 `/gate/oidc/`）、`/api/`、`/s/`、`/ws`、`/v1`（CPA 调用）、`/management.html`（CPA 原生管理面板）、`/api/remote-cc/v1/`（remote-cc）和 `/api/webhooks/resend`（收件箱）。
- 支持 WebSocket 升级，关闭响应缓冲，不设置很短的响应超时。Caddy 用 `flush_interval -1`；Nginx 要关闭 `proxy_buffering`。
- 保留浏览器请求的 `Host` 和 `Origin`。网关的 `MIRROR_PUBLIC_ORIGIN` 必须等于用户打开的来源，换域名时一起改。
- 在入口终止 TLS。登录 Cookie 带 `Secure` 属性，公网必须用 HTTPS。
- 网关只信任来自 `MIRROR_TRUSTED_PROXIES` 的 `X-Forwarded-For`（默认是 `SERVER_SUBNET`，加上回环地址）。入口在别的地址时要把它加进去，否则日志、登录限速和 remote-cc 批准页看到的都是入口的地址。
- 保持 `SERVER_BIND=127.0.0.1`，或者在专网里由部署者限制网关端口的访问范围。

`/healthz` 返回 `"ok":true` 和 `"browser":true` 时网关已就绪；它不代替实际验收。上线后登录一次工作台，打开一个浏览器配置，确认页面和 WebSocket 都正常。

[examples/caddy](../examples/caddy/README.md) 给出 Caddy 在同一台机器和在独立 VPS 上的配置。

### 同一台机器上的 Caddy

没有现成的反向代理时，可以让本项目在服务端旁边运行 Caddy：把域名解析到这台机器，在 `.env` 里设置 `PUBLIC_HOST` 和 `MIRROR_PUBLIC_ORIGIN`，把 `compose.https.yml` 加进 `COMPOSE_FILE`，再执行 `docker compose up -d`。

### 独立入口机和 SSH 隧道

`client/` 在单独的入口机上运行 Caddy 和一条到服务端的 SSH 隧道，服务端的网关仍只监听回环地址。它不运行浏览器，也不保存网站登录资料。

把域名解析到入口机，然后：

```bash
git clone https://github.com/NotDesigned/remote-claude-browser.git
cd remote-claude-browser/client
cp .env.example .env   # 填写 PUBLIC_HOST 和 SERVER_SSH_HOST
mkdir -p ssh
ssh-keygen -t ed25519 -N '' -C remote-claude-browser-tunnel -f ssh/id_ed25519
ssh-keyscan -t ed25519 <服务器> > ssh/known_hosts
ssh-keygen -lf ssh/known_hosts   # 和服务端上看到的指纹核对
cat ssh/id_ed25519.pub
```

在**服务端**把这把公钥加入 `SERVER_SSH_USER` 的 `~/.ssh/authorized_keys`，前面的限制让它只能转发到网关端口，不能登录 shell：

```text
restrict,port-forwarding,permitopen="127.0.0.1:3010" ssh-ed25519 AAAA... remote-claude-browser-tunnel
```

服务端的 `sshd` 要允许 TCP 转发（`AllowTcpForwarding` 默认开启）。回到入口机：

```bash
docker compose up -d
docker compose ps
curl --fail https://browser.example.com/healthz
```

入口机的 80 和 443 已被占用时，只启动隧道，让它发布到入口机的回环地址，由已有的反向代理转发到 `127.0.0.1:3010`（`TUNNEL_PORT`）。这时 `PUBLIC_HOST` 用不到，随便填一个值：

```bash
docker compose -f compose.yml -f compose.tunnel-only.yml up -d tunnel
```

## 出口运行时

`compose.runtime.yml` 让每个绑定了节点的浏览器配置在自己的网络命名空间里经 Mihomo 和这个节点出网，网页、DNS 和 WebRTC 都走这个节点。没有部署级的默认出口：没有绑定节点的配置打不开。节点由使用者和管理员在工作台里导入和绑定，见[使用 · 出口](usage.md#出口)。

- 订阅的导入和刷新用服务端自己的网络，只能访问公网地址，内容不超过 2 MB（`egress/catalog.ts`）；要读取内网的订阅地址，设置 `MIRROR_PROXY_SUBSCRIPTION_ALLOW_PRIVATE`（见[环境变量](configuration.md#写在-compose-文件里的变量)）。浏览器和 CPA 授权各自用选定的节点。
- 节点的服务器可以是 IPv4 或 IPv6 地址。`browser` 网络是双栈；只有 Mihomo 能用上游的 IPv6，浏览器直连 IPv6 仍被阻断。
- 节点和代理来源保存在 `proxy-sources.json` 里，含节点密码和订阅地址，按密钥保护（见[备份](#备份)）。
- 这个文件还启动 `cpa-broker`，见[CPA](#cpa)。

宿主机用 Docker Desktop 时，容器的 TCP 80/443 连接可能被它的透明代理接管，干扰 Mihomo 和节点建立连接，见[排查 · 出口检查失败](troubleshooting.md#出口检查失败)。

## 部署级出站代理

`compose.proxy.yml` 用 Xray 把服务端浏览器用户（UID 10001，网关和 Chrome 都以它运行）的出站流量经一个外部代理发出，宿主机的其他程序不受影响。浏览器配置的网页流量仍走各自绑定的节点。在 `.env` 里写：

```bash
EGRESS_PROXY='vless://uuid@proxy.example.com:443?security=reality&sni=...&pbk=...&sid=...'
```

再把 `compose.proxy.yml` 加进 `COMPOSE_FILE`。

- 支持 `socks5://`、`http://`、`https://`、`ss://`、`vless://`（含 REALITY）、`vmess://`、`trojan://`、`hy2://` 分享链接；其他协议写一段 Xray outbound JSON（`protocol`、`settings`、`streamSettings`）。
- VLESS 分享链接保留 `encryption`（含 `mlkem768x25519plus`）、`flow`、REALITY 的 `pbk`、`sid`、`sni`、`pqv`（ML-DSA-65 验证公钥）和 `spx`，传输支持 RAW/TCP、WebSocket、gRPC、HTTPUpgrade 和 XHTTP。
- 不支持 SOCKS4、Shadowsocks 插件、`aid != 0` 的 VMess、HTTP/2 传输和 `allowInsecure=1`；自签证书用 `pcs`（固定证书 SHA-256）或 `vcn`（指定验证名）。不支持的写法会让服务端启动失败，不会悄悄降级。
- DNS 经代理走 DoH；WebRTC 的 UDP 也走代理，HTTP 代理不支持 UDP。
- 代理断开时没有网络，不会改用这台机器自己的地址；Xray 意外退出后自动重启。代理地址和密码只交给 Xray，网关和浏览器进程的环境里没有它们。
- 代理服务器的域名由 `EGRESS_BOOTSTRAP_DNS` 解析，这一次查询不经过代理。
- Linux 策略路由占用 priority `10010`–`10012` 和 table `20231`，DNS 地址 `198.18.0.2` 单独路由进 TUN。

## CPA

`compose.runtime.yml` 同时启用 CPA：`cpa-broker` 按固定模板为每个用户创建 CPA 实例的容器，只有它挂载 Docker socket。网关通过 Unix socket 请求实例操作，不能提交任意 Docker 参数。

- 每个实例有自己的 Docker 内部网络 `remote-browser-<实例 ID>-net`，网络里只有这个实例和 `cpa-broker`，实例之间互相访问不到。子网从 `CPA_INSTANCE_SUBNETS`（默认 `10.254.0.0/16`）里分 `/28`，和宿主机已有的网络冲突时修改它。
- 实例不对外发布端口，唯一的出口是 `runtime-egress:8781`：`cpa-broker` 把它转给服务端经认证的代理，再经各个凭据绑定的节点出网。服务端和 `cpa-broker` 之间是 `CPA_RUNTIME_NETWORK` 这个内部网络。
- 实例容器不属于 Compose 项目，`docker compose down`、`--remove-orphans` 不会删除它们，`docker compose ps` 也看不到它们。每个实例的容器、网络和卷都带标签 `dev.remote-browser.cpa-deployment=<CPA_RUNTIME_NETWORK 的值>`，用 `docker ps -a --filter label=dev.remote-browser.cpa-deployment=remote-browser-cpa-runtime` 列出本部署的实例（改过 `CPA_RUNTIME_NETWORK` 时换成它的值）；同一台 Docker 主机上别的部署的实例不在其中。
- `cpa-broker` 启动时，以及每次启动实例前，核对实例容器的镜像和模板；有变化就保留三个数据卷，重建容器，原来在运行的继续运行。所以升级后实例自动换上新的 CPA 镜像，不用手动处理。
- CPA 镜像固定为 CLIProxyAPI 8.0.68，镜像摘要写在 `deploy/Dockerfile.cpa`；原生管理面板的 HTML 版本写在 `deploy/fetch-cpa-panel.mjs`，构建镜像时核对 SHA-256，打开页面时不下载。
- 每个实例有三个数据卷：`remote-browser-<实例 ID>-config`、`-auth`、`-static`。停止实例保留这些卷；删除用户会删除他的私有实例和卷。较早创建的卷没有部署标签（Docker 不能给已有的卷加标签），`cpa-broker` 按实例 ID 认领它们：实例 ID 由网关随机生成、记在自己的数据库里，别的部署只有拿到这份数据库的副本才会用到同一个 ID。
- 入口只需转发整个站点（见[公网入口](#公网入口)），不必对外发布 CPA 的端口或 Docker socket。

使用者的操作见[使用 · CPA](usage.md#cpa)。从旧的独立 CPA 迁移见 [CHANGELOG](../CHANGELOG.md)。

## AliasMode 内核

可选。AliasMode 是一个 Chromium 内核，让新建的浏览器配置可以选择 Windows 或 Mac 系统身份（见[使用 · 系统身份](usage.md#系统身份)）。只支持 Linux x64，主机需要 `curl`、`tar` 和 `zstd`。

```bash
bash scripts/setup-fingerprint.sh "$PWD/local/aliasmode-155.0.8059.85"
```

脚本从官方发布下载完整目录并核对固定的 SHA-256，不安装系统包，也不覆盖已有版本；已经下载过压缩包时，把它的路径作为第二个参数。版本固定在脚本里。

把脚本输出的 `FINGERPRINT_BROWSER_DIR=...` 写进 `.env`，在 `COMPOSE_FILE` 末尾加上 `compose.fingerprint.yml`，然后执行 `docker compose up -d --no-deps server`。

**字体**：AliasMode 只向网页展示所选身份那个系统的字体（Windows 11 的 97 个字体族，Mac 的 184 个，清单在 `scripts/fingerprint-fonts/`），而且只展示主机上真的装了的。内核和本项目的镜像都不带这些字体；一个都没装时，Windows 身份几乎没有字体，真实的 Windows 电脑不会这样，网页量一下文字宽度就能发现。所以使用 AliasMode 时要装上两套字体：

```bash
scripts/fingerprint-fonts.sh import windows <Windows 字体所在目录>   # 例如复制来的 C:\Windows\Fonts
scripts/fingerprint-fonts.sh import macos <Mac 字体所在目录>         # /System/Library/Fonts、/Library/Fonts 等
docker compose up -d --force-recreate server
scripts/fingerprint-fonts.sh check                                   # 各身份清单上的字体族装了多少、缺哪些
```

- 字体放在 `FINGERPRINT_FONTS_DIR`（默认 `local/fingerprint-fonts`），只挂进浏览器看得到的位置；原生 Chromium 的配置看不到它们，字体清单不受影响。服务端容器每次启动时为它们建立字体缓存。
- **这些字体需要部署者自己准备**：本项目不分发，也不要提交进仓库（`local/` 已被 git 忽略）。Windows 字体可以复制自己 Windows 电脑的 `C:\Windows\Fonts`，Mac 字体复制自己 Mac 的 `/System/Library/Fonts`、`/System/Library/Fonts/Supplemental`、`/Library/Fonts`。字体的授权由部署者自己负责。
- 没装字体时 AliasMode 照常能用，只是 Windows、Mac 身份更容易被识别；升级或换服务器后记得重新运行 `scripts/fingerprint-fonts.sh check`。
- 即使是真实的字体文件，文字由 Linux 的字体引擎绘制，和真实系统仍有细微差别。

- 只有之后新建的配置使用 AliasMode，已有配置保留原来的内核。要让新配置恢复用原生 Chromium，设置 `MIRROR_BROWSER_ENGINE=chromium`。
- 只要还有使用 AliasMode 的配置，就要保留这个目录和挂载。不要只复制 `chrome` 主程序，同目录的字体、语言、图形库和资源都是内核的一部分。
- AliasMode 以独立的 GPL-3.0 程序运行，从官方发布直接下载，不随本项目的镜像分发。

## 收件箱

1. 在 Resend 给自有域名启用 Receiving，按控制台的要求配置 MX。根域已经在用 Cloudflare Email Routing 时，可以在 Resend 启用一个子域，只给子域配置 Resend 的 MX。
2. 创建一个订阅 `email.received` 的 Webhook，目标是 `https://browser.example.com/api/webhooks/resend`。
3. 在 `.env` 设置 `RESEND_RECEIVING_DOMAIN`、`RESEND_API_KEY` 和 `RESEND_WEBHOOK_SECRET`，执行 `docker compose up -d`。三个都设置后启用收件箱。
4. 可选：设置 `RESEND_VERIFICATION_FROM`（一个已在 Resend 验证的发件地址），用户就能用验证码绑定已有地址；这时 `RESEND_API_KEY` 还要有发信权限。

同一个 Resend 账户的多个收件域名共用这套配置。邮件原文保存在 Resend，工作台按需读取正文。地址的分配见[管理 · 收件地址](admin.md#收件地址)。

## 视频和 WebRTC

页面模式里，网页中的视频经 WebRTC 从服务端直接发到用户的设备，这条连接不经过入口，项目也没有内置 TURN 服务。用户的设备在对称 NAT 后面（很多手机网络都是）时，视频可能出不来，这时可以切到画面模式。设置 `MIRROR_DISABLE_RTC=1`（见[环境变量](configuration.md#写在-compose-文件里的变量)）关闭这项功能。

## 升级

部署固定的版本标签，不要直接跟随 `main` 或 `latest`。先看 [CHANGELOG](../CHANGELOG.md) 里这个版本的升级步骤，再执行：

```bash
git fetch --tags
git checkout v0.5.0                # 要升级到的版本
sudo scripts/install-apparmor.sh   # 配置文件随版本变化时重新加载
docker compose up -d --build
```

使用预构建镜像时，先把 `.env` 里三个镜像的标签改成同一个版本，再执行 `docker compose pull && docker compose up -d --no-build`。

- 升级服务端会重启浏览器，打开的远程页面和未发送的草稿会中断；用户和网站登录资料保存在 `data` 卷里，不受影响。
- `cpa-broker` 重启后把各个 CPA 实例换成新镜像（见 [CPA](#cpa)），正在进行的 CPA 调用会中断一次。
- 确认新版本正常后，用 `docker image prune` 删除不再有标签的旧镜像。`docker image prune -a` 会删掉所有没有容器使用的镜像，包括回退时要用的上一个版本，回退前不要执行它。

在国内构建时，Debian 官方源可能很慢，可以换镜像源：

```bash
docker compose build --build-arg DEBIAN_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian server
```

## 日志和磁盘

- 各服务用 Docker 的 `local` 日志驱动并自动轮转（各 compose 文件的 `logging`）：服务端最多 5 个 20 MB 的文件，`cpa-broker` 和 Caddy 更少；CPA 实例最多 2 个 2 MB 的文件。用 `docker compose logs` 和 `docker logs` 查看。
- `data` 卷随浏览器配置增长：每个配置的 Chrome 缓存、网站数据和下载都在里面，没有上限。删除不用的浏览器配置会删除它的资料。
- 用 `docker system df -v` 查看各个卷和镜像的大小；`data` 卷内部用 `docker compose exec server du -sh /data/profile /data/profile-accounts` 查看。

## 备份

需要备份的数据：

| 数据                                    | 位置                                                       | 内容                                                                       |
| --------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `users.sqlite` 及其 WAL                 | `data` 卷的 `/data/profile/`                               | 用户、密码散列、登录令牌摘要、单点登录的绑定、浏览器配置的归属             |
| `cpa.sqlite`                            | 同上                                                       | CPA 实例的归属、内部密钥、调用 Key 的摘要和归属、凭据的节点绑定            |
| `remote-cc.sqlite`                      | 同上                                                       | remote-cc 令牌的摘要，出口主机取得过的节点                                 |
| `mailboxes.sqlite`                      | 和 `users.sqlite` 同一目录                                 | 收件地址和邮件记录                                                         |
| `proxy-sources.json`                    | `/data/profile/`                                           | 代理来源和节点，含节点密码和订阅地址                                       |
| `accounts.json`、`client-sessions.json` | `/data/profile/`                                           | 浏览器配置的记录，会话的登记                                               |
| 浏览器配置数据                          | `/data/profile/browser-default`、`/data/profile-accounts/` | 各配置的 Cookie、网站登录资料和下载                                        |
| runtime 密钥                            | `/data/runtime/secret`                                     | 生成内部出口令牌的密钥。目录保持 root:root、0700，文件保持 root:root、0600 |
| 每个用户的 CPA 卷                       | `remote-browser-<实例 ID>-config`、`-auth`、`-static`      | CPA 实例的配置、Claude 授权和面板文件                                      |
| Caddy 的证书（`compose.https.yml`）     | `caddy-data` 卷                                            | 自动签发的证书和 ACME 账户；丢失后重新签发，可能碰到签发频率限制           |

前八项都在 `data` 卷里（`/data/timezone/` 是服务进程的时区，也在其中）。这些数据包含 Cookie、令牌和节点密码，备份要存放在受保护的位置，离机副本要加密。

先停服再备份，避免数据库和浏览器资料来自不同时间点。CPA 实例不属于 Compose 项目，`docker compose stop` 不会停止它们，要单独停。CPA 卷和工作台数据要一起备份，只有其中一部分恢复不了原来的实例。在 `<安装目录>` 里执行：

```bash
deployment=remote-browser-cpa-runtime   # CPA_RUNTIME_NETWORK 的值
mine="label=dev.remote-browser.cpa-deployment=$deployment"
helper=node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
cpa=$(docker ps -q --filter "$mine")
# 本部署的实例 ID：来自它的容器，以及带部署标签的卷（没有部署标签的旧卷靠容器找到）
ids=$( { docker ps -a --filter "$mine" --format '{{.Label "dev.remote-browser.cpa-instance"}}'
         docker volume ls --filter "$mine" --format '{{.Label "dev.remote-browser.cpa-instance"}}'; } | sort -u)
docker compose stop
[ -z "$cpa" ] || docker stop $cpa
mkdir -p backup
archive() {   # 卷名 归档名
  docker run --rm -v "$1":/volume:ro -v "$PWD/backup":/backup "$helper" \
    tar --numeric-owner -czf "/backup/$2.tar.gz" -C /volume .
}
archive remote-claude-browser_data data
for id in $ids; do
  for kind in config auth static; do
    volume="remote-browser-$id-$kind"
    ! docker volume inspect "$volume" >/dev/null 2>&1 || archive "$volume" "$volume"
  done
done
# 只在使用 compose.https.yml 时
archive remote-claude-browser_caddy-data caddy-data
[ -z "$cpa" ] || docker start $cpa
docker compose start
```

实际卷名用 `docker volume ls` 核对，改过项目名时相应调整。

还原时也先按上面的方法停服（同样设置 `deployment` 和 `helper`），一起还原 `data` 卷和 CPA 卷。`cpa-broker` 只接受带有它的标签的卷，所以 CPA 卷要先带标签创建，再解包：

```bash
restore() {   # 卷名 归档名
  docker run --rm -v "$1":/volume -v "$PWD/backup":/backup:ro "$helper" \
    tar --numeric-owner -xzpf "/backup/$2.tar.gz" -C /volume
}
restore remote-claude-browser_data data
for archive in backup/remote-browser-cpa-*.tar.gz; do
  volume=$(basename "$archive" .tar.gz)
  id=${volume#remote-browser-}
  id=${id%-*}
  docker volume create --label dev.remote-browser.cpa-managed=true \
    --label "dev.remote-browser.cpa-instance=$id" \
    --label "dev.remote-browser.cpa-deployment=$deployment" "$volume"
  restore "$volume" "$volume"
done
docker compose up -d
```

还原到一个已经在用的部署时，先删除同名的旧 CPA 容器（`docker rm -f remote-browser-<实例 ID>`），工作台下次启动实例时会用还原的卷重新创建。

## 资源与超时

| 项目             | 值                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 工作台登录有效期 | 用户名和密码登录 60 天；单点登录 `MIRROR_OIDC_SESSION_DAYS`，默认 7 天                                                                                                         |
| 会话宽限 | 一个会话的所有设备都断开后 15 分钟关闭它的远程页面（`MIRROR_IDLE_GRACE_MS` 可改）；claude.ai 正在生成回复或进行 CPA 授权时推迟，但断开满 30 分钟（或宽限期更长时满宽限期）后照常关闭 |
| 空闲关闭         | 没有会话使用的浏览器配置 15 分钟后关闭 Chrome 和私有显示，网站登录资料保留                                                                                                     |
| 休眠             | 休眠的会话可以恢复；连续休眠 24 小时后删除会话登记，保留配置和 Cookie。计时跨重启保留                                                                                          |
| 每人配置数       | 每个用户最多 8 个浏览器配置                                                                                                                                                    |
| 每人会话数       | 没有全局上限；管理员可以给每个用户设置上限，见[管理](admin.md#会话上限)                                                                                                        |
| 内存准入         | 新建和恢复会话时，浏览器内存超过预算减去余量（300 MiB 和预算的 10% 中较大者），或整机可用内存低于 256 MiB 时暂不启动；打开新的浏览器配置再多预留 560 MiB。已运行的会话不受影响 |
| 内存上限         | `SERVER_MEMORY`，默认 `4g`                                                                                                                                                     |
| PID              | `SERVER_PIDS_LIMIT`，默认 4096                                                                                                                                                 |
| 上传             | 单个文件 100 MB，一批 20 个文件、共 500 MB                                                                                                                                     |
| 网页资源         | 经代理的单个资源（图片、字体、样式等）最大 64 MB（`MIRROR_ASSET_MAX_BYTES` 可改），总用时 5 分钟、30 秒没有新数据即中断；音视频的分段请求不限大小。只有完整取回且会话仍在的资源才写入缓存 |
| 查看端消息       | 单条消息解压后最大 8 MiB，超过时这个连接关闭（页面会自动重连）。粘贴的文字和输入框内容都在这条限制里 |
| 出口检查         | 每个用户同时 2 个，全站同时 8 个，超过时提示稍后再试                                                                                                                           |
| 收件地址         | 每个用户自己新建和绑定的地址合计 20 个；管理员分配的不计入                                                                                                                     |
| 密码校验         | 登录和修改密码共用限制：每个 IP、每个用户同时一次，输错后等待从 0.5 秒起逐次加倍、最长 30 秒；全站同时最多 16 次                                                             |

在线连接不会因为长时间没有操作而被回收。

多个浏览器配置同时运行时，可能在内存还够的时候先碰到 PID 上限，表现为页面进程启动失败。查看容器内的 `/sys/fs/cgroup/pids.current`、`pids.max` 和 `pids.events`，`max` 计数在增长就说明创建进程或线程被拒绝了，调大 `SERVER_PIDS_LIMIT`。

## 撤销访问和清除数据

- 撤销一个用户的访问：在「管理后台」停用或删除他，见[管理](admin.md#停用和删除用户)。修改 `.env` 不会改变已有用户的密码，轮换 `MIRROR_AUTH_SECRET` 也不会撤销用户的登录。
- 清除全部数据：先按[备份](#备份)里的方法算出本部署的 `ids`，再执行 `docker compose down --volumes`，然后删除 `cpa-broker` 创建的 CPA 容器和网络（`docker ps -a`、`docker network ls` 加 `--filter label=dev.remote-browser.cpa-deployment=<CPA_RUNTIME_NETWORK 的值>` 列出），以及每个 ID 的三个卷 `remote-browser-<实例 ID>-config`、`-auth`、`-static`。不要按 `dev.remote-browser.cpa-managed` 筛选：同一台 Docker 主机上别的部署的实例也带这个标签。这个操作不可恢复。
