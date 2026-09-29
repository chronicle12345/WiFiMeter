# WiFiMeter

[English](README.md) | 简体中文

WiFiMeter 是一个面向 Linux 与 Windows 的 Wi-Fi 流量统计工具。共享的 Electron 桌面应用与本机 C++ 后端通信：后端读取网卡计数器、把流量归属到具体网络，并把历史、额度与偏好写入本机 SQLite 数据库，数据不离开这台机器。Linux 平台层、JSON 协议与桌面接入已完成；Windows 平台层、系统级功能（开机启动、托盘、系统通知）与分应用统计尚未实现。

## 安装依赖与启动

需要 Node.js 22.12 或更新版本、npm 和图形桌面；构建后端还需要 CMake、支持 C++20 的编译器与 SQLite 开发头文件。首次安装依赖及下载 Electron 需要联网，应用运行时可离线使用。

从仓库根目录执行：

```bash
npm ci --prefix apps/desktop
npm start
```

页面包含总览、网络、历史和设置，支持实时刷新、日期筛选、网络备注、额度、导出与完整备份恢复，数据全部来自真实采集。点击“采集状态”可查看采集器与网卡状态。自启动与托盘开关目前只保存偏好，尚未作用于系统。

## 测试与打包

```bash
npm test
npm run test:unit
npm run test:ui
npm run test:backend
npm run dist:linux
```

界面测试需要图形会话，使用临时用户数据目录，并用假的网卡数据驱动真实后端，不会改动机器的网络状态。`npm run dist:linux` 先构建后端，再把应用与 `wifimeter-backend` 一起打进 deb，包依赖 `libsqlite3-0`。设置 `WIFIMETER_EXECUTABLE=dist/linux/linux-unpacked/wifimeter` 可让界面测试跑在打包产物上。

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
apps/desktop/       共享桌面应用、桌面接入与测试
backend/            C++ 后端：平台层、业务规则、SQLite 存储、协议与 wifimeter-backend
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
