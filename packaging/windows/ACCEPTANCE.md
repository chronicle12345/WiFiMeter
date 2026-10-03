# Windows 安装版验收

本清单针对 Linux 交叉构建的 Tauri 安装包。旧 Electron 版本的安装验收不作为本次通过依据；当前已执行的自动测试及限制见[构建矩阵](../../docs/PACKAGING-MATRIX.md)。

## 构建与自动验证

在 Linux 构建：

```sh
./packaging/build-windows.sh
```

在 Windows 图形会话验证完整解压的便携包：

```powershell
npm ci --prefix apps/desktop
$env:WIFIMETER_EXECUTABLE = (Resolve-Path 'dist/windows/win-unpacked/WiFiMeter.exe').Path
$env:WIFIMETER_BACKEND = (Resolve-Path 'dist/windows/win-unpacked/wifimeter-backend.exe').Path
node apps/desktop/tests/e2e/smoke-package-windows.mjs
Remove-Item Env:WIFIMETER_EXECUTABLE, Env:WIFIMETER_BACKEND
```

该检查使用隔离配置和测试数据，验证发布版页面、随包后端、暂停与恢复，不执行安装器。完整调试宿主检查、浏览器测试及 Rust 测试命令见[桌面说明](../../apps/desktop/README.md)。浏览器测试不会因设置可执行文件路径而变成安装版测试。

## 安装与升级

产物为 `dist/windows/WiFiMeter-1.2.2-windows-x64-Setup.exe`。用测试账户或虚拟机执行以下检查并记录安装路径：

- [ ] 中文、英文向导均可用；安装目录和安装范围可选择。
- [ ] 安装后快捷方式可启动应用，应用图标正确，随包后端正常运行。
- [ ] 已有 WebView2 时复用；缺少运行时的联网测试机能完成运行时安装。
- [ ] 旧实例退出并保存后升级成功；升级保留历史、网络备注、额度与偏好。
- [ ] 改用其他安装目录时，不终止另一目录的旧采集器。
- [ ] 卸载移除对应安装文件、快捷方式和卸载项，保留用户数据。

Windows 数据目录沿用 `%APPDATA%\WiFiMeter Demo`。不同安装目录仍可能共用产品身份与数据目录，不能视为相互隔离的独立账户。

## 界面与系统行为

- [ ] 中文、英文设置与各类确认弹窗一致；浅色、深色主题匹配主界面。
- [ ] 拖拽、贴边、悬停及浮窗交互正常；锁屏或不可接受鼠标输入的桌面不能作为通过结果。
- [ ] 关闭到托盘后可恢复，退出后采集器完成保存并停止。
- [ ] 开启登录自启动后重新登录可启动；关闭后启动项移除。
- [ ] 安装版的额度提醒出现在通知中心，应用名和内容符合当前语言。
- [ ] 当前网络显示真实网卡和 SSID；产生流量后用量增加，切换网络后归属正确。
- [ ] 在专用测试网络验证额度断开，并在结束后恢复原有额度。

## 数据与文件

- [ ] 重启后设置和历史保留，数据库位于上述用户数据目录。
- [ ] 「设置 → 数据与存储」显示当前数据库路径；更到中文路径文件夹后 `wifimeter.db` 出现在新文件夹，原文件仍在，重启后历史与设置一致（含语言、单位、保留时长）。
- [ ] 目标文件夹已有数据库时弹窗可选「使用目标数据」或「用当前数据替换」；替换后原文件以 `wifimeter.db.replaced-<时间戳>` 保留，取消不改动文件。
- [ ] 自定义文件夹不可用（改名或断开移动盘）后重启，出现不可用弹窗；选择「暂时使用默认位置」能继续采集，重新命名回去后下次启动仍使用原自定义位置。
- [ ] CSV 和完整 JSON 备份可保存到中文路径，取消保存不显示成功。
- [ ] 在隔离配置下恢复备份，记录、备注与额度一致。
- [ ] 旧文件版数据导入保留原文件；重复导入不重复累计，冲突有明确提示。

记录测试版本、Windows / WebView2 版本、操作步骤、预期与实际结果。以上未勾选项均不代表已经验收。
