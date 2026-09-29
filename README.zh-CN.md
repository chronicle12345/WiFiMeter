# WiFiMeter

[English](README.md) | 简体中文

WiFiMeter 的共享 Electron 桌面应用面向 Windows 和 Linux，后续由本机 C++ 后端提供网络采集与业务数据。目前使用示例数据，Linux 可构建 deb，Windows 可在本机生成独立的 WiFiMeter Demo 安装包；C++ 后端尚未实现。

## 安装依赖与启动

需要 Node.js 22.12 或更新版本、npm 和图形桌面。首次安装依赖及下载 Electron 需要联网，应用运行时可离线使用。

从仓库根目录执行：

```bash
npm ci --prefix apps/desktop
npm start
```

页面包含总览、网络、历史和设置，支持模拟刷新、日期筛选、网络备注、额度、导出与完整备份恢复。点击“演示数据”可切换状态或恢复示例。自启动、托盘和断网只作演示，关闭窗口即退出。

## 测试与打包

```bash
npm test
npm run test:unit
npm run test:ui
npm run dist:linux
```

界面测试需要图形会话，使用临时用户数据目录。Linux 打包在 Ubuntu x64 上使用 electron-builder 和系统自带的 `dpkg-deb`。

安装生成的 deb：

```bash
sudo apt install ./dist/linux/WiFiMeter-0.1.0-linux-amd64.deb
```

安装后在应用菜单打开 WiFiMeter，或运行 `wifimeter`。卸载：`sudo apt remove wifimeter-linux`。

## Windows 示例安装包

在 Windows 10/11 x64 上，安装 Node.js 22.12 或更新版本后，从仓库根目录执行：

```powershell
npm ci --prefix apps/desktop
npm run dist:windows
```

输出为 `dist/windows/WiFiMeter-Demo-0.1.0-x64-Setup.exe`。程序使用独立名称、安装目录和用户数据目录，可与旧版并存。此示例包未签名，不使用 Docker。详见 [Windows 打包与验收](packaging/windows/README.md)。

## 目录

```text
apps/desktop/       共享桌面应用、示例数据和测试
backend/            C++ 后端的职责说明
contracts/          现有数据格式与未来协议边界
packaging/linux/    Linux deb 打包脚本
packaging/windows/  Windows 本机 NSIS 安装包构建
legacy/windows/     原 WPF/PowerShell 应用、文档和测试
docs/               新架构说明
build/              后续编译中间产物（忽略提交）
dist/linux/         Linux 发布产物（忽略提交）
dist/windows/       Windows 发布产物（忽略提交）
```

详见[架构说明](docs/ARCHITECTURE.md)和[桌面应用说明](apps/desktop/README.md)。依赖锁文件属于 `apps/desktop/`，根目录仅转发命令，不使用 npm workspace。

## 旧 Windows 版本

原有代码已完整保留在 [legacy/windows](legacy/windows/README.zh-CN.md)。在该目录下运行原构建和测试命令。现有 GitHub Actions 继续验证、发布旧 Windows 版本；`v*.*.*` 标签仍触发旧版发布，不代表新版 Electron 应用的版本。

## 许可证

[MIT](LICENSE)
