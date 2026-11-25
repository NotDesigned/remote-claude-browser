# Caddy 入口示例

> 读者：部署者

这里的两个 Caddyfile 由部署者装到入口机上，独立于服务端的 Compose 配置。入口需要满足的条件和转发的路径见 [docs/deployment.md · 公网入口](../../docs/deployment.md#公网入口)；已有 Nginx 或其他反向代理时，按同一份要求配置即可。

两个示例都把**整个站点**转发给网关，因此 `/v1`、`/management.html`、`/api/remote-cc/v1/` 和 `/api/webhooks/resend` 也会一起对外发布。两者都设置了 `flush_interval -1`，让流式响应立即到达客户端；Caddy 本身支持 WebSocket。

## Caddy 与服务端在同一台机器

[`same-host.Caddyfile`](same-host.Caddyfile) 指向 `compose.yml` 默认发布的 `127.0.0.1:3010`。改掉文件里的域名；改过 `SERVER_PORT` 的，同步改上游端口。把这个站点并入你的 Caddy 配置，再按你的方式校验并重载 Caddy。

服务端的 `.env`：

```bash
MIRROR_PUBLIC_ORIGIN=https://browser.example.com
SERVER_BIND=127.0.0.1
```

如果 Caddy 运行在另一个容器里，那个容器的 `127.0.0.1` 不是服务端所在的主机，要按你的容器网络改上游地址。由本项目在同一台机器上运行 Caddy 的做法见 [docs/deployment.md](../../docs/deployment.md#可用的-compose-组合)。

只有让 Caddy 自动申请证书时，才需要把域名解析到入口机并满足 Caddy 的签发条件；证书也可以由已有入口管理。本项目不会创建 DNS 记录、部署证书或改动你的 Caddy 服务。

## Caddy 在独立的 VPS 上

先让 VPS 能通过你维护的通道访问网关，例如 SSH 本地转发、VPN 或专网。下面是一个前台运行的 SSH 本地转发示例，不会安装后台服务：

```bash
ssh -NT -L 127.0.0.1:13010:127.0.0.1:3010 <服务器>
```

在另一个终端确认上游可达：

```bash
curl --fail http://127.0.0.1:13010/healthz
```

[`separate-vps.Caddyfile`](separate-vps.Caddyfile) 从环境变量读取两个值：

```bash
PUBLIC_HOST=browser.example.com
BROWSER_UPSTREAM=127.0.0.1:13010
```

把它们写进实际运行 Caddy 的服务的环境；只在终端里 `export` 不会改变已有 systemd 服务的环境。用 VPN 时，把 `BROWSER_UPSTREAM` 改成专网上可达的网关地址。上游本身提供 HTTPS 时，可以写 `https://origin.example.com` 并保留证书验证；这个名字要解析到服务端，不能指回入口站点本身，否则会形成循环。

服务端的 `MIRROR_PUBLIC_ORIGIN` 仍然是用户访问的 `https://browser.example.com`，不是隧道地址或服务端地址。SSH 凭据、主机指纹、转发进程的生命周期和访问限制由部署者管理。

## 验证

先检查网关健康，再实际登录工作台、打开一个浏览器配置，确认页面和 WebSocket 都正常。

用本项目固定版本的 Caddy 镜像解析两个示例，检查入口和上游的对应关系：

```bash
node --test examples/caddy/ingress.test.mjs
```

这个检查需要 Docker，只运行临时的 Caddy 配置解析，不启动入口，也不申请证书。
