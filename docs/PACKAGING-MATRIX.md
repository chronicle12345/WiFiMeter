# 构建与验证矩阵

所有 Tauri 发布包都在 Linux 上构建。Windows runner 只负责运行 Linux 交叉编译的程序与测试，不负责打包。

| 目标 | 构建环境 | 默认产物 | 验证方式 |
| --- | --- | --- | --- |
| Windows x64 | Linux x64，Zig + MinGW + NSIS | 安装 EXE、便携 ZIP | Windows 原生 Rust/C++ 测试、WebView2 及 ZIP 解包测试 |
| Linux x64 | 同架构 Linux | deb | Rust/C++、浏览器、WebKitGTK 及 deb 解包测试 |
| Linux arm64 | 同架构 Linux | deb | CI 在原生 ARM64 runner 执行同一套检查；本地未实机验收 |

Windows ARM64/x86 不属于当前 Linux 交叉工具链支持范围。Linux rpm/AppImage 参数保留，尚不作为已验收发布产物。

## 本地验证与限制

2026-10-03 本地已构建并运行 Windows x64 和 Linux x64 Tauri，验证页面、真实 SQLite 后端、双语宿主弹窗、浮窗、更新恢复以及最终 ZIP/deb 的资源发现。Windows 最新一轮明确跳过原生拖拽、贴边及悬停：当前输入桌面拒绝鼠标定位。安装器实际安装、升级、卸载和安装版系统通知仍需[人工验收](../packaging/windows/ACCEPTANCE.md)。

清理 Electron 后的回归结果：页面测试 86 项通过；JavaScript 单元测试 119 项通过、10 项因平台条件跳过；Rust 在 Linux 92 项、Windows 99 项通过，均包含真实后端测试；图标检查 2 项通过，打包入口和 CI 辅助脚本检查 6 项通过，actionlint 检查通过。最终发布包与无调试连接的内存采样也已运行，数字及测量条件见[打包说明](../packaging/README.md)。

本机 Linux 包基于 Debian 13，glibc/libstdc++ 最低版本由 `dpkg-shlibdeps` 写入。CI 使用 Ubuntu 24.04，不能将任一产物泛称为所有发行版可用。eBPF 实机测试还取决于内核和权限，退出 77 表示跳过，不是通过。

## CI

`.github/workflows/desktop.yml` 编排 Linux 原生测试与发布，`windows-app.yml` 先在 Linux 交叉构建，再在 Windows 测试。辅助脚本位于 `.github/scripts/`。

- npm、Cargo 均使用锁文件，Rust 工具链固定为 1.99.0，Node 为 24.19.0；Linux 系统依赖使用 Ubuntu 官方固定快照。
- 浏览器测试保留布局、语言、数据和交互回归，系统能力由真实 Tauri WebView 与 Rust 测试覆盖。
- 三组目标全部成功后才允许发布四个默认文件；版本、文件名、大小和 SHA-256 必须匹配清单。
- Windows 原生输入失败不会自动跳过；NSIS 编译成功和解包测试不等于安装验收。
- 标签需匹配桌面版本和已有发布说明。工作流先上传草稿，完整上传后再公开。

本地可运行 `node --test .github/scripts/ci.test.cjs`，工作流语法用 actionlint 检查。修改后的云端工作流尚未实际运行；本次没有推送或发布。
