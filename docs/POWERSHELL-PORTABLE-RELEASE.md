# 原版 PowerShell 构建参考

当前 1.3.x 发布统一使用 Tauri，只提供九个安装包。旧版 1.1.1 PowerShell 便携包属于历史产品，当前发布流程不追加该附件。

## 固定历史来源

保留的 .github/workflows/legacy-powershell.yml 与 .github/workflows/scripts/build-legacy-powershell.ps1 可重建原版。v1.1.1 的固定提交为 2e924647957cc631e33ae099fefb56391e86afc4。构建脚本核对标签与提交，通过 git archive 导出历史源码，并调用原版 tools/Build.ps1。它不使用当前 Tauri 产品源码或图标。

输出 WiFiMeter-1.1.1-PowerShell-windows-Portable.zip 及内部 manifest.json。清单记录来源、版本、名称、大小与 SHA-256；ZIP 来自该次实际构建，不保证与历史包逐字节相同。旧版交互桌面测试仍需适用环境单独验证。

## 本机检查

需要对应标签、Windows PowerShell 5.1 与 .NET Framework。测试和构建必须使用独立目录，并按项目约定归档到 del，不操作现有用户安装。重建历史产物不会修改当前版本或触发正式发布。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .github/workflows/scripts/build-legacy-powershell.ps1 -OutputDirectory del/powershell-1.1.1-build
```

已发布版本的功能、附件与验证事实见各自的 docs/releases 文档；旧 Electron 构建和发布入口已从当前主线移除。
