# 部署

项目分成两部分，都用 Docker Compose 部署：

- **服务端**（仓库根目录的 `compose.yml`）：运行 Chromium、Xvfb 和网关，保存网站的登录状态。
- **客户端**（`client/compose.yml`）：对外的入口机。Caddy 负责 HTTPS，SSH 隧道把请求转发到服务端。这台机器不运行浏览器，也不保存登录状态。

如果只有一台机器，不需要客户端，用 `compose.https.yml` 即可，见[单机部署](#单机部署)。

## 需要准备

|                | 服务端                               | 客户端                 |
| -------------- | ------------------------------------ | ---------------------- |
| 系统           | Linux，Docker 和 Compose v2          | 同左                   |
| 配置           | 建议至少 2 核 4 GB，会话越多需要越多 | 1 核 512 MB 足够       |
| 磁盘           | 约 3 GB 镜像，加上浏览器配置         | 约 100 MB              |
| 网络           | 能访问目标网站，入口机能 SSH 进来    | 80、443 端口，一个域名 |

本地构建服务端镜像时，额外需要约 2 GB 可用内存。配置较低的机器可以使用预构建镜像。

## 服务端

```bash
git clone https://github.com/NotDesigned/remote-claude-browser.git remote-claude-browser
cd remote-claude-browser
./scripts/bootstrap.sh
```

脚本生成 `.env`、启动服务并等待健康检查通过，最后打印初始管理员密码。默认用户名是 `admin`，可在首次初始化前用 `MIRROR_ADMIN_USERNAME` 修改。然后编辑 `.env`：

```bash
# 用户实际打开的地址，必须完全一致，否则 WebSocket 连接会被拒绝
MIRROR_PUBLIC_ORIGIN=https://browser.example.com
# 这台机器的公网 IP。容器看不到它，要手动填，网页才碰不到这台机器上的服务
EGRESS_BLOCK=203.0.113.10
```

让配置生效：

```bash
docker compose up -d
docker compose ps
```

网关只监听服务端的 `127.0.0.1:3010`，公网无法直接访问。

### 前端用户与浏览器配置

工作台使用用户名和密码登录。`MIRROR_ACCESS_PASSWORD` 只用于空数据库的初始管理员创建；已有用户以后由数据库管理，修改环境变量不会重置其密码。

管理员在 ⋯ 菜单的用户管理中创建用户、修改名称或角色、禁用用户、重置密码和删除用户。普通用户只能访问自己的浏览器配置和会话，各自可以自由登录浏览器内的网站；前端用户不会自动获得任何网站账号。用户登录最多保留 60 天，密码或角色变更、禁用和删除会撤销已有登录。

每个用户的浏览器配置使用独立的 Chrome 进程和磁盘目录。同一用户可以新建、选择自己的多个浏览器配置；多个会话选择同一配置时会共享其中的网站登录状态。所有用户仍共享容器的 CPU、内存和全局会话名额。

所有 Chrome（包括旧默认配置）都在实际使用时才启动，没有会话使用的配置空闲 120 秒后会关闭进程，磁盘上的网站登录资料继续保留。每次会话运行都使用新的随机资源令牌密钥，缓存按密封令牌区分；即使会话名额被其他用户复用，也不会取得之前用户的资源缓存。运行实例关闭或变更后，旧令牌失效，进行中的资源请求也会重新检查实例身份。

首次升级时，旧默认配置和已有其他配置统一归初始管理员，不会把这些网站 Cookie 复制给新用户。旧设备 Cookie 不能代替用户身份，升级后需要重新登录。迁移只执行一次，删除用户后留下的浏览器资料不会在重启时被重新认领给管理员。

用户数据默认保存在 `/data/profile/users.sqlite`，包括用户、密码散列、登录令牌摘要和浏览器配置归属。删除用户会撤销其登录并停止其会话，但保留磁盘上的浏览器数据和全局配置记录；删除前端用户不是磁盘数据擦除操作。备份时必须同时保存 SQLite 和浏览器配置，见[备份](#备份)。

### 时区

在 `.env` 里用 `TZ` 写一个 IANA 时区名，例如 `TZ=Asia/Shanghai`，未设置时为 UTC。夏令时自动处理。详见[时区说明](timezone.md)。

### 出站代理

想让远程浏览器的流量全部从另一个出口出去，在 `.env` 里写：

```bash
EGRESS_PROXY=vless://uuid@proxy.example.com:443?security=reality&sni=...&pbk=...&sid=...
```

再在 compose 文件列表里加上 `compose.proxy.yml`（比如 `COMPOSE_FILE=compose.yml:compose.hostnet.yml:compose.proxy.yml`）。`deploy-container.sh` 看到 `.env` 里有 `EGRESS_PROXY` 会自动加上，部署完会打印网页的出口 IP。

- 支持 `socks5://`、`http://`、`https://`、`ss://`、`vless://`（含 REALITY）、`vmess://`、`trojan://`、`hy2://` 分享链接；其他协议可以直接写一段 Xray outbound JSON（使用 `protocol`、`settings` 和 `streamSettings`）。
- 容器里的 Xray 建一个 TUN，只接管浏览器用户（uid 10001，Chrome 和网关都是它）的流量，宿主机和其他程序不受影响，`compose.hostnet.yml` 下也一样。网页的 DNS 经代理走 DoH，WebRTC 的 UDP 也走代理，这需要代理支持 UDP（SOCKS5 UDP、Shadowsocks、VLESS、VMess、Trojan、Hysteria2 都可以；HTTP 代理不行，此时网页里的 WebRTC 连不上）。
- 代理断了或连不上时，网页直接没有网络，不会改用这台机器自己的 IP。Xray 意外退出会在两秒后重启。
- 代理的服务器名用 `EGRESS_BOOTSTRAP_DNS`（默认 `1.1.1.1`）解析，这一次查询不经过代理。
- 代理地址和密码只交给 Xray，浏览器和网关进程的环境里没有它们。
- VLESS 分享链接完整保留 `encryption`（含 `mlkem768x25519plus`）、`flow`、REALITY 的 `pbk`/`sid`/`sni`、`pqv`（ML-DSA-65 验证公钥）和 `spx`；支持 RAW/TCP、WebSocket、gRPC、HTTPUpgrade 和 XHTTP。`support-x25519mlkem768` 是分享链接的能力提示，Xray 的 Chrome 指纹自动协商密钥交换，无需额外开关。
- 从旧版本升级：常见分享链接继续使用；原 sing-box JSON 必须转为 Xray JSON，否则启动会明确报错。SOCKS4、Shadowsocks 插件、旧 VMess `aid != 0`、HTTP/2 transport 和 `allowInsecure=1` 不再支持（TLS 自签证书请使用 `pcs` 固定证书 SHA256 或 `vcn` 指定验证名），不会静默降级。
- Linux 策略路由保留 priority `10010`–`10012` 和 table `20231`。规则按浏览器 UID 选择连接（包括 WebRTC 绑定网卡的 UDP），网关 HTTP 监听端口的回复使用主路由；DNS 地址 `198.18.0.2` 单独路由进 TUN，兼容 Docker 内置解析器。主机网络部署应避免与这些标识冲突。
- 链接或 JSON 里有 `$` 时，用单引号把整个值括起来，否则 compose 会把它当成变量。

### 使用预构建镜像

不想在服务器上构建时，在 `.env` 里指定镜像：

```bash
SERVER_IMAGE=ghcr.io/notdesigned/remote-claude-browser-server:latest
```

```bash
docker compose pull
docker compose up -d
```

## 客户端（入口机）

把域名解析到这台机器，然后：

```bash
git clone https://github.com/NotDesigned/remote-claude-browser.git remote-claude-browser
cd remote-claude-browser/client
cp .env.example .env
```

编辑 `.env`，填写 `PUBLIC_HOST` 和 `SERVER_SSH_HOST`。然后为隧道生成一把专用的 SSH 密钥，并记录服务端的主机指纹：

```bash
mkdir -p ssh
ssh-keygen -t ed25519 -N '' -C remote-claude-browser-tunnel -f ssh/id_ed25519
ssh-keyscan -t ed25519 server.example.com > ssh/known_hosts
ssh-keygen -lf ssh/known_hosts   # 和服务端上看到的指纹核对
cat ssh/id_ed25519.pub
```

在**服务端**把这把公钥加入 `SERVER_SSH_USER` 用户的 `~/.ssh/authorized_keys`。前面的限制让它只能转发到网关端口，不能登录 shell：

```text
restrict,port-forwarding,permitopen="127.0.0.1:3010" ssh-ed25519 AAAA... remote-claude-browser-tunnel
```

服务端的 `sshd` 需要允许 TCP 转发（`AllowTcpForwarding` 默认开启）。回到入口机启动：

```bash
docker compose up -d
docker compose ps
curl --fail https://browser.example.com/healthz
```

### 入口机上已经有反向代理

如果 80 和 443 已被占用，可以只启动隧道，发布到本机回环地址，由已有的代理转发。`PUBLIC_HOST` 这时用不到，随便填一个值即可：

```bash
docker compose -f compose.yml -f compose.tunnel-only.yml up -d tunnel
```

代理需要支持 WebSocket，并且关闭响应缓冲。以 Caddy 为例：

```text
browser.example.com {
    reverse_proxy 127.0.0.1:3010 {
        flush_interval -1
    }
}
```

## 单机部署

把域名解析到这台机器，在 `.env` 里设置 `PUBLIC_HOST` 和 `MIRROR_PUBLIC_ORIGIN`，然后：

```bash
docker compose -f compose.yml -f compose.https.yml up -d
```

## 从 systemd 部署迁移

`deploy/remote/migrate-to-docker.sh` 把[双机 systemd 部署](operations.md)换成 Docker，在入口机上分步执行：

```bash
export REPO_URL=https://github.com/NotDesigned/remote-claude-browser.git
export SERVER_IMAGE=ghcr.io/notdesigned/remote-claude-browser-server:latest
export TUNNEL_IMAGE=ghcr.io/notdesigned/remote-claude-browser-tunnel:latest

bash deploy/remote/migrate-to-docker.sh prepare   # 在服务端安装 Docker，备好镜像，不影响运行中的服务
bash deploy/remote/migrate-to-docker.sh cutover   # 切换服务端，打开的页面会中断，不健康时自动退回
bash deploy/remote/migrate-to-docker.sh tunnel    # 切换入口机的隧道，反向代理不用改
bash deploy/remote/migrate-to-docker.sh rollback  # 随时退回 systemd
```

迁移后服务端使用主机网络（见[视频播放](#视频播放)）。迁移会把 Chrome 配置复制给容器里的 Chromium，原配置不会被修改。容器里的 Chromium 版本不能低于原来的 Chrome，否则配置无法打开。网站会看到浏览器品牌变成 Chromium，部分网站可能要求重新验证。退回 systemd 后，在容器里新产生的登录状态不会带回去。

## 视频播放

页面模式下，网站的视频通过 WebRTC 从服务端直接发到你的设备，这条连接不经过入口机，项目也没有内置 TURN 服务。默认的 Docker 桥接网络多了一层 NAT，如果你的设备也在对称 NAT 后面（很多手机网络都是），视频可能出不来。

服务端有公网 IP 时，可以改用主机网络，行为就和直接运行在主机上一样：

```bash
docker compose -f compose.yml -f compose.hostnet.yml up -d
```

要长期使用，在 `.env` 里写上 `COMPOSE_FILE=compose.yml:compose.hostnet.yml`。代价是隔离变弱：防火墙规则写进主机的规则表（只针对浏览器用户），被攻破的浏览器能访问的范围就只靠这些规则限制。

设置 `MIRROR_DISABLE_RTC=1` 可以关闭这项功能。

## 升级

```bash
git pull
docker compose up -d --build   # 使用预构建镜像时：docker compose pull && docker compose up -d
```

升级服务端会重启浏览器，打开的远程页面和未发送的草稿会中断。登录状态保存在 `data` 卷里，不受影响。

### 资源紧张的双机部署

`deploy/remote/deploy-container.sh` 可从入口机发布已经构建、验收过的网关和前端产物。在运行中的服务端镜像上只增加文件层，不在服务端安装依赖或编译源码，保留现有 Chromium 与持久化浏览器资料。这要求基础镜像已提供 Node 22.23.1、`node:sqlite`、`tzdata` 和标准的 `/data/profile` 布局；依赖或运行环境变更应改用完整镜像升级。

```bash
# 先在受限资源环境完成构建和验收，再执行发布。
export REMOTE_HOST=server.example.com
export REMOTE_SSH_IDENTITY=/path/to/administrative-ssh-key
export REMOTE_SSH_KNOWN_HOSTS=/path/to/verified-known-hosts
export DEPLOY_SESSION_CAPACITY=8
bash deploy/remote/deploy-container.sh
```

此处 SSH 身份必须有部署权限，不能使用只允许端口转发的隧道密钥。脚本默认服务端目录为 `/opt/claude-browser/docker`，可用 `REMOTE_SERVER_DIR` 覆盖。镜像准备与校验通过后，脚本短暂停服，备份用户数据库、会话归属等管理元数据，再切换容器；失败会恢复旧镜像、Compose 配置和这些元数据。脚本不替换浏览器数据目录，也不代替完整备份。

发布只更换镜像，服务端 `.env` 里的 `TZ` 和 `MIRROR_CLIENTS` 保持不变；需要改会话容量时，用 `DEPLOY_SESSION_CAPACITY` 指定一个正整数。受保护的发布记录和回滚备份保存在服务端 `/opt/claude-browser/container-releases/`，其中含凭据，应按完整数据备份保护。

## 备份

`data` 卷保存浏览器配置、`users.sqlite` 及其 WAL、配置归属和时区状态。里面有 Cookie 和登录令牌，备份应存放在受保护位置，离机副本应加密。先停服再备份整个卷，避免 SQLite 与浏览器资料来自不同时间点：

```bash
docker compose stop server
docker run --rm -v remote-claude-browser_data:/data:ro -v "$PWD":/backup debian:bookworm-slim \
  tar -czf /backup/browser-data.tar.gz -C /data .
docker compose start server
```

实际卷名可用 `docker volume ls` 核对；自定义了项目名时要相应调整。还原也应先停服，并一起还原数据库和配置目录，保留原 UID/GID 及权限。

## 更换密码和彻底清除

- 换用户密码：在管理员用户管理中重置密码，该用户已记住的登录会被撤销。修改 `.env` 不会覆盖已有数据库的密码。
- 撤销用户访问：禁用或删除用户；角色变更也会撤销其现有登录。签名密钥轮换不等于撤销 SQLite 里的用户登录。
- 清除全部登录状态：`docker compose down --volumes`。这个操作不可恢复。

## 资源

`SERVER_MEMORY`（默认 4g）是容器的内存上限。新会话按这个上限做准入检查，内存不足时会被拒绝，已有会话不受影响。`MIRROR_CLIENTS` 决定所有前端用户共享的会话总名额，默认 `8`，接受任意正的安全整数，不限制在线设备数量，也不限制画面模式数量。降低名额不会强制终止已有会话；占用未降到上限以下前不会接收新会话。每个活跃页面都要占用内存，新增用户首次使用也会启动独立 Chrome，多路真实负载的容量请按实际页面测试。
