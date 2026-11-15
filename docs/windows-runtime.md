# Windows 浏览器运行端迁移

目前完成的是虚拟机创建脚本和独立 Chrome 验证程序。生产浏览器仍运行在 Linux；Windows 运行端尚未接入工作台。

目标部署为：入口和工作台继续运行在现有 Linux 服务上，Windows 虚拟机负责 Chrome。用户、配置 ID、名称、默认配置、CPA 和代理目录继续由工作台管理。首轮只接入一个新的测试配置，使用单独的 Windows 浏览器数据目录。

## 创建测试虚拟机

需要启用 Hyper-V 的 Windows 主机、管理员 PowerShell、Windows 安装 ISO，以及已存在的虚拟交换机。脚本默认分配 4 GiB 固定内存、4 个虚拟 CPU 和最大 64 GiB 的动态 VHDX，使用第二代虚拟机、Secure Boot 和 vTPM。

在 Windows 管理员 PowerShell 中进入仓库目录，先列出交换机：

```powershell
Get-VMSwitch | Select-Object Name, SwitchType
```

将下面的 ISO 路径和交换机名换成实际值，先预览，再创建：

```powershell
.\deploy\windows\New-BrowserVM.ps1 -IsoPath 'D:\ISO\Windows11.iso' -SwitchName '你的交换机名' -WhatIf
.\deploy\windows\New-BrowserVM.ps1 -IsoPath 'D:\ISO\Windows11.iso' -SwitchName '你的交换机名'
```

可通过 `-VMRoot` 选择虚拟磁盘存放位置。脚本遇到同名虚拟机或已有目标磁盘会停止，不覆盖已有内容；创建完成后虚拟机保持关闭。随后启动并连接控制台，安装 Windows：

```powershell
Start-VM -Name 'RemoteBrowser-Windows'
vmconnect.exe localhost 'RemoteBrowser-Windows'
```

## 验证 Windows Chrome

在测试虚拟机中安装 Google Chrome 和 Node.js 22.23.1 或更新的 22.x，将仓库中的 `scripts/windows-chrome-probe.mjs` 复制到虚拟机，然后执行：

```powershell
node .\scripts\windows-chrome-probe.mjs
```

程序使用专用临时配置和本地测试页，检查原生 Windows 标识、CDP 输入、DOM 快照和截图，并报告时区、屏幕及 WebGL 信息。它会关闭自己启动的 Chrome 并清理临时配置，不读取现有账号。这个程序用于验证基础浏览器能力，不连接工作台或 Claude。

## 接入工作台需要完成的改动

| 部分 | 接入内容 |
| --- | --- |
| 浏览器生命周期 | Windows 运行端按配置 ID 启停 Chrome，通过私有控制连接提供现有 `BrowserHandle` 接口 |
| 出口与时区 | 按配置绑定代理，验证 DNS、UDP、WebRTC 和时区；测试配置先使用单一出口 |
| 文件与扩展 | 上传先传到 Windows，再交给 Chrome；下载从 Windows 取回；缩放扩展在 Windows 本地安装 |
| 页面与画面模式 | 复用现有 DOM/CDP 控制和 `Page.startScreencast` 路径；Linux X11 抓屏路径不用于 Windows |
| 配置和资源 | Windows 运行端提供登录状态及进程资源信息；字体和渲染使用 Windows 环境 |

现有 `BROWSER_CDP_URL` 只支持默认配置，且不能与生产的独立出口绑定组合使用，因此不能直接作为多配置 Windows 运行端。需在 `clients-main.ts` 的配置启动流程中增加 Windows 实现，同时保留 Linux 实现。

多配置接入前，需确定并验证 Windows 下的目录、桌面和出口隔离方式；创建一台测试虚拟机不等于已完成多配置隔离。现有 Linux 浏览器数据保持原样，网站登录迁移在测试配置验证后另行处理。
