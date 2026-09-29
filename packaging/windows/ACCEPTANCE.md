# Windows 实机验收清单

这份清单只包含**必须由人在 Windows 上确认**的项目。能在开发机上自动验证的部分已经覆盖
（见 `README.md` 的「自动化验证」一节），这里不重复。

## 先跑自动部分（一条命令）

```powershell
npm ci --prefix apps/desktop
npm run test:windows      # 交叉编译测试目标需要 Linux；Windows 上用下面的命令代替
npm run build:backend     # 构建后端（开发目录）
npm run dist:windows      # 生成安装包
node packaging/windows/acceptance.mjs
```

`acceptance.mjs` 会把机器能验的部分一次跑完：

  1. 打包产物是否齐全（应用、随包后端、安装包）与类型/体积是否合理；
  2. 真机只读自检（WLAN API 与 IP Helper 的真实行为）；
  3. 端到端用例（真子进程 + 真协议 + 真 SQLite）；
  4. **真的启动一次打包后的应用**，确认它能自己拉起随包后端并创建数据库——
     这一项不能省：真机上第一次安装时，后端只在“由应用拉起”的情况下启动失败
     （无法创建数据目录），而所有直接运行后端的检查都显示正常；
  5. 真实网卡上的一轮只读采样。

它输出「通过 / 跳过 / 失败」三类，退出码非零表示有失败项；除第 4 项会在隔离的
临时数据目录里启动应用外，其余检查都是只读的，不会改动系统网络状态与你的记录。

下面 6 组是**只能由人在 Windows 上确认**的部分，自动脚本会明确跳过它们。

## 已经验证过的（这台机器上实际跑过）

- [x] 安装向导：静默安装退出码 0，应用、随包后端与开始菜单快捷方式都正确创建；
- [x] 应用能自己拉起随包后端并创建 `%APPDATA%\WiFiMeter Demo\wifimeter.db`；
- [x] 界面显示真实数据：网络名 `CMCC-mKm3-5G`、已连接、信号 93%，
      下载 305 MB 后显示 0.34 GB（下载 0.33 GB，占 97.9%），网络列表计数为 1；
- [x] 中文界面与中文网络名不乱码；窗口标题为「WiFiMeter Demo — 流量总览」；
- [x] 卸载后重新安装正常（应用目录、快捷方式、开始菜单与卸载注册项都清理干净，数据目录保留）；
- [x] 开机启动：打开后应用把启动项写进 `HKCU\...\Run`，关闭后移除
      （启动项名是 App User Model ID `io.wifimeter.demo`，不是产品名）；
- [x] 托盘最小化：打开「关闭窗口时最小化到托盘」后，向窗口发送关闭（WM_CLOSE）
      进程仍驻留，说明是隐藏而不是退出；
- [x] 流量导出与完整备份在真机上都能正确返回数据；
- [x] 额度提醒真的弹出了系统通知：把额度调到极小值并打开提醒后，
      Windows 通知中心的记录里出现了应用标识 `io.wifimeter.demo`，
      记录时间与测试时刻一致（15 分钟内）。

下面仍是需要你确认的部分（交互与系统级行为）。

## 准备

安装包（含全部最新修复）：

```text
dist\windows\WiFiMeter-Demo-0.1.0-x64-Setup.exe
```

安装后的程序位于 `%LOCALAPPDATA%\Programs\WiFiMeter Demo`，数据位于
`%APPDATA%\WiFiMeter Demo`。未签名，SmartScreen 可能提示「未知发布者」，
选择「更多信息 → 仍要运行」。

自动化已经验证过的部分（不必重复确认，出问题再回看）：

- 后端能启动、握手、采集、写入 SQLite；
- 中文网卡名与 SSID 不乱码；中文路径（用户名含中文）可用；
- 无线网卡身份、信号、频段的读取，以及 WLAN 与 IP Helper 的网卡名一致性；
- 错误响应带正确的错误码与说明；
- 采样与断开的全部判断逻辑（含换网丢弃样本、断开后复核）。

## 1. 安装向导

- [ ] 双击安装包，向导出现，语言可切换（中文/英文）。
- [ ] 安装目录可改（默认 `%LOCALAPPDATA%\Programs\WiFiMeter Demo`）。
- [ ] 安装完成后桌面与开始菜单都有 **WiFiMeter Demo** 快捷方式。
- [ ] 勾选「运行」后程序能直接启动。

## 2. 界面与真实数据

- [ ] 总览页标题为「流量总览」，`#collector` 显示 **正在采集** 而不是「采集器未就绪」。
- [ ] 底部显示「本机采集 · 数据存于本机数据库」并有更新时间。
- [ ] 当前网络卡片显示真实 SSID（例如 `CMCC-mKm3-5G`）与网卡名
      （例如 `MediaTek Wi-Fi 6E MT7922 ...`），**中文不乱码**。
