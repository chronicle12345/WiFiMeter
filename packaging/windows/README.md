# Windows 安装包：本机构建与在 Linux 上交叉编译

生成带向导的 NSIS `.exe` 安装包。两条路径产出同一个产品 **WiFiMeter Demo**（64 位、未签名），
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
dist/windows/WiFiMeter-Demo-0.1.0-x64-Setup.exe
dist/windows/win-unpacked/WiFiMeter Demo.exe
dist/windows/win-unpacked/resources/wifimeter-backend.exe
```

安装包文件名跟随桌面应用 `package.json` 中的版本号变化。也可在 `apps/desktop/` 下执行 `npm run dist:windows`。

## 安装行为

- 名称：**WiFiMeter Demo**；应用标识：`io.wifimeter.demo`。
- 安装向导默认选择当前用户，默认目录为 `%LOCALAPPDATA%\Programs\WiFiMeter Demo`；可以选择安装目录。
- 创建独立的桌面、开始菜单快捷方式与卸载入口。
- 应用设置与采集记录保存在 `%APPDATA%\WiFiMeter Demo`，后端默认数据库在
  `%LOCALAPPDATA%\WiFiMeter\wifimeter.db`（主进程始终显式传入 `--db`，两者用的是同一个文件）；
  与旧版隔离，卸载默认保留数据。
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
以及采样与断开的全部判断逻辑。`apps/desktop/tests/windows-packaging.test.js` 另外确认解包目录里
带着后端，并让那个后端在 Wine 下完成握手、采集与快照。

Wine 下的系统调用与真实 Windows 不同（WLAN API 常返回空适配器列表），因此下面几项必须实机验证。

## 实机验收

在 Windows 10/11 x64 上：

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
10. 与旧版 WiFiMeter 同时安装和启动，确认安装目录、快捷方式和数据互不覆盖。
11. 从 Windows 应用列表卸载示例版，确认旧版仍可用，示例版用户数据保留。

已知限制：频段显示为“未知”，因为 Win32 不通过 WLAN API 暴露当前信道。

## 构建边界与实现要点

`build.cjs` 是唯一入口：Windows 上用本机 CMake 构建后端，其他系统上用 `build-backend.mjs`
（Zig + `toolchain-mingw.cmake`）交叉编译；两者都显式使用 x64 NSIS、禁止自动发布与证书自动发现，
并把缓存改到 `.cross-build/`（`HOME` 只读时也能构建）。`electron-builder.cjs` 覆盖共享配置中的
产品名称、标识与输出路径，并把 `build/windows/app/wifimeter-backend.exe` 作为 extraResources
放进 `resources/`，与主进程的查找规则一致。旧 Windows 发布工作流保持独立。
