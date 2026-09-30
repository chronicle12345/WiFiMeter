# Windows 安装包：本机构建与在 Linux 上交叉编译

生成带向导的 NSIS `.exe` 安装包。两条路径产出同一个产品 **WiFiMeter**（64 位、未签名），
安装包里包含 Electron 应用与真正的采集后端 `wifimeter-backend.exe`。不使用 Docker。

## 打包

### 在 Windows 10/11 x64 上

1. 安装 Node.js 22.12 或更新的受支持版本（x64，包含 npm）。
2. 安装 CMake 与支持 C++20 的编译器（Visual Studio 2022 的“使用 C++ 的桌面开发”组件即可）。
   后端在 Windows 上使用仓库内置的 SQLite，不需要额外安装 SQLite 开发包。
3. 在项目根目录打开 PowerShell：

```powershell
npm ci --prefix apps/desktop
npm run dist:windows
```

如果 PowerShell 提示不能运行 `npm.ps1`，把上面的 `npm` 换成 `npm.cmd`。

### 在 Linux 上交叉编译

不需要提前安装任何交叉工具链：脚本会把 Zig 与便携版 Wine 下载到 `.cross-build/`（已忽略提交），
并校验 SHA-256。

```bash
npm ci --prefix apps/desktop
npm run dist:windows
```

首次运行需要下载约 130 MB（Zig 50 MB、Wine 95 MB）以及 Electron 的 Windows 运行组件。
Zig 用自带的 clang 完成 `x86_64-windows-gnu` 的编译与链接，因此不需要 mingw-w64，也不需要 MSVC。

输出：

```text
dist/windows/WiFiMeter-1.0.0-x64-Setup.exe
dist/windows/win-unpacked/WiFiMeter.exe
dist/windows/win-unpacked/resources/wifimeter-backend.exe
```

安装包文件名跟随桌面应用 `package.json` 中的版本号变化。构建期间的中间包名为
`wifimeter-1.0.0-x64.nsis.7z`，成功生成安装包后会清理。也可在 `apps/desktop/` 下执行 `npm run dist:windows`。

## 安装行为

- 名称：**WiFiMeter**；应用标识：`io.wifimeter.demo`。
- 安装向导默认选择当前用户，默认目录为 `%LOCALAPPDATA%\Programs\WiFiMeter`；可以选择安装目录。
- 创建独立的桌面、开始菜单快捷方式与卸载入口。
- 应用设置与采集记录保存在 `%APPDATA%\WiFiMeter Demo`，数据库是其中的 `wifimeter.db`；
  沿用原有数据目录，升级后继续读取已有记录，卸载默认保留数据。主进程始终把该路径显式传给后端（`--db`），
  因此两个进程用的是同一个文件；后端自己运行时才使用
  `%LOCALAPPDATA%\WiFiMeter\wifimeter.db` 这个缺省值。
- 采集真实网络：网卡状态与身份来自 WLAN API，累计流量来自 IP Helper；数据留在本机。
- 开机启动写入系统登录启动项，托盘与额度提醒按设置生效。
- 当前构建不签名、不自动发布。Windows 可能显示“未知发布者”或 SmartScreen 提示。

## 自动化验证

两条命令覆盖能在开发机上验证的部分：

```bash
npm run test:windows   # 交叉编译全部测试目标并用 Wine 运行（14 个目标）
npm run test           # 桌面应用单元测试，含打包产物检查（有 dist/windows 时生效）
```

`test:windows` 覆盖编码（UTF-16/代理对/非法字节）、时区、64 位计数、SQLite、协议往返，
以及采样与断开的全部判断逻辑。其中端到端用例（`backend_process_support.h`）在两端跑**同一份**
序列与断言：真的拉起后端子进程、按协议对话、落库到 SQLite，网卡与计数数据由
`--fake-adapter` / `--fake-counters` 注入（Windows 下把自定义环境块交给 `CreateProcess`
时子进程读不到变量，因此用命令行参数）。`apps/desktop/tests/windows-packaging.test.js`
另外确认解包目录里确实带着后端，且它是真正的 Windows 可执行文件。

同一份端到端用例也可以在 Windows 实机上直接跑（覆盖 CreateProcess、管道与真实文件系统）：

```powershell
# 把 build/windows/tests/backend_process_test.exe 与
# build/windows/app/wifimeter-backend.exe 放到同一个目录，然后：
$env:WIFIMETER_BACKEND_BINARY = (Resolve-Path '.\wifimeter-backend.exe').Path
.\backend_process_test.exe
Remove-Item Env:WIFIMETER_BACKEND_BINARY
```

环境变量用于覆盖构建时写入的路径（交叉编译出来的是构建机的 Linux 路径）。同理，
`windows_smoke_test.exe` 可以直接在 Windows 上运行，它会只读地核对 WLAN API 与
IP Helper 的真实行为（别名一致性、计数可查、频段只报 2.4 GHz 或留空、断开守卫）。

Wine 下的系统调用与真实 Windows 不同（WLAN API 常返回空适配器列表），因此下面几项必须实机验证。

## 实机验收

逐步清单（含每步的期望结果）见 **[ACCEPTANCE.md](ACCEPTANCE.md)**；其中机器能验的部分已经脚本化：

```powershell
node packaging/windows/acceptance.mjs
```

它检查打包产物、跑真机只读自检与端到端用例、并在真实网卡上做一轮只读采样，
输出「通过 / 跳过 / 失败」三类（跳过表示需要人工确认）。

下面是需要人工确认的部分提纲，在 Windows 10/11 x64 上：

1. 运行安装包，确认安装路径可选，并出现独立的快捷方式；安装完成后应用能启动。
2. 打开应用，确认总览页显示“正在采集”，历史与额度来自真实采集而不是示例数据。
3. 点击“采集状态”，确认列出本机无线网卡的名称、信号与状态（中文网卡名不应是乱码）。
4. 连接/断开 Wi-Fi，确认网络页与总览页的当前网络随之变化；切换网络期间的流量不应计入旧网络。
5. 修改网络备注与单位，退出再打开，确认设置保留；确认数据文件位于
   `%APPDATA%\WiFiMeter Demo\wifimeter.db`。
6. 导出 CSV/JSON，备份并恢复数据；取消保存时不应提示成功。
7. 打开“开机启动”并注销重登，确认应用自动启动；关闭后确认登录启动项被移除
   （任务管理器的“启动”页或 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`）。
8. 打开托盘开关，确认关闭窗口只隐藏、托盘图标可恢复窗口、右键可退出。
9. 设置一个很小的额度上限，确认收到系统通知；若开启超额断开，确认应用真的断开了那个网络，
   并在“采集状态”里能看到断开结果。
10. 需要与旧版 WiFiMeter 共存时，选择不同的安装目录，确认快捷方式和数据互不覆盖。
11. 从 Windows 应用列表卸载示例版，确认旧版仍可用，示例版用户数据保留。

已知限制：频段显示为“未知”，因为 Win32 不通过 WLAN API 暴露当前信道。

## 构建边界与实现要点

`build.cjs` 是唯一入口：Windows 上用本机 CMake 构建后端，其他系统上用 `build-backend.mjs`
（Zig + `toolchain-mingw.cmake`）交叉编译；两者都显式使用 x64 NSIS、禁止自动发布与证书自动发现，
并把缓存改到 `.cross-build/`（`HOME` 只读时也能构建）。`electron-builder.cjs` 覆盖共享配置中的
产品名称、标识与输出路径，并把 `build/windows/app/wifimeter-backend.exe` 作为 extraResources
放进 `resources/`，与主进程的查找规则一致。旧 Windows 发布工作流保持独立。
