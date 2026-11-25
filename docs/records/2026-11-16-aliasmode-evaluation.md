# AliasMode 内核评测

> 读者：维护者

> 状态：存档。2026-11-16 至 2026-11-17 的评测，对应 0.2.0 发布前的 `main` 分支，写成后不再修改。当前的安装方法见 [docs/deployment.md](../deployment.md#aliasmode-内核)，使用见 [docs/usage.md](../usage.md#系统身份)。

评测时固定的版本是 [155.0.8059.85 build 5](https://github.com/aliasmode/aliasmode-chromium/releases/tag/v155.0.8059.85-aliasmode.5)，上游标记为预发布。这是 Linux 内核运行的 Windows 身份模拟。

运行镜像生成 `en_US.UTF-8` 系统 locale：内核会把 `LC_ALL` 固定到该语言环境，缺少它时中文下载名会退成 `download`。只设置 `LANG=C.UTF-8` 不足以修复。

## 验收和选择依据

2026-11-16 使用临时配置、离线页面及生产镜像中的 Xvfb 测试：

| 检查                                                               | 结果                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Windows 身份的页面、iframe、Worker、HTTP UA 与 Client Hints        | 一致呈现 Windows / Chrome 155                                                       |
| Windows 身份的扩展加载与缩放                                       | 盘符路径加载正常；目标标签 2 倍，同源另一标签保持 1 倍                              |
| Linux 身份的页面、iframe、Worker、HTTP UA 与 Client Hints          | 一致呈现 Linux / Chrome 155                                                         |
| Mac 身份的页面、iframe、Worker、输入与独立缩放                     | MacIntel / macOS 一致，大小写与中文输入、每标签缩放通过                             |
| 原生 Chromium 156 → AliasMode 155，再切换三种系统身份              | 临时配置的 HttpOnly Cookie、实际 HTTP 回传、localStorage 和 IndexedDB 保留          |
| `Browser.getVersion` 的 UA                                         | 与页面一致，网关补取资源可以继续复用                                                |
| 同种子重复启动                                                     | 主要身份字段一致                                                                    |
| Linux 身份的不同种子                                               | GPU 从 RTX 4070 Ti SUPER 变为 RTX 4060                                              |
| Windows 身份的 DOMSnapshot、混合大小写及中文输入、截图、screencast | 通过                                                                                |
| 不启用 `Runtime.enable` 的 isolated-world binding                  | 通过                                                                                |
| WebGL                                                              | 有窗口 Xvfb 模式正常                                                                |
| 隔离运行端的 Windows 身份，有窗口及无窗口启动                      | 通过                                                                                |
| 原生与新内核同时运行、私有文件系统与 X11                           | 通过；各配置的 `/C:` 扩展挂载只读且互不串用                                         |
| 独立出口、页面和 Worker 时区、夏令时、重开后存储及资源回收         | 通过                                                                                |
| 本地文件 URL 阻断策略                                              | 两种内核均阻止 `file:///etc/passwd`                                                 |
| Linux 身份的缩放扩展                                               | 目标标签 2 倍，同源另一标签保持 1 倍                                                |
| Windows 身份的真实 WebRTC 媒体与画面回退                           | SDP/ICE、解码帧推进、指针操作时暂停恢复、DOM 并发、重连与切标签清理、画面回退均通过 |

Windows 修复验收记录位于 `artifacts/fingerprint-evaluation/` 下的
`windows-fixed-full.json`、`windows-isolation.json` 和 `windows-rtc-media.log`。

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

Windows 身份会按 Windows 规则解析文件 URL。扩展位于普通 Linux 路径时，转换出的 URL
被当作 UNC 地址，随后被 Linux 文件加载器拒绝。因此扩展虽显示 ENABLED，后台脚本却未
运行，扩展页面返回 `ERR_INVALID_URL`。

隔离运行端将该配置的 `zoom-extension` 目录只读挂载到私有的 `/C:/zoom-extension`，浏览器
从这个盘符路径加载扩展，网关仍在原配置目录写入文件。只改变加载路径即可恢复扩展运行；
隔离环境中的独立缩放和媒体验收也已通过。挂载只包含缩放扩展，不映射整个配置目录。
已有 Linux 身份不会自动改变。

选择直接内核的原因是能保留当前托管与隔离方式。AdsPower、GoLogin、Octo 的自动化需要厂商
账号及 API 权限；CloakBrowser 托管浏览器需要单独许可；Fury 当前没有 Linux 浏览器构建；
adryfish/fingerprint-chromium 当前公开版本为 150。AliasMode 以独立 GPL-3.0 程序运行，
浏览器从官方直接下载，不随项目默认镜像分发。
