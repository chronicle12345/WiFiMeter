# CI 与发布矩阵

[English](PACKAGING-MATRIX.md) | 简体中文

## 当前 Tauri 发布目标

1.3.6 仅构建并发布 Windows x64，其他产品和 Linux 浏览器配置已注释，源码工具继续保留。安装方法及版本限制见[发布说明](releases/v1.3.6.md#中文)与[版本下载](https://github.com/chronicle12345/WiFiMeter/releases)。历史性能与产物记录仅适用于所属版本。

| 系统与架构 | 产物 | 当前 CI 状态 |
| --- | --- | --- |
| Windows x64 | NSIS Setup.exe | 启用，公开一个安装包 |
| Windows x86（ia32） | NSIS Setup.exe | 暂时注释 |
| Windows ARM64 | NSIS Setup.exe | 暂时注释 |
| Linux x64 | deb、rpm、AppImage | 暂时注释 |
| Linux ARM64 | deb、rpm、AppImage | 暂时注释 |

[tauri.yml](../.github/workflows/tauri.yml) 使用 x64 Windows、x64 Node 和 `x86_64-pc-windows-msvc` 构建当前产品。暂停配置保留 x64 Windows 上的 x86 Node/MSVC、原生 ARM64 runner 和 Ubuntu 22.04 / glibc 2.35。Ubuntu 元数据及发布任务不构建 Linux 产品。

## 检查与产物复用

`main` 和 `dev` 推送、拉取请求、手动运行及 `v1.3.*` 标签共用 Desktop CI。普通分支推送运行检查，发布还要求匹配标签。开发与审查规则由[开发流程](DEVELOPMENT.zh-CN.md)维护。

必需检查包括工作流与发布元数据、两个 Windows 浏览器分片，以及 Windows x64 的后端 CTest、真实 ETW/EStats、桌面集成、Rust、可执行文件架构与资源、包内 WebView2 检查。最后的 Required Tauri checks 拒绝必需任务失败、取消或意外跳过。浏览器报告必须实际运行测试，不得有意外跳过、失败、全局错误或不稳定重试。仓库文档和政策检查使用[测试指南](TESTING.zh-CN.md)中的入口。

元数据之后，浏览器分片与产品编译独立运行。测试使用真实页面桥接、隔离 Node/后端夹具及锁定的 Chromium；包内检查运行真实 Tauri 宿主、WebView2 和数据库，在隔离偏好中关闭 `promptAppCollection`，避免启动授权对话框。Windows 原生采集另行运行。Linux eBPF/WebKitGTK 检查随暂停任务恢复，诊断目录保留 `build/tauri-smoke-linux/`。

标签先尝试复用同一提交成功的 `main` 推送运行，核对仓库、工作流、提交、元数据任务、两个浏览器分片、Windows 产品任务、Required checks，以及唯一未过期且来源元数据匹配的 `tauri-release-windows-x64` 产物。无法核实时，标签运行全部当前检查。发布重新校验安装包及内部 SHA-256。

CI 使用 Node.js 22.23.3 官方运行时，按平台、架构、编译器和依赖配置缓存 Rust 依赖与产物；测试配置关闭调试符号和增量缓存。恢复缓存不能代替构建与检查。Windows 缺少 WebView2 时，从微软下载、核对签名、安装并复查。集成使用随机本机端口和隔离目录；高权限宿主的专用调试参数要求后台测试与隔离同时开启。

暂停的 Linux 任务在 `RUNNER_TEMP` 保留独立 `tauri-driver` 2.0.5 和 libbpf 1.3.3 缓存。driver 复用检查 Cargo 安装记录、可执行文件摘要、ELF 架构和 `--help`，libbpf 复用实际编译、链接并运行 ABI 探针。缓存键包含工具链、固定源码或版本及验证脚本；无效项先归档再重建。恢复 Linux 任务后仍需运行原生检查。

## 发布

便携压缩包已取消。Windows CI 产物包含安装包及内部 SHA-256 清单。发布验证恰好一个 Windows x64 NSIS 安装包的名称、数量和摘要，只上传安装包，随后在 GitHub Actions 验证公开下载；校验 TXT 不作为公开附件。恢复目标前，先补齐对应构建、原生、资源、格式、产物数量和发布检查。

[release.cjs](../packaging/tauri/release.cjs) 要求根目录、桌面、Tauri 和 Cargo 版本一致，标签及说明匹配。标签构建还验证两份 README 徽章、替代文字和发布说明链接。工作流创建含全部已验证附件的草稿，再公开；同名 Release 或草稿已存在时失败，不覆盖。默认权限为 `contents: read`，仅发布使用 `contents: write` 和当前 `GITHUB_TOKEN`。

## 发布前检查

创建或推送 `v<version>` 标签前：

1. 同步根目录和桌面 `package.json`、Tauri 配置、Cargo 元数据及锁文件中的产品版本，不使依赖版本跟随产品变化。CMake 读取根版本，运行编译后端的 `--version` 并与桌面元数据核对。
2. 同次更新两份 README 徽章、发布链接、产品、安装、升级与平台限制，以及 `CHANGELOG.md`。同步归属文档和受影响的已实施 Notes，审阅并登记双语文件，再通过仓库文档检查。
3. 编写 `docs/releases/v<version>.md`，`## English` 在 `## 中文` 之前，两版功能、修复、安装和限制对应。Release 正文使用该文件，未发布变化留在 Unreleased。
4. 标签提交必须通过当前全部 CI 检查，只复用验证过的同提交产物。名称、大小、摘要、耗时和验证结论来自实际产物与运行；1.3.6 公开一个 Windows x64 安装包。
5. 在 GitHub Actions 验证安装包和公开下载，本机复用缓存并查询必要元数据。完整安装与卸载、驱动加载、下载限速吞吐另行在目标机器记录。

## 本机验证

目标依赖和构建命令见[打包说明](../packaging/README.zh-CN.md#tauri-安装包)，检查及证据边界见[测试指南](TESTING.zh-CN.md#原生宿主与安装包)。测试使用隔离目录、虚构数据和普通应用、后端权限。更新验证覆盖两次确认、长度和 SHA-256 复查、已验证缓存复用、未保存修改、保存失败与安装交接恢复。Linux 仍通过官方版本页手动更新。

共享规则与 Notes、私人状态排除及本机诊断处理由[开发流程](DEVELOPMENT.zh-CN.md#共享规则与私人状态)维护。构建安装包或运行解包后的应用，不代表完成安装与卸载验收。
