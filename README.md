# Remote Claude Browser

在自己的服务器上运行一个真实的 Chromium，然后在任意设备的浏览器里使用它打开的网页，包括 Claude 的官方网页版。

网页的脚本、Cookie 和网络请求都留在服务器上。你的设备收到的是重建后的无脚本页面，所以文字依然清晰，可以选择、复制和查找；重建不了的内容可以切到实时画面操作。

基于 [Remote Browser](https://github.com/mystxcal/remote-browser)（Apache-2.0）修改，上游版本记录在 [UPSTREAM_COMMIT](UPSTREAM_COMMIT)，原始介绍保留在 [UPSTREAM.md](UPSTREAM.md)。

> 这是一个独立项目，与 Anthropic 没有关联，也未获其认可。Claude 是 Anthropic 的商标。你需要自己遵守所访问网站的服务条款。本项目不保证匿名，也不保证能通过任何网站的验证。

## 功能

- **页面模式**：无脚本的 DOM 镜像，低带宽，文字可选可复制，支持中文输入法
- **画面模式**：登录、验证码或复杂页面显示不全时，查看并操作真实的浏览器画面
- **独立用户**：用用户名和密码登录工作台；不同用户有各自的 Chrome 和浏览器配置，网站登录自由选择
- **多会话**：同一用户可以打开多个独立窗口、标签页和视口，也可以在 ⋯ 菜单里新建并选择自己的浏览器配置
- **指纹隔离**：每个浏览器配置有自己的屏幕尺寸、字体和字体渲染，网站看到的是不同的设备指纹；不往页面里加噪声，也不改写浏览器 API，检测站不会判为篡改或自动化。音频、WebGL、CPU 和出口 IP 仍然相同
- **用户管理**：管理员可以创建、禁用、修改和删除前端用户，或重置其密码；身份和配置归属保存在 SQLite 中
- **手机可用**：触屏操作，可请求手机版网页
- **文件**：调起本机文件选择器上传；下载边传边存，不长期占用服务器磁盘
- **视频和语音**：页面里的视频通过 WebRTC 播放，声音和麦克风都在你自己的设备上
- **断线恢复**：刷新或重连后回到原来的会话，页面崩溃会自动恢复
- **可选 CPA API**：独立授权 Claude Code 账号，提供兼容 API 和管理面板，独立保存凭据并经 Xray 出站；见 [CPA 部署](docs/cpa.md)

## 部署结构

```mermaid
flowchart LR
    U["你的设备<br/>任意浏览器"] -->|HTTPS| C
    subgraph entry ["客户端：入口机（client/）"]
      C["Caddy"] --> T["SSH 隧道"]
    end
    T -->|SSH| S
    subgraph host ["服务端（compose.yml）"]
      S["网关"] --- B["Chromium + Xvfb"]
    end
    B --> W["网站"]
```

| 部分   | 文件                 | 作用                                                                   |
| ------ | -------------------- | ---------------------------------------------------------------------- |
| 服务端 | `compose.yml`        | 浏览器、网关和登录状态都在这里，端口默认只绑定本机回环地址             |
| 客户端 | `client/compose.yml` | 对外的入口：自动申请 HTTPS 证书，通过 SSH 隧道转发到服务端，不跑浏览器 |
| 单机   | `compose.https.yml`  | 只有一台机器时用，把 Caddy 和服务端放在一起                            |

你的设备不需要安装任何东西，用浏览器打开入口地址即可。

## 快速开始

### 只想在本机试试

需要 Docker 和 Compose v2，服务端建议至少 2 核 4 GB 内存。

```bash
git clone https://github.com/NotDesigned/remote-claude-browser.git remote-claude-browser
cd remote-claude-browser
./scripts/bootstrap.sh
```

脚本会生成 `.env`（包含随机密码和密钥）、构建并启动服务，最后打印访问地址和初始密码。用浏览器打开 `http://127.0.0.1:3010`，以用户名 `admin` 和这个密码登录。

### 一台服务器，带 HTTPS

把域名解析到这台机器，然后：

```bash
./scripts/bootstrap.sh
docker compose down
```

编辑 `.env`，设置这两项：

```bash
PUBLIC_HOST=browser.example.com
MIRROR_PUBLIC_ORIGIN=https://browser.example.com
```

```bash
docker compose -f compose.yml -f compose.https.yml up -d
```

### 服务端和入口机分开

见 [docs/deployment.md](docs/deployment.md)。

### 同一入口增加 CPA 面板和 API

已有单机 HTTPS 部署并配置 `EGRESS_PROXY` 后：

```bash
node scripts/setup-cpa.mjs
docker compose up -d --build cpa caddy
```

工作台地址不变，CPA 面板在 `/management.html`，OpenAI 兼容 API Base URL 为 `/v1`。面板和 API 分别使用 `.env` 中的 `CPA_MANAGEMENT_KEY`、`CPA_API_KEY`，需要在面板中单独完成 Claude Code OAuth 授权。完整地址、Caddy 路由、备份和检查命令见 [docs/cpa.md](docs/cpa.md)。

## 第一次使用

1. 打开入口地址，输入**前端用户名和密码**。首次启动的管理员默认名为 `admin`，密码来自 `.env` 的 `MIRROR_ACCESS_PASSWORD`；这与浏览器内网站的账号无关。
2. 登录后先选择浏览器配置，也可以新建配置。配置卡片显示 Claude 登录邮箱或“未登录”；站点明确停用的账号显示“账号不可用”。刷新已有会话会直接恢复，新登录或另开会话会重新选择配置。
3. 选择后打开远程窗口。需要登录网站时，建议切到顶部的“画面”模式操作，完成后切回“页面”。
4. 管理员可在 ⋯ 菜单的用户管理中建立其他用户。新用户从空白浏览器配置开始，不会得到管理员的网站 Cookie。
5. 用户、网站登录状态和配置归属保存在服务端的 `data` 卷里，重启和升级后依然有效。会话总上限默认 `8`，可通过 `MIRROR_CLIENTS` 设置为任意正整数。

邮箱在配置打开 Claude 后读取并保留，下次选择时直接显示；选择页会自动刷新状态。升级前从未读取过邮箱的旧配置，首次仍可能显示“已登录”，打开一次后即可更新。

升级旧版本时，原有浏览器配置全部归初始管理员，原设备需要重新用用户名和密码登录。已有数据库不会因为修改 `.env` 而重新设置用户密码。浏览器时区由 `.env` 的 `TZ` 决定，未设置时为 UTC；见[时区说明](docs/timezone.md)。

## 安全须知

前端用户的浏览器配置和会话按身份隔离。同一用户选择同一个浏览器配置时，仍会共享其中的网站 Cookie、历史和网站账号权限。

- 公网访问必须走 HTTPS，并且 `SERVER_BIND` 保持 `127.0.0.1`。
- 浏览器以非 root 用户运行，沙箱保持开启。Chromium 的调试协议走进程内管道，不监听任何端口。
- 容器内的防火墙阻止网页访问私有网段、宿主机和云元数据地址。容器看不到宿主机的公网 IP，请把它填进 `EGRESS_BLOCK`。
- `data` 卷里有 Cookie 和登录令牌，要像对待密钥一样保护它和它的备份。
- 不同用户的 Chrome 仍在同一容器、同一系统用户下运行，共享服务器资源；这不是针对恶意租户设计的独立虚拟机边界。

详见 [docs/security.md](docs/security.md)。

## 文档

- [部署](docs/deployment.md)：服务端、入口机、升级与备份
- [CPA 面板与 API](docs/cpa.md)：可选服务、OAuth、接口地址、Caddy 路由和出站隔离
- [配置](docs/configuration.md)：环境变量
- [架构](docs/architecture.md) · [安全](docs/security.md) · [排错](docs/troubleshooting.md)
- [双机 systemd 部署与运维](docs/operations.md)：不用 Docker 的部署方式和日常使用细节

## 开发

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm test:profiles-ui # 配置选择、状态刷新、新建、恢复和手机布局；使用本地测试页面
pnpm smoke:compose   # 构建镜像并做端到端检查，需要 Docker，设置 CHROME_PATH 后还会真实登录一次
pnpm check:fingerprint [镜像] [账号数]   # 用临时容器开几个新浏览器配置，查看 who.1ms.dog 和 fingerprint.com 的判定
```

## 许可

[Apache-2.0](LICENSE)。第三方声明见 [NOTICE](NOTICE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
