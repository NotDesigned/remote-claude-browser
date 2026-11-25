# 文档规范

> 读者：改代码或改文档的人（维护者、贡献者、写文档的 agent）

这份规则由 Remote Claude Browser（RCB）和 remote-cc 两个仓库共用，两边各放一份，路径都是 `docs/documentation.md`。只有「文件骨架」「归属表」「对外锚点」三节按仓库写，其余各节两边逐字相同。改动规则时，两边要在同一天一起改。

## 原则

### 1. 一事一处

每个主题只在一个**归属文件**里完整写一次，归属关系见下文「归属表」。其他文件提到这个主题时，最多写一句概括，再加一个链接。数值、默认值、命令参数、路由、文件清单都不在别处复述。

为什么：同一事实被写了三到五遍，已经互相矛盾。空闲关闭时间同时存在 60 秒、120 秒、15 分钟三种说法；「CPA 默认出口」一处说有，另一处说没有；停用和删除用户的规则写了五遍。

**检查**：

- 改了某个行为的 PR，正文只能改在该主题的归属文件里。
- 用 grep 搜易变事实（如 `15 分钟`、`EXIT_REQUIRED`、`rcck_`、`64`、`users.sqlite`），在说明文字中只能出现在归属文件和 `CHANGELOG.md` 里；其他地方出现时，必须在一个指向归属文件的链接句中。

### 2. 一个文件只给一类读者

- 每个 `.md` 文件第一行写 `> 读者：…`，只写一类读者。正文只写这类读者要做的事。
- `README.md` 是入口，其中的「文档」表按读者列出仓库里的每个文档，没有孤立文件。
- 一个主题少于约 80 行时，写成某个文件里的一节，不单独成文件。
- 使用者文档里不出现 compose 文件、`.env` 和 `docker` 命令；部署文档里不写逐步点击的界面操作，改为链接到使用或管理文档。

为什么：现在 cpa.md、remote-cc.md、operations.md 和 remote-cc 的两个 README 都把操作步骤、部署、API 和设计混在一起；RCB 没有面向使用者的指南；有两个文档没有任何入口链接。

**检查**：

- 每个文件第一行都是「读者」行。
- `git ls-files '*.md'` 减去 README「文档」表里的文件，结果只能剩例外清单里的文件。
- `wc -l`：`README.md` 不超过 150 行，其他文件不超过 400 行。

### 3. 只写当前版本能走通的路径；历史只进 CHANGELOG

- 说明文档只描述当前版本，直接改原文，不按版本往后追加段落。
- 文中每个命令、脚本名、文件路径、CLI 子命令和界面标签都必须真实存在。
- 已移除或走不通的路径从说明文档里删掉。如果对应的文件还在仓库里，就修代码或删掉文件，不在文档里解释它为什么走不通。
- 版本历史、迁移办法和破坏性变更只写在 `CHANGELOG.md`。每个版本固定分为「新增 / 变更 / 移除 / 升级步骤」四节，没有内容的写「无」。

为什么：

- remote-cc 的 DESIGN.md 是按版本追加写成的，至少有五处前后矛盾。
- RCB 的文档推荐了五条在当前代码下打不开任何浏览器配置的路径。
- 已移除的独立 CPA 在四个文件里还留着残句。
- 0.2.0 的 CHANGELOG 漏掉了所有破坏性变更。

**检查**：

- 在 `CHANGELOG.md` 和 `docs/records/` 以外 grep `v0\.[0-9]`、`旧版`、`兼容：`、`已移除`、`草案`、`之前的版本`。每处命中要么删掉，要么改成指向 CHANGELOG 的链接。
- 快速上手里的命令必须与 CI 或 smoke 脚本实际执行的命令一致。
- 文中写到的每个 compose 组合都必须在「可用的 compose 组合」表里，并且 `docker compose config` 能通过。

### 4. 说明、记录、实现细节分开放

