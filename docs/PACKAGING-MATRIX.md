# CI 与发布矩阵

## Tauri 完整发布矩阵

1.3.x 提供 Windows 和 Linux 的完整构建与发布目标。当前正式版本的功能、安装方法和限制见[1.3.2 发布说明](releases/v1.3.2.md)和 [Releases](https://github.com/chronicle12345/WiFiMeter/releases)。历史版本的性能与产物记录只适用于对应版本。

| 系统与架构 | 产物 |
| --- | --- |
| Windows x64 | NSIS Setup.exe |
| Windows x86（ia32） | NSIS Setup.exe |
| Windows ARM64 | NSIS Setup.exe |
| Linux x64 | deb、rpm、AppImage |
| Linux ARM64 | deb、rpm、AppImage |

[tauri.yml](../.github/workflows/tauri.yml) 使用对应架构的原生环境；Windows x86 在 x64 Windows 上运行 32 位 Node 与测试程序，Rust 目标为 i686-pc-windows-msvc。ARM64 使用 GitHub ARM64 runner。Linux 保持 Ubuntu 22.04 和 glibc 2.35 构建基线。

main push、pull request、手动运行及 v1.3.* 标签共用一套 Desktop CI。完整矩阵构建实际后端、Rust 宿主和安装包，逐个核对可执行文件架构与运行资源。业务界面回归检查实际执行数量，并拒绝意外跳过、失败或不稳定重试。Windows 使用真实 WebView2；Linux 启动真实 WebKitGTK。任何必需检查失败都阻止发布。

开发态 Playwright 检查自动发现 `apps/desktop/tests/` 中的所有 `*.spec.js`，在 Windows x64 与 Linux x64 的无头浏览器中各执行完整回归，通过两个分片并行处理。测试加载真实 Tauri 页面桥接与隔离的 Node 业务宿主，C++ 数据夹具仍实际运行，系统能力使用替身。浏览器回归与五平台编译打包独立推进，最终必需检查同时汇总各分片与平台结果。主线不安装或启动 Electron。

标签优先复用同一个提交已经通过 main CI 的完整产物。复用前核对仓库、工作流、提交、完整浏览器回归、五平台检查和未过期的附件；条件不满足时执行完整矩阵。发布仍重新核对九个安装包的内部 SHA-256，避免标签重复编译相同代码。

CI 复用已校验的 Node 运行时，并按系统、架构、Rust 编译器及 Cargo 依赖配置缓存 Rust 编译结果。Rust 缓存保留依赖源码、编译结果、编译指纹及构建脚本输出；测试构建关闭调试符号和增量缓存，减少传输体积。恢复缓存后，构建、测试和包内验证仍实际执行。

Windows 在缺少 WebView2 时，从微软官方下载 Bootstrapper，校验微软签名后安装并复查版本。集成检查使用隔离配置和随机本机端口。微软的[高权限宿主说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags)指出高权限进程会忽略 WEBVIEW2_* 环境覆盖；专用调试参数仅在后台测试与配置隔离同时启用时生效。

Tauri 使用系统 WebView，随包提供 Node 业务进程、C++ 后端、采集器与许可证，发行资源不包含 Electron 或 Chromium。Windows 安装器可下载缺少的 WebView2；Linux 依赖 WebKitGTK 4.1。Windows ARM64 暂不支持 WinDivert 下载限速。悬浮窗当前仅支持 Windows；Linux 集成检查验证应用分钟查询、偏好保存与重载，并确认请求小窗后不创建原生窗口。

正式 CI 使用 `actions/setup-node` 提供的 Node.js 22.23.3 官方二进制，通过 `runtime-check.cjs` 核对必要能力并检查目标架构与许可证。运行时源码裁剪、Zig/Wine 交叉编译和旧版独立产品构建工具已归档，当前 Windows 与 Linux 目标使用各自本机工具链。运行时配置和本机构建方法见[打包说明](../packaging/README.md#tauri-安装包)。

NSIS 使用 64 MiB LZMA 字典。Linux RPM 使用 XZ，AppImage 使用官方插件支持的 ZSTD。RPM 的摘要校验和 `bsdtar` 解包均须成功，三个格式继续逐个执行完整资源与原生界面检查。

便携压缩包已取消。每组 CI artifact 保留安装包与内部 SHA-256 清单，发布任务重新验证五组的名称、数量和校验值，只把九个应用安装包上传 Release。校验 TXT 不进入公开下载附件。

packaging/tauri/release.cjs 要求根目录、桌面 package、Tauri 配置与 Cargo 版本一致，发布标签和说明必须匹配。标签发布还核对两份 README 的版本徽章、替代文字和对应发布说明链接。创建标签前按 [AGENTS.md](../AGENTS.md) 更新功能、安装方法、限制与更新日志。全部检查通过后创建草稿并上传完整附件，再公开。已有同名 Release 或草稿会使创建失败，不会自动覆盖。默认 contents: read，仅发布任务使用 contents: write 和当前运行的 GITHUB_TOKEN。

本机 Windows x64 检查前，先按[打包说明](../packaging/README.md#tauri-安装包)准备目标架构的 Node 运行时与依赖：

```powershell
npm run test:packaging:tauri
npm run dist:windows
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --features custom-protocol --locked
node packaging/tauri/verify-windows.cjs
```

NSIS 完整安装/卸载、下载限速吞吐和真实驱动加载需要目标机器验收，解包后的程序运行不等于执行安装/卸载。

Electron 1.2.x 用户从 [Releases](https://github.com/chronicle12345/WiFiMeter/releases) 获取系统和 CPU 对应的 Tauri 安装版。Windows 继续读取 %APPDATA%\WiFiMeter Demo\wifimeter.db，后续更新选择对应的 Tauri 安装包。
