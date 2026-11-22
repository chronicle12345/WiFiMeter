# 构建安装包

[English](README.md) | 简体中文

## Tauri 安装包

所有命令都在仓库根目录执行，版本号从包配置中读取。1.3.8 的 CI 仅构建并发布 Windows x64。Windows x86/ARM64 和 Linux x64/ARM64 任务暂时被注释，对应的本机构建工具仍可使用。当前检查和暂停目标见[平台说明](../docs/PACKAGING-MATRIX.zh-CN.md)。

Windows 需要目标架构的 Node.js、Rust MSVC 工具链、CMake 和 C++20 编译器。Linux 需要本机工具链及 WebKitGTK 4.1。构建 Windows 安装包：

```powershell
npm ci --prefix apps/desktop --ignore-scripts
npm run dist:windows
```

Windows 默认生成 NSIS 安装程序，Linux 默认生成 deb、rpm 和 AppImage。便携 ZIP 已取消。构建和 CI 仍会校验内部 SHA-256 清单，但清单不放入 Release 附件。

```text
dist/windows/WiFiMeter-1.3.8-windows-x64-Tauri-Setup.exe
```

安装包包含 Node 业务进程和 C++ 采集器，Tauri 使用系统 WebView。Windows 缺少 WebView2 时，安装程序会下载所需运行时；Linux 使用系统 WebKitGTK 4.1。用户数据仍保存在原目录。

打包默认使用当前 Node.js，也可以用 `WIFIMETER_NODE_EXECUTABLE` 指定其他可执行文件。发布 CI 使用 `actions/setup-node` 提供的 Node.js 22.23.3 官方二进制。Node.js、Rust 和 C++ 采集器都必须与目标架构一致。[runtime-check.cjs](tauri/runtime-check.cjs) 检查 TLS、中文排序、原子文件保存、子进程和下载流。安装包还会包含对应的 Node.js 许可证。

旧运行时裁剪和交叉编译工具已归档。当前工具负责本机 Tauri 构建、包验证和安装辅助。NSIS 使用 64 MiB LZMA 字典；Linux RPM 使用 XZ，AppImage 使用官方插件支持的 ZSTD，deb 沿用 Tauri 的压缩配置。

要在本机复现 CI 发布配置，先确认 Node.js 与目标架构一致。Windows 还需要 Python 3、完整版 7-Zip 和 Visual Studio C++ 工具链；原生验证需要 WebView2 Runtime。然后执行：

```powershell
$nodeArch = node -p 'process.arch'
$rustTarget = @{ x64 = 'x86_64-pc-windows-msvc'; ia32 = 'i686-pc-windows-msvc'; arm64 = 'aarch64-pc-windows-msvc' }[$nodeArch]
rustup target add $rustTarget
if ($LASTEXITCODE) { throw 'Rust target installation failed' }
node packaging/tauri/runtime-check.cjs
if ($LASTEXITCODE) { throw 'Official Node runtime validation failed' }
node -e "require('./packaging/tauri/prepare.cjs').nodeLicense(); require('./packaging/tauri/verify-windows.cjs').sevenZipExecutable()"
if ($LASTEXITCODE) { throw 'Node license or 7-Zip lookup failed' }
node packaging/tauri/build.cjs --platform win32 --arch $nodeArch --target $rustTarget --formats nsis
if ($LASTEXITCODE) { throw 'Tauri build failed' }
node packaging/tauri/verify-windows.cjs --arch $nodeArch --target $rustTarget
```

其他架构的 CI 任务暂停期间，仍可从源码构建。指定架构时，使用对应的 Node.js 和 Rust 目标：

```powershell
node packaging/tauri/build.cjs --platform win32 --arch ia32 --target i686-pc-windows-msvc --formats nsis
```

Linux 需要在对应架构的主机上构建，先安装 [tauri-linux-deps.sh](../.github/workflows/scripts/tauri-linux-deps.sh) 中列出的系统依赖：

```bash
set -euo pipefail
node_arch=$(node -p 'process.arch')
node packaging/tauri/runtime-check.cjs
export WIFIMETER_NODE_LICENSE=$(node -p "require('./packaging/tauri/prepare.cjs').nodeLicense({ license: require('node:path').resolve(require('node:path').dirname(process.execPath), '..', 'LICENSE') })")
npm run dist:linux
cargo install tauri-driver --version 2.0.5 --locked
node packaging/tauri/verify-linux.cjs --arch "$node_arch"
```

[CI 矩阵](../docs/PACKAGING-MATRIX.zh-CN.md)列出了缓存配置及启用、暂停的目标。本机构建不依赖 CI 缓存。包验证命令和原生依赖见[测试指南](../docs/TESTING.zh-CN.md#原生宿主与安装包)，安装方法和版本限制见[发布说明](../docs/releases/v1.3.8.md#中文)。

RPM 验证先检查包摘要，再用 `libarchive-tools` 中的 `bsdtar` 解包。这样既能读取 Tauri 打包库未写入归档长度字段的包，也能严格检查解包结果。摘要、解包、资源或原生界面的任何检查失败，都会阻止发布。

安装与系统交互验证使用独立的测试安装和数据目录。检查升级、快捷方式、托盘、是否只有一项开机启动登记、设置和备份恢复，以及退出重开后的数据完整性。额度通知、真实断网和下载限速需要在目标机器上，按实际权限与网络条件测试。卸载会保留用户数据。包内 WebView 自动检查与完整安装、卸载测试应分别记录，各自提供验证结果。

## 验证与发布

检查方法、隔离目录、诊断及各项检查能验证的范围见[测试指南](../docs/TESTING.zh-CN.md)。发布要求和产物数量见 [CI 与发布矩阵](../docs/PACKAGING-MATRIX.zh-CN.md)。开发、审查和决策记录的做法见[开发流程](../docs/DEVELOPMENT.zh-CN.md)。

## 图标来源与核对

修改 `docs/assets/logo.svg` 后，运行 `node packaging/generate-icons.cjs` 生成桌面 SVG、PNG 和 Windows ICO。窗口、托盘和安装包使用同一套图标。Windows ICO 包含 16、24、32、48、64、128、256 px 七种尺寸，保留透明圆角。

图标检查会对比 ICO 图像与 SVG，并验证 Tauri 的安装图标配置。在装有 Microsoft Edge 的 Windows 上运行：

```powershell
$env:PLAYWRIGHT_CHANNEL = 'msedge'
node --test packaging/icons.test.cjs
```

如果已经安装 Playwright Chromium，可以省略环境变量。发布前还须检查最终 PE 图标和安装包资源。Electron 构建入口已归档，对应的发布说明保留各版本当时的情况。