- 带日期的评测、事故复盘和计划放在 `docs/records/YYYY-MM-DD-主题.md`。文件开头写清状态和对应的版本，写成后不再修改。
- 只有 `architecture.md` 和本文可以链接到 records，使用和部署文档不链接。
- 设计取舍写在 `architecture.md` 的「决策」一节，每条不超过 3 句。
- 实现细节不进 Markdown，包括函数名、代码行号、内部管理路由清单、协议帧编号、调参经过和测试日志。这些写在代码注释里。

为什么：带日期的验收表、事故复盘、里程碑、实测记录和个人运维日志混在现行文档里，会过期，也没有人维护。

**检查**：在 `docs/records/` 以外，grep `\.ts:[0-9]`、`\.go:[0-9]`、`已实测`、`里程碑`、`待完成`、`TODO`，必须零命中。

### 5. 参考数据以代码为准

环境变量、compose 组合、数据文件（也就是备份清单）、超时和上限、CLI 参数，这些都要对得上代码：

- RCB 的环境变量表（`docs/configuration.md`）要和 `compose*.yml`、`.env.example` 逐项对应。
- 文中每个数值旁边注明它来自哪个常量或文件，例如 `session/resource-policy.ts`。
- remote-cc 的命令和参数以 `remote-cc help` 为准（来自 `internal/cli/cli.go` 的命令表）。Markdown 里只写任务示例，不手抄参数表。

为什么：`configuration.md` 漏了二十多个变量，`remote-cc help` 也漏了 `--force`、`--alias`、`-q`。手抄的清单迟早会落后于代码。

**检查**：

- RCB 的 `pnpm docs:check` 比对变量名集合。
- remote-cc 的 Go 测试比对文档里出现的命令、`RCC_*` 环境变量和命令表。

### 6. 跨仓库各写各的一侧

两个项目只通过 HTTPS 接口集成，哪一侧实现，就由哪一侧来写：

- **RCB 写**：`/api/remote-cc/v1` 接口契约、令牌种类和权限、连接码和会话授权的有效期与上限、撤销语义、电脑和 RCB 账号的对应关系，以及工作台里的操作。
- **remote-cc 写**：CLI 流程、出口主机的部署、出网机制（netns、Mihomo、复查、节点上限）和 remote-cc 的用户名规则。

提到对方时只写一句话，再用绝对 URL 链接到对方 `main` 分支上的**固定英文锚点**（在标题上方写 `<a id="…"></a>`）。接口有变化时，两边的 CHANGELOG 都要写明兼容版本（「需要 RCB ≥ x」或「需要 remote-cc ≥ y」）。

为什么：同一套审批、授权、复查和限制的设计，现在在两个仓库里共写了三份，连同一处过期说法（会自动打开新标签页）也一起抄了过去。而 RCB 用户和 remote-cc 用户是什么关系，两边都没写。

**检查**：

- 在 remote-cc 仓库里 grep `/api/remote-cc/v1`、`rcck_`、`rcch_`，只能出现在指向 RCB 的链接句里。
- 在 RCB 仓库里 grep `rcc-egress`、`netns`、复查周期和节点上限，只能出现在指向 remote-cc 的链接句里。
- 「对外锚点」一节列出的锚点必须存在。锚点改名或删除视同接口变更，要写进 CHANGELOG。

### 7. 正文用中文，一个概念只用一个词

- 说明文字一律用中文。命令、参数、环境变量、路径、API 路径、令牌前缀和代码标识符保持英文，写在反引号里。
- 只有下文「例外」一节列出的文件可以用英文。
- 每个概念只用一个词，以「术语」表为准。界面上有标签的，照抄界面原文写在「」里，菜单路径写成「管理后台 → 用户」。
- 占位符固定写成 `<服务器>`、`<用户名>`、`<数据目录>`、`<安装目录>`。示例域名统一用 `browser.example.com`。不用 A、B 指代机器。

为什么：RCB 的中英文文档各占一半，却没有任何规则；同一个东西有四到六种叫法（浏览器配置/profile/account、管理后台/用户管理、画面/图像/picture 模式）。

**检查**：

