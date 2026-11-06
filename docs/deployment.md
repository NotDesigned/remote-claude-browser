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

脚本生成 `.env`、启动服务并等待健康检查通过，最后打印访问密码。然后编辑 `.env`：

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

## 备份

`data` 卷保存浏览器配置，里面有 Cookie 和登录令牌，备份必须加密：

```bash
docker compose stop server
docker run --rm -v remote-claude-browser_data:/data:ro -v "$PWD":/backup debian:bookworm-slim \
  tar -czf /backup/browser-data.tar.gz -C /data .
docker compose start server
```

## 更换密码和彻底清除

- 换访问密码：修改 `.env` 的 `MIRROR_ACCESS_PASSWORD`，然后 `docker compose up -d`。这不会让已记住的设备退出。
- 让所有设备退出：同时给 `MIRROR_ACCESS_SECRET` 换一个新的随机值（`openssl rand -hex 32`）。
- 清除全部登录状态：`docker compose down --volumes`。这个操作不可恢复。

## 资源

`SERVER_MEMORY`（默认 4g）是容器的内存上限。新会话按这个上限做准入检查，内存不足时会被拒绝，已有会话不受影响。`MIRROR_CLIENTS` 决定会话名额，可选 2、5、8、16。每个活跃页面都要占用内存，多路真实负载的容量请按自己的使用情况测试。
