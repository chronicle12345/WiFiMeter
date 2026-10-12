# Windows 安装器收尾检查

本项目固定使用 Tauri CLI 2.12.1 的 NSIS 模板副本 `installer.nsi`，通过 `installerHooks` 替换 `CheckIfAppIsRunning` 宏。`utils.nsh` 中的原宏已删除，安装和卸载时的全部调用都会执行 `packaging/tauri/windows/process-guard.nsh` 的 `customCheckAppRunning`。共享进程保护已迁入 Tauri 打包目录，旧 Electron 打包入口归档。

该检查先确认旧采集器完成保存并退出。运行中的桌面版本需要用户正常退出；检查失败时中止操作，不强制结束进程。卸载沿用 Tauri 默认行为，默认不删除用户数据。

依据：

- [Tauri CLI 2.12.1 installer.nsi](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.12.1/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)：先包含 `utils.nsh`，再包含 `installer_hooks`；安装和卸载都调用 `CheckIfAppIsRunning`。
- [Tauri CLI 2.12.1 utils.nsh](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.12.1/crates/tauri-bundler/src/bundle/windows/nsis/utils.nsh)：默认宏调用 Restart Manager 强制关闭进程。
- [NSIS !macroundef 文档](https://nsis.sourceforge.io/Docs/Chapter5.html#macroundef)：支持删除已有宏后重新定义。

官方模板原始文件为 32,061 字节，SHA-256 为 `dabed59013b1d78b879a1a85bc7f2eed2993b33a9a90cdabe5946de3d3950597`。副本仅增加许可证说明、旧 NSIS 卸载命令执行前的缺失卸载程序修复分支，以及默认安装目录恢复时的同一探测调用。后者使跳过页面回调的 `/S` 安装也能修复原目录；版本比较、有效卸载程序、WebView2 和用户数据处理沿用官方逻辑。

修复探测只读取本产品的 HKCU 固定卸载键，核对显示名称、发布者、绝对安装目录、主程序产品身份和该目录内已知卸载程序名称。发布者必须与当前模板一致，忽略大小写；固定模板默认从应用标识 `io.wifimeter.demo` 取 `wifimeter`，因此匹配已核实的旧 `WiFiMeter` 发布者。只有明确缺失卸载程序时才使用确认过的原安装目录，并通过同一退出检查后原地重新安装；访问错误不视为缺失。探测不删除注册表项或文件；可疑记录拒绝修复，普通安装沿用官方模板。运行程序无法安全退出时中止。

`hooks.nsh` 及项目收尾检查采用项目 MIT 许可证。模板副本采用 Tauri 官方 MIT 许可证，保留 Tauri Apps Contributors 的版权说明；见 `LICENSE-MIT.txt`。
