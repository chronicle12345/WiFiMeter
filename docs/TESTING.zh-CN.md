# 测试与验证

[English](TESTING.md) | 简体中文

本文维护验证入口及其限制。npm 命令均从仓库根目录运行，定义见 [package.json](../package.json)。[开发流程](DEVELOPMENT.zh-CN.md)说明何时更新规则、指南和 Notes；[CI 与发布矩阵](PACKAGING-MATRIX.zh-CN.md)规定当前发布要求。

## 准备与入口

安装 Node.js，通过 `npm ci --prefix apps/desktop` 安装锁定的桌面依赖。后端夹具需要匹配的本机 C++ 工具链和 CMake；原生宿主和安装包还需要 Rust 及 [Tauri 平台依赖](https://v2.tauri.app/start/prerequisites/)。各平台依赖见[打包说明](../packaging/README.zh-CN.md)。桌面测试需要运行真实后端进程时，先构建后端。

| 命令 | 覆盖范围与条件 |
| --- | --- |
| `npm test` | 先运行桌面 JavaScript 单元及集成测试，再运行 Playwright；不包含 CTest、Rust、打包、CI 辅助脚本和文档检查 |
| `npm run test:unit` | 桌面业务宿主、桥接、存储和使用夹具的集成测试 |
| `npm run test:ui -- <Playwright options>` | 通过真实页面桥接和隔离 Node 宿主运行浏览器界面回归 |
| `npm run build:backend` | 为当前本机目标构建后端程序，不执行后端测试 |
| `npm run test:backend` | 在对应平台构建目录配置、编译后端测试并运行 CTest；处理 Windows 的 Release 配置 |
| `npm run test:packaging:tauri` | Tauri 构建、资源、安装辅助工具及发布辅助工具回归；部分用例需要对应原生平台 |
| `npm run test:ci` | 现有 CI 报告、已验证产物复用和 Linux 缓存辅助脚本回归 |
| `npm run check:docs` | 双语登记、Markdown 结构与相对链接、活跃 Notes、指令镜像及仓库文件政策 |
| `npm run docs:budget` | 显示可见正文实际用量和上限，限制由 `check:docs` 执行 |
| `npm run test:docs` | 仓库文档和政策工具的回归测试 |
| `npm run check:notes` | 活跃 Notes 的元数据、必需内容和生命周期约定 |

`npm run check:docs` 检查仓库当前状态，不更新双语登记。`npm run docs:pair -- <path> --reviewed` 登记明确完成审阅的双语文件；`npm run docs:instructions` 同步指令镜像。流程和例外见[双语文档](i18n/README.zh-CN.md)。

Windows 浏览器测试默认复用已安装的 Microsoft Edge。其他环境通过 `npm --prefix apps/desktop exec -- playwright install chromium` 安装锁定的 Playwright Chromium。CI 使用锁定的 Chromium，通过两个 Windows 分片运行全部 `*.spec.js`。[.github/workflows/scripts/ci.cjs](../.github/workflows/scripts/ci.cjs)拒绝空运行、意外跳过、失败、全局错误和不稳定重试；重试后成功不足以通过发布检查。

## 按改动范围选择验证

| 改动范围 | 相关检查 |
| --- | --- |
| 维护文档、Notes 或指令 | 审阅双语，按需同步指令镜像或双语登记，再运行 `check:docs`；编辑 Notes 时可先用 `check:notes` |
| 文档或政策检查工具 | 运行 `test:docs`，再通过 `check:docs` 检查真实仓库 |
| 桌面业务或桥接 | 运行相关 `test:unit`；可见行为或交互变化时增加 `test:ui` |
| 页面和悬浮窗 | 运行相关 Playwright 用例；系统 WebView、窗口、托盘或 IPC 行为变化时增加原生宿主检查 |
| C++ 统计、存储或协议 | 运行 `test:backend`、相关桌面集成用例及合约和兼容性检查 |
| 原生采集或网络控制 | 后端与平台测试，加上对应系统行为的目标机器实测 |
| Rust 宿主、资源或打包 | Rust 测试、`test:packaging:tauri`、目标安装包构建及包内原生 WebView 验证 |
| CI 辅助工具或工作流 | `test:ci`、相关辅助工具测试、固定版本 actionlint 及受影响平台检查 |
| 产品图标 | 配置浏览器后运行 `node --test packaging/icons.test.cjs`，并完成相关安装包和资源检查 |

针对可观察的行为和失败情况选择测试。可撤销、影响较小的修改，无需添加只重复实现逻辑的测试。相关检查通过后，只有出现新改动、失败或未解决问题时，才重复或扩大验证。记录依赖平台的跳过和缺失条件，不将其视为成功证据。

## 原生宿主与安装包

Rust 宿主测试独立于 npm 测试：

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --features custom-protocol --locked
```

明确指定目标时，使用匹配的 Rust 工具链并传入 `--target`。按[打包命令](../packaging/README.zh-CN.md#tauri-安装包)构建安装包，再运行 `node packaging/tauri/verify-windows.cjs`，或在 Linux 上运行 `node packaging/tauri/verify-linux.cjs`。这些工具解包真实安装包，检查资源和可执行文件架构，再在系统 WebView 中运行真实宿主与后端。Linux 验证需要原生驱动、显示与会话环境以及平台依赖。

浏览器夹具替代操作系统窗口、对话框和设置。包内 WebView 检查使用隔离目录和虚构采集夹具，运行真实宿主、数据库、资源及原生 WebView。两者均不能证明完整安装与卸载、实际驱动加载、额度断网或下载限速吞吐通过；这些项目需在目标机器分别验证。保留用户数据，并说明取得了哪一类证据。

真实 Windows ETW/EStats 和 Linux eBPF 检查分别见 [Windows 采集](WINDOWS_APP_CAPTURE.zh-CN.md#构建与验收)与 [Linux 采集](LINUX_APP_CAPTURE.zh-CN.md#真实内核验证)。普通 CTest 可能跳过需要系统授权的用例。CI 明确要求当前 Windows 原生检查通过，Linux 产品和浏览器任务目前暂停。夹具、跳过或历史记录不能证明当前原生采集成功。

## 隔离、诊断与证据

测试使用虚构数据、隔离安装和独立数据目录。后台检查关闭可见窗口、原生对话框和通知。需要提升权限的采集辅助进程与普通应用、后端分开运行。没有相应隔离环境时，不得针对个人数据库测试，或修改个人防火墙、额度、启动项及网络设置。

复用已有浏览器、依赖和有效构建缓存。本机截图、日志和临时数据放在忽略的 `del/` 或明确隔离的工具目录；CI 使用 `RUNNER_TEMP`。归档本机诊断时移动文件。凭据和私人网络信息不得进入夹具或公开验证记录。

记录命令、提交、平台、实际覆盖范围、失败、跳过和剩余限制。使用 [tools/performance](../tools/performance/) 时，性能比较应采用相同工作量和环境。安装包体积与耗时以当前产物和 CI 为准；浏览器或微基准测试结果不能证明整个应用的内存或启动性能。
