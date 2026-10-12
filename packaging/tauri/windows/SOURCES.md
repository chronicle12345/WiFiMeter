# Windows installer shutdown checks

English | [简体中文](SOURCES.zh-CN.md)

This project pins a copy of the Tauri CLI 2.12.1 NSIS template, `installer.nsi`, and replaces the `CheckIfAppIsRunning` macro through `installerHooks`. The original macro from `utils.nsh` is undefined, so every installation and uninstallation call runs `customCheckAppRunning` from `packaging/tauri/windows/process-guard.nsh`. Shared process protection has moved into the Tauri packaging directory; the legacy Electron packaging entry point has been archived.

The check first confirms that the legacy collector has saved its data and exited. Users must exit a running desktop version normally. A failed check aborts the operation without forcibly terminating processes. Uninstallation retains Tauri's default behavior and does not remove user data by default.

References:

- [Tauri CLI 2.12.1 installer.nsi](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.12.1/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi): includes `utils.nsh` before `installer_hooks`; both installation and uninstallation call `CheckIfAppIsRunning`.
- [Tauri CLI 2.12.1 utils.nsh](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.12.1/crates/tauri-bundler/src/bundle/windows/nsis/utils.nsh): the default macro calls Restart Manager to forcibly close processes.
- [NSIS !macroundef documentation](https://nsis.sourceforge.io/Docs/Chapter5.html#macroundef): supports undefining an existing macro before redefining it.

The original upstream template is 32,061 bytes with SHA-256 `dabed59013b1d78b879a1a85bc7f2eed2993b33a9a90cdabe5946de3d3950597`. The copy adds only a license notice, a repair branch for missing uninstallers before executing a legacy NSIS uninstall command, and the same probe when restoring the default installation directory. The latter allows `/S` installations, which skip page callbacks, to repair the original directory. Version comparison, valid uninstallers, WebView2, and user data handling retain the upstream logic.

The repair probe reads only this product's fixed HKCU uninstall key. It checks the display name, publisher, absolute installation directory, main executable's product identity, and known uninstaller names within that directory. The publisher must match the current template, ignoring case. The pinned template derives `wifimeter` from the application identifier `io.wifimeter.demo` by default, matching the verified legacy `WiFiMeter` publisher. Only an explicitly missing uninstaller permits reuse of the verified original installation directory and reinstallation in place after the same shutdown check. Access errors are not treated as missing files. The probe does not delete registry entries or files. Suspicious records are rejected for repair; ordinary installation follows the upstream template. The operation aborts if a running application cannot exit safely.

`hooks.nsh` and the project's shutdown checks use the project's MIT license. The template copy uses Tauri's upstream MIT license and retains the Tauri Apps Contributors copyright notice; see [LICENSE-MIT.txt](LICENSE-MIT.txt).
