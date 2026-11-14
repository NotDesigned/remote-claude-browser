# Caddy 入口示例

这些文件由部署者安装到入口机，独立于浏览器服务的 Compose 配置。浏览器服务只需提供可达的 HTTP 上游；域名解析、TLS 证书和跨主机通道由部署者维护。已有 Nginx 或其他反向代理时也可沿用，转发同一套 HTTP 和 WebSocket 路径。

## Caddy 与浏览器服务同机

[`same-host.Caddyfile`](same-host.Caddyfile) 指向根目录 `compose.yml` 默认发布的 `127.0.0.1:3010`。修改文件里的域名；如果更改了 `SERVER_PORT`，同步修改上游端口。将站点配置并入你自己的 Caddy 配置，然后按该部署的方式校验和重载 Caddy。

浏览器服务的 `.env` 应设置：

```bash
MIRROR_PUBLIC_ORIGIN=https://browser.example.com
SERVER_BIND=127.0.0.1
```

只有部署者选择 Caddy 自动申请证书时，才需要把域名解析到入口机，并满足 Caddy 的证书签发条件；也可以由已有入口管理证书。项目不会创建 DNS 记录、部署证书或改写你的 Caddy 服务。

同机 Caddy 如果运行在另一个容器中，该容器的 `127.0.0.1` 不是浏览器宿主机。此时应按你的容器网络配置设置上游，或继续使用兼容的 `compose.https.yml`，其上游已设置为同网络的 `server:3010`。

## Caddy 位于独立 VPS

先让 VPS 通过你维护的通道访问浏览器网关，例如 SSH 本地转发、VPN 或已有专网。下面是一个前台 SSH 本地转发示例，不会自动安装后台服务：

```bash
ssh -NT -L 127.0.0.1:13010:127.0.0.1:3010 browser-host
```

在另一个终端验证 VPS 上游：

```bash
curl --fail http://127.0.0.1:13010/healthz
```

[`separate-vps.Caddyfile`](separate-vps.Caddyfile) 使用两个仅供 Caddy 配置替换的环境变量：

```bash
PUBLIC_HOST=browser.example.com
BROWSER_UPSTREAM=127.0.0.1:13010
```

将它们交给实际运行 Caddy 的服务环境；只在终端 `export` 不会改变现有 systemd 服务的环境。若使用自己的 VPN，可把 `BROWSER_UPSTREAM` 改为专网上可达的网关地址。若上游本身提供 HTTPS，可填写 `https://origin.example.com`，保留证书验证；这个上游名称应解析到源站，不能再指回同一个入口站点造成循环。

浏览器服务的 `MIRROR_PUBLIC_ORIGIN` 仍是用户访问的 `https://browser.example.com`，不是隧道地址或源站地址。SSH 凭据、已核验的主机指纹、转发进程的生命周期和访问限制由部署者管理。

## 验证

Caddy 原生支持 WebSocket。两个示例都转发完整站点，并设置 `flush_interval -1`，供流式消息立即到达客户端。先检查网关健康，再实际登录工作台、选择浏览器配置，确认页面和 WebSocket 连接可用。

使用本项目固定的 Caddy 镜像解析并验证示例的入口与上游映射：

```bash
node --test examples/caddy/ingress.test.mjs
```

该检查需要 Docker，只运行临时 Caddy 配置解析进程，不启动入口服务或申请证书。

## 已有 Compose 部署

根目录的 `compose.https.yml`、`compose.cpa.https.yml` 以及 `client/` 保留原路径，供已有部署和升级使用。不要为了采用这些示例直接删除现有 `.env` 中的 `COMPOSE_FILE`，也不要对已有数据卷执行 `down --volumes`。如需改变入口拓扑，先建立新通道并验证访问，再由部署者切换入口配置。

CPA 的现有同入口路由见 [`docs/cpa.md`](../../docs/cpa.md)。这些浏览器入口示例不会自动发布 CPA 面板或 API。
