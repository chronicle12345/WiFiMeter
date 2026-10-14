# CI 与发布矩阵

[English](PACKAGING-MATRIX.md) | 简体中文

## Tauri 完整发布矩阵

1.3.x 提供 Windows 和 Linux 的完整构建与发布目标。当前正式版本的功能、安装方法和限制见[1.3.4 发布说明](releases/v1.3.4.md#中文)和 [Releases](https://github.com/chronicle12345/WiFiMeter/releases)。历史版本的性能与产物记录只适用于对应版本。

| 系统与架构 | 产物 |
| --- | --- |
| Windows x64 | NSIS Setup.exe |
| Windows x86（ia32） | NSIS Setup.exe |
| Windows ARM64 | NSIS Setup.exe |
| Linux x64 | deb、rpm、AppImage |
| Linux ARM64 | deb、rpm、AppImage |

[tauri.yml](../.github/workflows/tauri.yml) 使用对应架构的原生环境；Windows x86 在 x64 Windows 上运行 32 位 Node 与测试程序，Rust 目标为 `i686-pc-windows-msvc`。ARM64 使用 GitHub ARM64 runner。Linux 保持 Ubuntu 22.04 和 glibc 2.35 构建基线。

main push、pull request、手动运行及 `v1.3.*` 标签共用一套 Desktop CI。完整矩阵构建实际后端、Rust 宿主和安装包，逐个核对可执行文件架构与运行资源。业务界面回归检查实际执行数量，并拒绝意外跳过、失败或不稳定重试。Windows 使用真实 WebView2；Linux 启动真实 WebKitGTK。任何必需检查失败都阻止发布。

开发态 Playwright 检查自动发现 `apps/desktop/tests/` 中的所有 `*.spec.js`，在 Windows x64 与 Linux x64 的无头浏览器中各执行完整回归，通过两个分片并行处理。测试加载真实 Tauri 页面桥接与隔离的 Node 业务宿主，C++ 数据夹具仍实际运行，系统能力使用替身。浏览器回归与五平台编译打包独立推进，最终必需检查同时汇总各分片与平台结果。主线不安装或启动 Electron。

标签优先复用同一个提交已经通过 main CI 的完整产物。复用前核对仓库、工作流、提交、完整浏览器回归、五平台检查和未过期的附件；条件不满足时执行完整矩阵。发布仍重新核对九个安装包的内部 SHA-256，避免标签重复编译相同代码。

CI 复用已校验的 Node 运行时，并按系统、架构、Rust 编译器及 Cargo 依赖配置缓存 Rust 编译结果。Rust 缓存保留依赖源码、编译结果、编译指纹及构建脚本输出；测试构建关闭调试符号和增量缓存，减少传输体积。恢复缓存后，构建、测试和包内验证仍实际执行。

Linux 还在 `RUNNER_TEMP` 下缓存独立的 `tauri-driver` 2.0.5 安装目录，缓存键包含 runner、架构、Rust 编译器、固定 driver 版本及缓存验证代码。使用前核对 Cargo 安装记录中的固定版本、可执行文件 SHA-256、ELF 架构，并执行 `--help` 检查程序能否启动；该版本不支持 `--version`。安装目录缺失或验证失败时，先归档再按锁定依赖重新安装。libbpf 1.3.3 静态安装目录使用独立缓存，键包含 Ubuntu 22.04 基线、架构、GCC 与 binutils 版本、前置库 ABI 版本、固定源码 SHA-256 及依赖脚本。恢复的头文件和静态库须通过实际编译、链接和运行 ABI 探针；验证失败时先归档缓存，再按现有流程下载、校验和构建。这些缓存不替代原生采集、浏览器回归或包内 WebView 检查；耗时结论须来自实际冷缓存与热缓存 CI。

Windows 在缺少 WebView2 时，从微软官方下载 Bootstrapper，校验微软签名后安装并复查版本。集成检查使用隔离配置和随机本机端口。微软的[高权限宿主说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags)指出高权限进程会忽略 `WEBVIEW2_*` 环境覆盖；专用调试参数仅在后台测试与配置隔离同时启用时生效。

Tauri 使用系统 WebView，随包提供 Node 业务进程、C++ 后端、采集器与许可证，发行资源不包含 Electron 或 Chromium。Windows 安装器可下载缺少的 WebView2；Linux 依赖 WebKitGTK 4.1。Windows ARM64 暂不支持 WinDivert 下载限速。悬浮窗当前仅支持 Windows；Linux 集成检查验证应用分钟查询、偏好保存与重载，并确认请求小窗后不创建原生窗口。

正式 CI 使用 `actions/setup-node` 提供的 Node.js 22.23.3 官方二进制，通过 `runtime-check.cjs` 核对必要能力并检查目标架构与许可证。运行时源码裁剪、Zig/Wine 交叉编译和旧版独立产品构建工具已归档，当前 Windows 与 Linux 目标使用各自本机工具链。运行时配置和本机构建方法见[打包说明](../packaging/README.zh-CN.md#tauri-安装包)。

NSIS 使用 64 MiB LZMA 字典。Linux RPM 使用 XZ，AppImage 使用官方插件支持的 ZSTD。RPM 的摘要校验和 `bsdtar` 解包均须成功，三个格式继续逐个执行完整资源与原生界面检查。

便携压缩包已取消。每组 CI artifact 保留安装包与内部 SHA-256 清单，发布任务重新验证五组的名称、数量和校验值，只把九个应用安装包上传 Release。校验 TXT 不进入公开下载附件。

`packaging/tauri/release.cjs` 要求根目录、桌面 package、Tauri 配置与 Cargo 版本一致，发布标签和说明必须匹配。标签发布还核对两份 README 的版本徽章、替代文字和对应发布说明链接。全部检查通过后创建草稿并上传完整附件，再公开。已有同名 Release 或草稿会使创建失败，不会自动覆盖。默认 `contents: read`，仅发布任务使用 `contents: write` 和当前运行的 `GITHUB_TOKEN`。

## 发布前检查

创建或推送 `v<版本>` 标签前，依次核对以下内容：

1. 同步 `package.json`、`apps/desktop/package.json`、`apps/desktop/src-tauri/tauri.conf.json`、`apps/desktop/src-tauri/Cargo.toml` 及锁文件中的本项目版本。标签与这些文件必须一致，第三方依赖版本不随本项目版本改动。
   CMake 从根 `package.json` 读取后端构建版本，两个平台入口不得写死发行版本号。发布前运行编译产物的 `--version`，核对桌面元数据与实际后端版本一致。
2. 同一提交更新 `README.md` 和 `README.zh-CN.md` 的版本徽章、发布说明链接、功能、安装与升级方法、平台支持及限制，并在 `CHANGELOG.md` 记录对应版本。涉及架构、打包或数据格式时，同时更新相关文档。
3. 发布说明保存为 `docs/releases/v<版本>.md`，固定将 `## English` 放在前面，`## 中文` 放在后面，两种语言的功能、修复、安装方法及限制必须对应；GitHub Release 正文使用同一份文件。尚未发布的修改只写入未发布记录。
4. 标签提交的完整 CI/CD 检查必须通过。优先复用同一提交已验证的产物；附件名称、大小、内部 SHA-256 和验证结果来自实际产物，不能沿用旧版本记录。公开附件仅包含上表九个安装包。
5. 整套安装包的下载、跨平台校验及发布后公开下载验证在 GitHub Actions 中完成。本机优先查询必要元数据并复用缓存，避免重复下载整套附件。

安装与更新测试必须使用隔离安装和数据目录，或使用系统接口替身；后台测试关闭可见窗口、原生对话框和系统通知。源码只跟踪必要代码、测试、许可证及产品和维护文档；代理规则、个人编辑器配置、凭据、用户数据库、日志和构建产物由 `.gitignore` 排除，已跟踪的个人文件还须取消跟踪。

## 本机验证

本机 Windows x64 检查前，先按[打包说明](../packaging/README.zh-CN.md#tauri-安装包)准备目标架构的 Node 运行时与依赖：

```powershell
npm run test:packaging:tauri
npm run dist:windows
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --features custom-protocol --locked
node packaging/tauri/verify-windows.cjs
```

NSIS 完整安装/卸载、下载限速吞吐和真实驱动加载需要目标机器验收，解包后的程序运行不等于执行安装/卸载。

Electron 1.2.x 用户从 [Releases](https://github.com/chronicle12345/WiFiMeter/releases) 获取系统和 CPU 对应的 Tauri 安装版。Windows 继续读取 `%APPDATA%\WiFiMeter Demo\wifimeter.db`，后续更新选择对应的 Tauri 安装包。

当前源码的 Windows 更新流程为：检查 → 确认下载 → 校验长度和 SHA-256 → 确认自动安装 → 保存设置和数据库 → 静默安装并重启。此流程尚未发布，正式版 1.3.4 仍自动下载和安装。手动与启动检查均仅读取版本信息；不下载时不得传输安装包。暂不安装时保留已校验文件，安装前再次核对长度和 SHA-256，通过后才能停止程序。更新验证须覆盖两次确认、已校验缓存复用、未保存修改、保存失败和安装交接恢复。Linux 继续通过官方版本页手动安装。
