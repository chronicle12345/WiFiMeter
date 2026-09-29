# Windows 示例版安装包

在 Windows 10/11 x64 本机生成带向导的 NSIS `.exe` 安装包，不使用 Docker，不依赖旧版 WPF 项目或 C++ 编译器。

## 打包

1. 安装 Node.js 22.12 或更新的受支持版本（x64，包含 npm）。
2. 将项目源码放到 Windows 机器，包含根目录的 `package.json`、`apps/desktop/` 和 `packaging/`。不要从 Linux 复制 `node_modules/`，在 Windows 重新安装依赖。
3. 在项目根目录打开 PowerShell，执行：

```powershell
npm ci --prefix apps/desktop
npm run dist:windows
```

如果 PowerShell 提示不能运行 `npm.ps1`，将上面的 `npm` 替换为 `npm.cmd` 即可。

首次构建需要下载 npm 依赖、Windows Electron 运行组件及 NSIS 等工具。等待终端显示构建完成；运行生成的程序不需要联网，也不需要另外安装 Node.js。

输出：

```text
dist/windows/WiFiMeter-Demo-0.1.0-x64-Setup.exe
dist/windows/win-unpacked/WiFiMeter Demo.exe
```

安装包文件名跟随桌面应用 `package.json` 中的版本号变化。也可在 `apps/desktop/` 下执行 `npm run dist:windows`。

## 安装行为

- 名称：**WiFiMeter Demo**；应用标识：`io.wifimeter.demo`。
- 安装向导默认选择当前用户，默认目录为 `%LOCALAPPDATA%\Programs\WiFiMeter Demo`；可以选择安装目录。
- 创建独立的桌面、开始菜单快捷方式与卸载入口。
- 应用设置和演示记录保存在 `%APPDATA%\WiFiMeter Demo`，与旧版隔离；卸载默认保留该目录。
- 包含四个页面和示例数据，不采集真实网络。自启动、托盘和断网选项仍为演示。
- 当前构建不签名、不自动发布。Windows 可能显示“未知发布者”或 SmartScreen 提示。

## 本机验证

打包前可以预览和运行测试：

```powershell
npm start
npm test
```

测试打包后的程序：

```powershell
$env:WIFIMETER_EXECUTABLE = (Resolve-Path '.\dist\windows\win-unpacked\WiFiMeter Demo.exe').Path
npm run test:ui
Remove-Item Env:WIFIMETER_EXECUTABLE
```

手动验收：

1. 运行安装包，确认安装路径可选，并出现独立的快捷方式。
2. 打开应用，检查总览、网络、历史、设置四页以及“演示数据”标识。
3. 修改网络备注和单位，退出再打开，确认设置保留。
4. 导出 CSV/JSON，备份并恢复数据；取消保存时不应提示成功。
5. 与旧版 WiFiMeter 同时安装和启动，确认安装目录、快捷方式和数据互不覆盖。
6. 从 Windows 应用列表卸载示例版，确认旧版仍可用，示例版用户数据保留。

安装和 Windows 界面验证需要在 Windows 上完成。此目录的配置校验不代表已经通过实机安装测试。

## 构建边界

`build.cjs` 只在 Windows 上运行，显式使用 x64 NSIS、禁止自动发布和证书自动发现；`electron-builder.cjs` 覆盖共享配置中的产品名称、标识和输出路径，不引用 Linux 的 `electronDist`。旧 Windows 发布工作流保持独立。
