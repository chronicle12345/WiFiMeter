# Release 附带原版 PowerShell 便携包

后续由现有 `desktop.yml` 发布的 Release，除五组平台矩阵生成的 12 个 Electron 产物外，还必须上传 `WiFiMeter-1.1.1-PowerShell-windows-Portable.zip`。现有发布触发条件保持为推送 `v1.2.*` 标签；手动运行和 Pull Request 只构建、验证，不发布。今后扩展版本系列时，需要同步调整现有标签校验和触发条件，保留附件步骤。

## 来源和内容

2026-10-02 核对本地与 origin（https://github.com/chronicle12345/WiFiMeter.git）：v1.1.1 的 annotated tag 对象为 `81d8fae08e64202e9245590727a1b55954ae8731`，解引用后的提交均为 `2e924647957cc631e33ae099fefb56391e86afc4`。

生成脚本同时要求本地 v1.1.1 指向该提交，并通过提交 SHA 执行 `git archive`，导出到独立目录。工作流通过完整 checkout 获取远端标签；标签缺失或移动都会导致构建失败。脚本不使用当前工作区的产品源码、图标或构建配置。

直接运行固定提交中的 `tools/Build.ps1`，将生成的 `dist/WiFiMeter-Portable.zip` 原样复制为带有版本和 PowerShell 标识的附件。ZIP 保留 `WiFiMeter/` 顶层目录、原版图标、程序、脚本及使用文档；不添加说明文件，不替换内部版本。该流程重新编译原版源码，并不承诺与历史 Release 的 ZIP 或 EXE 逐字节相同，编译和压缩时间戳可能不同。脚本校验 EXE 内部文件版本为 1.1.1.0，逐文件比对运行时源码、配置和文档，并核对 ZIP 全部文件与本次原版构建输出一致。

## 构建和上传

`.github/workflows/legacy-powershell.yml` 是可通过 `workflow_call` 复用的 Windows 构建工作流。它调用 `.github/workflows/scripts/build-legacy-powershell.ps1`，再运行导出源码中的 `tests/Run-All.ps1 -SkipDesktopTests`。沿用原版 Release 的测试模式，三个需要交互桌面的测试套件不在此处执行。

CI artifact `legacy-powershell-1.1.1` 只包含 ZIP 和 `manifest.json`。清单记录固定标签、提交、版本、运行时、文件名、大小及 SHA-256。临时源码和原版构建时附带生成的安装程序不上传。附件构建是 required 和 publish 的依赖，失败会阻止发布。

发布任务先验证现有 12 个 Electron 产物，再单独下载旧版 artifact。`.github/workflows/scripts/legacy-powershell.cjs` 核对固定来源、文件名、大小和 SHA-256，将 ZIP 的绝对路径追加到同一份上传列表。最终 `gh release create` 收到全部 13 个下载文件，先上传到草稿，再公开。清单只用于 CI 校验，不作为用户下载附件。任何附件缺失或校验失败都会在创建 Release 之前终止。

发布说明会拼接 `docs/releases/powershell-1.1.1-attachment.md`，明确说明额外下载为 1.1.1 / PowerShell，不属于当前 Electron 版本。以后新增 Release 说明时无需重复复制这段文字。

## 本地复用和验证

在具有该标签和 Windows PowerShell 5.1 / .NET Framework 的 Windows 仓库中运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .github/workflows/scripts/build-legacy-powershell.ps1 -OutputDirectory "$env:TEMP/wifimeter-legacy"
node --test .github/workflows/scripts/ci.test.cjs .github/workflows/scripts/legacy-powershell.test.cjs
```

输出目录包含 ZIP、清单以及独立的 `source-<随机标识>` 目录，后者保留导出源码和校验解压结果，供检查使用；每次调用使用新的导出目录。构建脚本只生成本地文件，不执行发布。若本地缺少标签，先从经过核对的 origin 获取 v1.1.1；网络访问遵循当前环境的授权要求。

在导出源码目录可执行 `powershell -NoProfile -ExecutionPolicy Bypass -File tests/Run-All.ps1 -SkipDesktopTests`。辅助脚本测试覆盖错误来源、混入当前版本、错误运行时、路径替换、空文件、缺失文件、大小和哈希不符。工作流语法由现有固定版本 actionlint 检查。

## 本次本地交付验证

已生成 `dist/windows/WiFiMeter-1.1.1-PowerShell-windows-Portable.zip`，大小为 122819 字节（约 120 KiB），包含 23 个原版文件。SHA-256 为 `0b24aa0cbbffa10628052a7dedfe3e202b70682e493b04725232c2fcf8e95601`。交付文件与通过内容校验的原版构建 ZIP 哈希一致；这一哈希仅对应本次构建。

原版非桌面测试全部通过，包括实时采样、集成测试和安装程序的 118 项断言；UI、Dialogs.Details、Host 三个交互桌面套件按原版 Release 参数跳过。原版测试首次在沙箱内因测试注册表写入被拒绝而终止，获准在沙箱外运行后通过。CI 辅助测试 6 项通过，actionlint 1.7.12 对三个工作流的检查通过。未执行 GitHub 发布；实际远端上传将在满足标签触发条件时由工作流完成。