- [ ] 点击「采集状态」，弹窗里能看到「采集器：运行中」与真实网卡。
- [ ] 网络页出现当前网络条目（刚连上、还没有流量时可能暂时只有当前连接卡片，
      产生一点流量后应出现在列表里）。
- [ ] 让机器下载几十 MB（例如系统更新或测速），确认总览的下载数字增长，
      历史页出现当天的记录。

## 3. 网络归属

- [ ] 连接另一个 Wi-Fi，确认当前网络卡片随之变化。
- [ ] 切换瞬间的流量不计入旧网络（网络页里两个网络的用量都不会出现异常跳变）。
- [ ] 断开 Wi-Fi（关闭无线开关或断开连接），确认状态变成「尚未连接 Wi-Fi」，
      历史记录仍然可看。

## 4. 系统级功能

- [ ] 设置页打开「登录时自动启动」，注销后重新登录，确认程序自动启动；
      关闭后确认启动项被移除（任务管理器 → 启动 页里不再有它）。
- [ ] 打开「关闭窗口时最小化到托盘」，点窗口关闭按钮只隐藏窗口，托盘图标仍在，
      左键能恢复窗口、右键能退出。
- [ ] 设置一个很小的额度上限（例如 0.01 GB）并打开提醒，确认**通知的视觉呈现**是否
      符合预期（后端确实发出了通知，Windows 也记录了，见上面的验证记录）。
- [ ] 若打开「达到额度后自动断开」，确认它真的断开了那个网络，
      并且「采集状态」里的结果是成功而不是「未能断开」（需要网络支持断开）。
      ⚠️ 做这一项时注意：网络键由 SSID 派生，所以**改了额度就是改了真实网络的额度**，
      测完记得把额度改回去。

## 5. 数据与导出

- [ ] 修改网络备注与单位，退出再打开，设置保留。
- [ ] 确认数据库就在应用数据目录里：`%APPDATA%\WiFiMeter Demo\wifimeter.db`
      （不是 `%LOCALAPPDATA%\WiFiMeter\`，那是后端单独运行时的缺省位置）。
- [ ] 导出 CSV 与 JSON：文件能打开、中文不乱码、字节数与界面一致。
- [ ] 备份后清空记录再恢复，确认记录、备注与额度都回来了；取消保存时不应提示成功。

## 6. 与旧版共存

- [ ] 与旧版 WiFiMeter 同时安装并启动，确认安装目录、快捷方式互不覆盖。
- [ ] 从「应用和功能」卸载示例版，确认旧版仍可用，示例版的数据目录保留。

## 7. 可选：一条命令跑系统级检查

```powershell
# 需要主机上装有 Node；它会启动安装版应用做真实检查，结束后不会留下开机启动项
& 'C:\Program Files\nodejs\node.exe' packaging\windows\system-check.mjs
```

覆盖托盘驻留、导出与备份；开机启动这一项脚本不做断言（原因写在脚本注释里：
用 `WIFIMETER_USER_DATA` 指向临时目录时，主进程读到的设置始终是默认值，
因此它只能在应用自己的数据目录下验证，结果见上面的记录）。

## 8. 可选：在 Windows 上跑界面测试

界面测试本身是跨平台的，只是在没有图形会话的 Linux（WSL/CI）上需要虚拟显示，
Windows 桌面会话里直接跑即可：

```powershell
npm run test:ui                                                    # 开发态
$env:WIFIMETER_EXECUTABLE = (Resolve-Path '.\dist\windows\win-unpacked\WiFiMeter Demo.exe').Path
npm run test:ui                                                    # 打包产物
Remove-Item Env:WIFIMETER_EXECUTABLE
```

它用假的网卡数据（夹具 nmcli）驱动真实后端，不会改动机器的网络状态。

## 9. 可选：更严格的自检

把 `build\windows\tests\windows_smoke_test.exe` 与
`build\windows\app\wifimeter-backend.exe` 放到同一个目录，然后在 PowerShell 里：

```powershell
.\windows_smoke_test.exe          # 只读地核对 WLAN API 与 IP Helper 的真实行为

$env:WIFIMETER_BACKEND_BINARY = (Resolve-Path '.\wifimeter-backend.exe').Path
.\backend_process_test.exe        # 真子进程 + 真协议 + 真 SQLite 的端到端用例
Remove-Item Env:WIFIMETER_BACKEND_BINARY
```

两个程序都只读或只在临时目录里操作，不会改动系统网络状态（断开相关的用例只在
「身份不匹配」的分支断言，不会真的断开）。

## 记录结果

发现问题时请记录：哪一步、期望什么、实际看到什么，以及
`%APPDATA%\WiFiMeter Demo` 下是否有 `wifimeter.db`。应用窗口里的错误提示与
「采集状态」弹窗的内容也很有用。
