# 开发说明

[English](DEVELOPMENT.md) | 简体中文

## 构建和测试

使用 Windows 10/11、Windows PowerShell 5.1 和 .NET Framework 4.7.2 或更新版本。构建调用系统自带的 C# 编译器，不下载依赖。运行目标是 Windows PowerShell 5.1。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\Build.ps1
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\tests\Run-All.ps1
```

产物为 `dist/WiFiMeter-Setup.exe`、`dist/WiFiMeter-Portable.zip` 和解包后的 `dist/WiFiMeter/` 目录。开发时可传入 `-HostOnly`，跳过安装器与 ZIP 生成。

测试先检查 PowerShell 语法和编码，再验证统计、配置、额度、应用明细、进程、WPF、原生宿主与安装。注册表测试使用独立测试项，需要当前用户注册表写入权限。安装测试使用临时目录，启动自己的托盘实例，不更改已有数据和启动项。额度测试不会断开真实网络。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\AppUsage.Tests.ps1 -Live
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\Measure-Performance.ps1
```

可选的实机查询读取 Windows 应用统计。性能脚本测量后台 CPU、内存和网卡采样耗时，不会主动下载文件。结果随电脑和已有记录数量变化。

## 模块

| 组件 | 职责 |
| --- | --- |
| `Host.cs` | GUI 可执行文件、STA PowerShell 运行空间、单窗口激活和退出信号 |
| `App.ps1`、`MainWindow.xaml`、`Dialogs.ps1` | 概览、弹窗、托盘生命周期与应用流量后台查询 |
| `Strings.psm1` | 中英文界面文案 |
| `Sampler.psm1` | WinRT SSID 识别与 .NET 网卡计数器 |
| `Core.psm1` | 增量、每日记录、范围查询、JSON 恢复与 CSV 导出 |
| `Storage.psm1` | 原子文件替换，以及短暂文件占用时的有限重试 |
| `Preferences.psm1` | 配置验证、原子合并与保留期限 |
| `QuotaRuntime.psm1`、`NetworkControl.cs` | 当前额度、通知去重与 WLAN 断开前校验 |
| `AppUsage.psm1` | Windows 应用统计、配置映射与查询缓存 |
| `Control.psm1`、`Collector.ps1` | 统计进程、采样循环与登录自启动 |
| `installer/Setup.cs` | 当前用户安装、更新与卸载 |

## 统计和存储

每 5 秒采样，有变化时约每 10 秒保存，正常停止时保存剩余数据。每个采样间隔归入结束时的本地日期，日期范围包含两个端点。SSID 按字符精确匹配并区分大小写，备注不改变身份。

采样器通过 GUID 对应 WinRT 配置与网卡，在计数器读取前后核对连接。首次采样、SSID 变化、网卡消失、计数器下降、时钟回退或间隔超过 15 秒时重建基准，舍弃无法确认归属的增量。具体限制见[使用指南](USAGE.zh-CN.md#统计范围与排错)。

默认目录为 `%LOCALAPPDATA%\WiFiMeter\data`。`state.json` 使用 Schema 1，包含每日记录和可选的 `QuotaLedger`；没有该字段的旧记录仍可读取。当前额度和日记录在同一次保存中写入，历史清理不影响额度累计。新规则从保留的历史初始化，再随采样累加。每条有效规则保留提醒和到达上限的通知记录，周期或规则变化后删除失效通知。

JSON 使用临时文件和原子替换，上一份有效记录保存为 `state.json.bak`。保留期限清理会重算总量，并轮换两个副本，防止恢复时带回已删除的日期。CSV 属于派生导出，文件被占用不会阻止 JSON 保存。配置更新通过目录级互斥锁和原子替换合并，语言修改不会覆盖同时保存的网络规则。

应用流量来自 `ConnectionProfile.GetAttributedNetworkUsageAsync`，在界面工作线程中查询，同时最多执行 4 个原生请求，总查询时限为 15 秒。未完成的操作会取消并释放。查询最多覆盖 60 天，同时受统计开始时间和保留期限约束。模块区分无记录、部分结果、不可用和超时，不按比例拆分网卡总量来生成应用数据。

应用缓存最多保留最近 4 次范围查询，5 分钟过期，上限 8 MiB。单次查询达到 12,000 条每日记录时停止，并提示缩短范围。后台维护会清理过期缓存，它不承担历史归档。配置映射使用连接时观察到的网卡 GUID、配置文件名和 SSID，不能仅凭配置文件名推断 SSID。

## 进程和自启动

EXE 默认打开概览，`--tray` 启动隐藏窗口和托盘，`--background` 运行采集，`--stop` 请求窗口与采集进程退出。测试可用 `--data-directory` 隔离数据。`--preview` 使用演示数据，`--snapshot` 生成截图，期间不启动统计或写入配置。

按完整数据目录生成命名互斥锁，同一目录只运行一个正常窗口；再次启动通过事件激活它。独立的退出事件用于保存后关闭托盘进程。采集进程通过独占文件锁防止重复计数，身份校验使用 PID 和进程启动时间。停止操作等待最终保存和进程退出。

关闭概览会询问最小化、退出或取消。最小化保留托盘和统计，退出先停止统计。窗口关闭时释放通知图标和查询工作线程。

登录自启动在当前用户 `Software\Microsoft\Windows\CurrentVersion\Run` 下注册 `WiFiMeter`，命令为 `WiFiMeter.exe --tray`。任务管理器可管理该启动项。程序遵守 Windows 禁用状态，不修改 `StartupApproved`。

安装器无需提权，记录所属文件和快捷方式，更新或移除前先停止托盘实例，并保留数据目录和无关文件。

## 安全和性能

启动参数以参数形式传入 PowerShell，不拼接成脚本。程序不读取 Wi-Fi 密码，不发送遥测，也不监听网络端口。SSID 始终作为数据处理，CSV 对字段加引号并转义电子表格公式前缀。配置和缓存会验证，日志与查询缓存有大小上限。文件继承目录权限，不加密。

自动断开默认关闭。原生 WLAN 辅助代码重新读取当前 SSID，完全匹配后才对指定网卡调用 `WlanDisconnect`，并限制重复尝试频率。额度按采样检查，无法精确拦截每一个字节。

采集器常驻单个进程，记录没有变化时不重复写入。配置文件变化后才重新加载，配置发现每分钟执行一次。界面缓存数据，输入没有变化时不重画图表，隐藏后减少刷新工作。应用表格使用行虚拟化。

## 文件规范

遵守 `.editorconfig` 和 `.gitattributes`。PowerShell 文件使用 UTF-8 BOM 与 CRLF，Markdown 和 SVG 使用 UTF-8 与 LF。界面和文档的中英文保持同步，截图使用演示数据。构建产物、日志、测试临时文件和运行数据不提交 Git。

参考：[Windows 启动应用](https://learn.microsoft.com/en-us/windows/win32/w8cookbook/startup-apps)、[Run 注册表项](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys)、[桌面应用流量查询](https://devblogs.microsoft.com/oldnewthing/20210521-00/?p=105234)、[WlanDisconnect](https://learn.microsoft.com/en-us/windows/win32/api/wlanapi/nf-wlanapi-wlandisconnect)。
