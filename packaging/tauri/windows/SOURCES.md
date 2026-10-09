# Windows 安装器收尾检查

本项目使用官方 Tauri CLI 2.12.1 默认 NSIS 模板，通过 `installerHooks` 替换 `CheckIfAppIsRunning` 宏。`utils.nsh` 中的原宏已删除，安装和卸载时的全部调用都会执行原项目 `packaging/windows/installer.nsh` 的 `customCheckAppRunning`。

该检查先确认旧采集器完成保存并退出。运行中的桌面版本需要用户正常退出；检查失败时中止操作，不强制结束进程。卸载沿用 Tauri 默认行为，默认不删除用户数据。

依据：

- [Tauri CLI 2.12.1 installer.nsi](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.12.1/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)：先包含 `utils.nsh`，再包含 `installer_hooks`；安装和卸载都调用 `CheckIfAppIsRunning`。
- [Tauri CLI 2.12.1 utils.nsh](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.12.1/crates/tauri-bundler/src/bundle/windows/nsis/utils.nsh)：默认宏调用 Restart Manager 强制关闭进程。
- [NSIS !macroundef 文档](https://nsis.sourceforge.io/Docs/Chapter5.html#macroundef)：支持删除已有宏后重新定义。

`hooks.nsh` 及项目收尾检查采用项目 MIT 许可证。未复制或修改 Tauri 的模板；Tauri 官方源码采用 MIT 或 Apache-2.0 许可证。
