# Windows 包

在 Linux x64 上运行 `node packaging/build-windows.cjs`，生成 NSIS 安装器与便携 ZIP。Rust 宿主使用 MinGW，C++ 后端使用校验下载的 Zig，NSIS 也在 Linux 执行。依赖、参数和三个入口见[统一打包说明](../README.md)。

产物位于 `dist/windows/`，运行目录为 `win-unpacked/`；主程序、两个采集程序与 `WebView2Loader.dll` 位于同一目录。程序复用系统 WebView2，未安装时 NSIS 在线获取。

应用标识保持 `io.wifimeter.demo`，数据保存在 `%APPDATA%\WiFiMeter Demo`。安装器有中英文界面，支持当前用户/所有用户及自选目录。升级前要求旧实例安全退出，保留原有数据库和迁移恢复备份。

自动测试命令见[桌面说明](../../apps/desktop/README.md)；需要系统交互的安装、通知、真实网络检查见[验收清单](ACCEPTANCE.md)。CI 在 Linux 构建后，将产物传到 Windows 执行原生测试，不在 Windows 打包。
