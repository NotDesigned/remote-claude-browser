# 可选指纹浏览器

项目支持直接运行本地 AliasMode Chromium 内核，继续使用现有的浏览器配置、Mihomo 出口、
网络与文件系统隔离、私有 Xvfb 和 CDP 管道。无需安装 AliasMode 桌面管理器或注册厂商账号。

每个新配置保存独立的指纹种子和 Linux 身份。重命名、休眠重启、修改出口、轮换工作台
密钥都不会重新生成种子；时区仍由所选出口决定。历史配置继续使用原生 Chromium，已有
Cookie 不迁移到较旧内核。手机连接只调整视口和触摸，不切换该配置的系统身份。

当前固定版本为 [155.0.8059.85 build 5](https://github.com/aliasmode/aliasmode-chromium/releases/tag/v155.0.8059.85-aliasmode.5)，
上游标记为预发布。当前启用 Linux 身份。Windows 身份在扩展兼容性测试中失败，因此没有启用；真正的 Windows 运行端见
[Windows VM 准备](windows-runtime.md)。

## 安装

仅支持 Linux x64。主机需要 `curl`、`tar`、`zstd`。

```sh
bash scripts/setup-fingerprint.sh "$PWD/local/aliasmode-155.0.8059.85"
```

脚本从官方发布下载完整目录并核对固定 SHA-256，不安装系统包，也不覆盖已有版本。
已有下载时，可把压缩包路径作为第二个参数传入。目录保留上游许可证和源码位置。

将脚本输出的 `FINGERPRINT_BROWSER_DIR=...` 写入 `.env`，在原来的 `COMPOSE_FILE` 列表末尾
追加 `compose.fingerprint.yml`，保留原有 runtime、代理和入口覆盖文件，然后更新 server：

```sh
docker compose up -d --no-deps server
```

该覆盖文件让**之后新建的配置**使用 AliasMode；已有配置不变。内核以只读目录挂载在
`/usr/local/lib/aliasmode`，进入每个浏览器自己的文件系统。不要只复制 `chrome` 主程序，
同目录的字体、语言、图形库和资源也是内核的一部分。

如要让之后的新配置恢复原生 Chromium，在 `.env` 设置 `MIRROR_BROWSER_ENGINE=chromium`。
已有 AliasMode 配置仍使用自己的内核，因此应保留目录挂载。不要直接把这些配置改用另一个
内核或删除其身份字段；要切换时创建新配置。

## 验收与选择依据

2026-11-16 使用临时配置、离线页面及生产镜像中的 Xvfb 测试：

| 检查 | 结果 |
| --- | --- |
| Windows 身份的页面、iframe、Worker、HTTP UA 与 Client Hints | 一致；但扩展测试失败，未启用 |
| Linux 身份的页面、iframe、Worker、HTTP UA 与 Client Hints | 一致呈现 Linux / Chrome 155 |
| `Browser.getVersion` 的 UA | 与页面一致，网关补取资源可以继续复用 |
| 同种子重复启动 | 主要身份字段一致 |
| Linux 身份的不同种子 | GPU 从 RTX 4070 Ti SUPER 变为 RTX 4060 |
| DOMSnapshot、混合大小写及中文输入、截图、screencast | 通过 |
| 不启用 `Runtime.enable` 的 isolated-world binding | 通过 |
| WebGL | 有窗口 Xvfb 模式正常 |
| 原生与新内核同时运行、私有文件系统与 X11 | 通过 |
| 独立出口、页面和 Worker 时区、重开后存储保留 | 通过 |
| 本地文件 URL 阻断策略 | 两种内核均通过 |
| Linux 身份的缩放扩展 | 目标标签 2 倍，同源另一标签保持 1 倍 |
| 真实 WebRTC 媒体与画面回退 | 视频帧推进、暂停恢复、回退画面通过 |

原生 Chromium 156 的同套探针总耗时为 2.74 秒，AliasMode 三次为 3.42、3.11、3.13 秒。
这些数值来自 Windows 身份的内核探针，包含容器启动和完整测试，不是单独的启动时间。
两标签探针的容器内存峰值为原生 327 MiB、新内核 380 MiB；没有观察到节省资源的优势。
默认不添加 Canvas 噪声，两份测试配置的 Canvas 哈希相同。

真实隔离环境的验收复用现有脚本，A 为原生 Chromium，B 为 AliasMode：

```sh
PROFILE_EGRESS_SMOKE=1 \
FINGERPRINT_BROWSER_DIR="$PWD/local/aliasmode-155.0.8059.85" \
node scripts/profile-egress-smoke.mjs
```

该脚本使用独立临时容器和虚拟出口，检查两个时区、DNS/UDP/HTTP 隔离、配置重开和私有 X11。
不使用生产账号、Cookie 或代理凭据。以上是工程兼容性测试，未验证 Claude 账号风控结果。

Windows 身份下，扩展虽显示 ENABLED，背景脚本却未注册事件，扩展页面返回
`ERR_INVALID_URL`；相同内核、相同脚本换为 Linux 身份后扩展可访问且独立缩放生效。
因此采用 Linux 身份，不对现有扩展系统增加兼容绕路。

选择直接内核的原因是能保留当前托管与隔离方式。AdsPower、GoLogin、Octo 的自动化需要厂商
账号及 API 权限；CloakBrowser 托管浏览器需要单独许可；Fury 当前没有 Linux 浏览器构建；
adryfish/fingerprint-chromium 当前公开版本为 150。AliasMode 以独立 GPL-3.0 程序运行，
浏览器从官方直接下载，不随项目默认镜像分发。