- 脚本统计反引号以外的英文：出现连续 8 个以上英文单词的句子就算违规。
- 按术语表的「不要写」列 grep，命中即失败。
- RCB 文档里每个「」界面标签，都必须能在 `packages/viewer/src` 里 grep 到原文。

### 8. 文档和代码在同一个 PR 里改，由 CI 检查

- PR 模板里的「影响的文档」一栏必填。确实没有影响时写「无」，并说明理由。
- 每个仓库有一个文档检查（RCB：`pnpm docs:check`；remote-cc：`go test ./internal/docs`），接进 CI。检查范围：相对链接和锚点、孤立文件、「读者」行、禁用词，以及原则 5 的比对。
- 发布前逐项核对：版本号在 `package.json`、git tag 和 CHANGELOG 标题三处一致；快速上手照原文重跑一遍；对方仓库的链接仍然有效。

为什么：RCB v0.2.0 发布时 `package.json` 还是 0.1.0；remote-cc v0.6.0 没有 CHANGELOG，也没有写升级时需要先执行 `update-server`。

**检查**：CI 里的文档检查不通过，PR 就不能合并。发布 PR 要勾选完 CONTRIBUTING.md 里「发布」一节的每一项。

## 例外（可以用英文，或不进 README「文档」表）

- 法律文件和社区惯例文件：`LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`deploy/egress/mihomo.LICENSE`。
- 冻结存档：`UPSTREAM.md`。顶部有冻结说明，正文不再修改。
- 代码内的文字：CLI 的帮助文字（命令表）、代码注释、compose 和 Dockerfile 注释、安装脚本里的提示、`internal/embedded/shims/README`。
- `.github/` 下的模板。这些模板用中文写，但不列入「文档」表。

本文自身不参与原则 1、3、4、6、7 的 grep 检查和界面标签检查：各条「为什么」和术语表的「不要写」列必须原样引用这些词。

## 文件骨架

两个仓库用同一套文件名，同类内容在两边的位置相同。下表是 RCB 一侧；remote-cc 一侧见它的 [`docs/documentation.md`](https://github.com/NotDesigned/remote-cc/blob/main/docs/documentation.md)。

| 文件                      | 读者           | 内容                                 |
| ------------------------- | -------------- | ------------------------------------ |
| `README.md`               | 第一次来的人   | 是什么、拓扑、最短上手、「文档」表   |
| `docs/usage.md`           | 使用者         | 工作台使用                           |
| `docs/admin.md`           | 工作台管理员   | 「管理后台」、共享资源、批准出口主机 |
| `docs/deployment.md`      | 部署者         | 部署、公网入口、备份、资源与超时     |
| `docs/configuration.md`   | 部署者（查表） | 环境变量表                           |
| `docs/troubleshooting.md` | 部署者         | 按症状排查                           |
| `docs/security.md`        | 安全审查       | 威胁模型                             |
| `docs/remote-cc.md`       | 接入方         | 接口契约                             |
| `docs/architecture.md`    | 开发者         | 当前设计和决策                       |
| `docs/records/`           | 维护者         | 带日期的评测、复盘和计划             |
| `docs/documentation.md`   | 写文档的人     | 本文                                 |
| `CHANGELOG.md`            | 升级的人       | 版本和升级步骤                       |
| `CONTRIBUTING.md`         | 开发者         | 开发、测试、发布                     |

## 归属表

| 主题                                                                                              | 归属                                                     |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 可用的 compose 组合                                                                               | `docs/deployment.md`「可用的 compose 组合」              |
| 公网入口需要转发的路径                                                                            | `docs/deployment.md`「公网入口」                         |
| 备份清单（各 sqlite 文件、`proxy-sources.json`、runtime 密钥、浏览器配置数据、每个用户的 CPA 卷） | `docs/deployment.md`「备份」                             |
| 超时与上限（登录有效期、会话宽限、空闲关闭、休眠、每人配置数、内存准入、PID）                     | `docs/deployment.md`「资源与超时」                       |
| 环境变量和构建参数                                                                                | `docs/configuration.md`                                  |
| 浏览器配置、页面模式和画面模式、「设置出口」「检查出口」、当地时间、系统身份                      | `docs/usage.md`                                          |
| CPA 的使用、调用 Key、原生管理面板                                                                | `docs/usage.md`「CPA」                                   |
| 启用 CPA、cpa-broker、CPA 卷                                                                      | `docs/deployment.md`「CPA」                              |
| 收件箱：使用 / 域名和地址 / Resend 配置                                                           | `docs/usage.md` / `docs/admin.md` / `docs/deployment.md` |
| 停用和删除用户的效果、会话上限、资源归属                                                          | `docs/admin.md`                                          |
| 批准电脑、登录横幅「打开授权页」                                                                  | `docs/usage.md`「remote-cc」                             |
| 批准出口主机                                                                                      | `docs/admin.md`「出口主机」                              |
| remote-cc 接口契约、电脑和 RCB 账号的对应关系                                                     | `docs/remote-cc.md`                                      |
| 威胁模型、信任边界                                                                                | `docs/security.md`                                       |
| 漏洞报告                                                                                          | `SECURITY.md`                                            |
| 组件、数据流、不变量、决策                                                                        | `docs/architecture.md`                                   |
| 版本历史和升级步骤                                                                                | `CHANGELOG.md`                                           |
| 开发、测试、发布                                                                                  | `CONTRIBUTING.md`                                        |
| 第三方许可                                                                                        | `THIRD_PARTY_NOTICES.md`                                 |
| 文档规则、术语                                                                                    | `docs/documentation.md`                                  |
| remote-cc 的 CLI 流程、出口主机的部署、出网机制、remote-cc 用户名规则                             | 只放链接，指向下文「对外锚点」里的 remote-cc 锚点        |

## 对外锚点

本仓库的这些锚点会被 remote-cc 链接，不能随意改名：

| 文件                | 锚点            | 所在的节                              |
| ------------------- | --------------- | ------------------------------------- |
| `docs/remote-cc.md` | `identity`      | 电脑和 RCB 账号的对应关系             |
| `docs/remote-cc.md` | `approval`      | 批准流程：连接码的有效期和上限        |
| `docs/remote-cc.md` | `tokens`        | 客户端令牌和主机令牌的权限            |
| `docs/remote-cc.md` | `grants`        | 会话授权的签发、兑换和复查            |
| `docs/remote-cc.md` | `login`         | 登录横幅                              |
| `docs/remote-cc.md` | `revocation`    | 撤销和对运行中会话的影响              |
| `docs/remote-cc.md` | `api`           | `/api/remote-cc/v1` 和工作台接口      |
| `docs/remote-cc.md` | `storage`       | 存储                                  |
| `docs/remote-cc.md` | `compatibility` | 兼容版本                              |
| `docs/usage.md`     | `remote-cc`     | 「remote-cc」页签：批准电脑、登录横幅 |
| `docs/admin.md`     | `egress-hosts`  | 批准出口主机                          |

remote-cc 一侧提供下面这些锚点，本仓库链接 remote-cc 的主题时用这些 `main` 分支上的绝对 URL：

- 连接 RCB（客户端一侧）：<https://github.com/NotDesigned/remote-cc/blob/main/docs/usage.md#rcb>
- 启动时的检查：<https://github.com/NotDesigned/remote-cc/blob/main/docs/usage.md#rcb-checks>
- 出口主机的部署和节点上限：<https://github.com/NotDesigned/remote-cc/blob/main/deploy/README.md#egress-host>
- 用户名规则：<https://github.com/NotDesigned/remote-cc/blob/main/deploy/README.md#user-names>
- 出网机制和复查：<https://github.com/NotDesigned/remote-cc/blob/main/docs/architecture.md#egress>

## 术语

| 概念                 | 用词                                                                                                                                              | 英文 / 代码                         | 不要写                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| 本项目               | Remote Claude Browser（RCB）                                                                                                                      | `remote-claude-browser`             | Remote Browser（上游名，只出现在 UPSTREAM/NOTICE/THIRD_PARTY）、remote-browser |
| remote-cc 程序       | remote-cc                                                                                                                                         | `remote-cc`                         | 把程序名写成 rcc（`rcc-*` 二进制名和目录名照写）                               |
| 浏览器配置           | 浏览器配置（上下文清楚时可简称「配置」）                                                                                                          | browser profile；代码里叫 `account` | 正文里的 profile、浏览器账号、browser account                                  |
| 工作台               | 工作台                                                                                                                                            | workbench                           | workspace（代码名除外）、前端                                                  |
| 工作台用户           | 用户                                                                                                                                              | user                                | 前端用户、service users                                                        |
| 管理界面             | 「管理后台」，下设「用户」「会话」「资源」                                                                                                        | admin                               | 用户管理、admin panel                                                          |
| 网络面板             | 「网络与接入」面板，页签「代理来源」「CPA 授权与 Key」「remote-cc」；菜单项「网络与接入」                                                      | network panel                       | 「工作台 → 代理」「工作台 → API」「代理与 API」|
| 节点来源             | 代理来源                                                                                                                                          | proxy source                        | 代理池                                                                         |
| 节点                 | 节点                                                                                                                                              | node                                | 代理节点、出口节点                                                             |
| 出口                 | 出口：配置实际出网的 IP。「设置出口」= 给配置绑定一个节点                                                                                         | exit                                | 部署默认出口、deployment default exit                                          |
| 两种查看方式         | 页面模式、画面模式                                                                                                                                | page mode、pixel mode               | 图像模式、picture mode                                                         |
| 会话                 | 会话                                                                                                                                              | session                             | 远程窗口                                                                       |
| CPA 实例             | CPA 实例（私有 / 共享）                                                                                                                           | CPA instance                        | 专用实例、共享账号池                                                           |
| 调用 Key             | 调用 Key（`rcpa_`）                                                                                                                               | calling key                         | 外部 API Key、个人 Key、inference key                                          |
| 部署的机器           | 入口机、服务端                                                                                                                                    | entry host、server                  | A/B、浏览器宿主机                                                              |
| 网关                 | 网关                                                                                                                                              | gateway                             | Agent                                                                          |
| 系统身份             | 系统身份；操作是「设置系统」                                                                                                                      | persona                             | 指纹身份                                                                       |
| 浏览器内核           | 内核（AliasMode）                                                                                                                                 | engine                              | 指纹浏览器                                                                     |
| 部署者               | 部署者：有服务器和数据卷权限的人                                                                                                                  | deployer                            | 运维者、operator                                                               |
| remote-cc 的两端     | 电脑（运行 remote-cc 的那台）、服务器（运行网关和容器）                                                                                           | local machine、server               | A、B、本机（用于泛指时）                                                       |
| remote-cc 的两种主机 | 容器（命令里写作 `HOST`：`server setup` 或 `device join` 写好的 ssh 别名）、宿主机（命令里写作 `SERVER`：以 root 或 sudo 账号连接的 Docker 主机） | HOST、SERVER                        | 混用 host、主机、服务器指代这两者                                              |
| remote-cc 服务器用户 | 服务器用户，对应容器 `rcc-<用户名>`                                                                                                               | user                                | 账号                                                                           |
| Claude 登录身份      | Claude 账号（`--account`）                                                                                                                        | account                             | 用户                                                                           |
| 对话历史             | 历史档案（`--profile`）                                                                                                                           | history profile                     | profile、配置                                                                  |
| 出口主机             | 出口主机（`rcc-egress` 容器）                                                                                                                     | egress host                         | 出口（指主机时）                                                               |
| 三种码               | 邀请码（remote-cc）、连接码（RCB 批准）、授权码（Claude 登录）                                                                                    | invite / user code / auth code      | 混用                                                                           |
| RCB 令牌             | 客户端令牌（`rcck_`，界面「已连接的电脑」）、主机令牌（`rcch_`，界面「出口主机」）                                                                | client token、host token            | —                                                                              |
| 会话授权             | 会话授权                                                                                                                                          | grant                               | 会话许可、授权（单独使用时）                                                   |
