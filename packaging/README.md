# 多架构打包

## Tauri 安装包

从仓库根目录运行，版本由 package metadata 读取。Windows x64、x86、ARM64 使用对应架构的 Node.js、Rust MSVC 工具链、CMake 和 C++20 编译器；Linux x64、ARM64 使用本机工具链及 WebKitGTK 4.1。完整发布矩阵见[平台说明](../docs/PACKAGING-MATRIX.md)。

```powershell
npm ci --prefix apps/desktop --ignore-scripts
npm run dist:windows
```

Windows 默认只生成 NSIS 安装程序，Linux 默认生成 deb、rpm、AppImage。便携 ZIP 已取消。内部 SHA-256 清单仍用于构建及 CI 验证，不作为 Release 附件。

```text
dist/windows/WiFiMeter-1.3.2-windows-x64-Tauri-Setup.exe
```

Tauri 使用系统 WebView，随包提供 Node 业务进程和 C++ 采集器。Windows 安装版在缺少 WebView2 时下载运行时，Linux 使用系统 WebKitGTK 4.1。用户数据目录沿用原版。

未设置 `WIFIMETER_NODE_EXECUTABLE` 时，打包使用当前 Node.js。正式 CI 使用 `actions/setup-node` 提供的 Node.js 22.23.3 官方二进制，目标架构与 Node.js、Rust 和 C++ 采集器必须一致。[lean-node-check.cjs](tauri/lean-node-check.cjs) 验证运行时需要的功能和架构，发行包同时保留对应的 Node.js 许可证。

此前的 [lean-node.cjs](tauri/lean-node.cjs) 与 [node-size.props](tauri/windows/node-size.props) 保留为历史构建工具，当前 CI 不再从源码裁剪 Node.js。后续不增加安装包体积实验或运行时裁剪任务，优先复用缓存、保持功能和减少本机下载。NSIS 使用 64 MiB LZMA 字典。Linux RPM 使用 XZ 压缩，AppImage 使用官方插件支持的 ZSTD，deb 沿用 Tauri 的压缩配置。

本机复现 CI 发行配置时，在仓库根目录执行以下命令。当前 Node.js 架构须与目标一致。Windows 还需 Python 3、完整 7-Zip 和 Visual Studio C++ 工具链；原生校验需 WebView2 Runtime。

```powershell
$nodeArch = node -p 'process.arch'
$rustTarget = @{ x64 = 'x86_64-pc-windows-msvc'; ia32 = 'i686-pc-windows-msvc'; arm64 = 'aarch64-pc-windows-msvc' }[$nodeArch]
rustup target add $rustTarget
if ($LASTEXITCODE) { throw 'Rust target installation failed' }
node packaging/tauri/lean-node-check.cjs
if ($LASTEXITCODE) { throw 'Official Node runtime validation failed' }
node -e "require('./packaging/tauri/prepare.cjs').nodeLicense(); require('./packaging/tauri/verify-windows.cjs').sevenZipExecutable()"
if ($LASTEXITCODE) { throw 'Node license or 7-Zip lookup failed' }
node packaging/tauri/build.cjs --platform win32 --arch $nodeArch --target $rustTarget --formats nsis
if ($LASTEXITCODE) { throw 'Tauri build failed' }
node packaging/tauri/verify-windows.cjs --arch $nodeArch --target $rustTarget
```

明确指定目标架构时，Node.js 必须是该架构，Rust target 必须对应：

```powershell
node packaging/tauri/build.cjs --platform win32 --arch ia32 --target i686-pc-windows-msvc --formats nsis
```

Linux 在对应架构主机执行，先安装 [tauri-linux-deps.sh](../.github/workflows/scripts/tauri-linux-deps.sh) 中所列系统依赖：

```bash
set -euo pipefail
node_arch=$(node -p 'process.arch')
node packaging/tauri/lean-node-check.cjs
export WIFIMETER_NODE_LICENSE=$(node -p "require('./packaging/tauri/prepare.cjs').nodeLicense({ license: require('node:path').resolve(require('node:path').dirname(process.execPath), '..', 'LICENSE') })")
npm run dist:linux
cargo install tauri-driver --version 2.0.5 --locked
node packaging/tauri/verify-linux.cjs --arch "$node_arch"
```

Windows 包解包后校验所有运行资源，启动真实 WebView2 与随包后端。Linux 对三个格式分别解包校验并运行真实 WebKitGTK。当前安装方法与限制见[发布说明](../docs/releases/v1.3.2.md)，检查结果以对应提交的 CI 记录为准。

RPM 先检查包摘要，再使用 `libarchive-tools` 提供的 `bsdtar` 严格解包，兼容 Tauri 打包库未写入归档长度字段的包。任何摘要、解包、资源或原生界面检查失败都会阻止发布。

## 测试与发布

共享桌面业务位于 apps/desktop/host，Tauri 适配位于 apps/desktop/tauri。开发态页面回归使用无头浏览器与真实页面桥接，并在隔离目录运行 Node 业务与 C++ 后端。测试替身负责窗口、对话框和系统设置，不启动 Electron。五个平台的真实采集、Rust 和包内 WebView 验证仍为发布必要检查，完整流程见[CI 与发布矩阵](../docs/PACKAGING-MATRIX.md)。

本机优先复用现有浏览器、依赖和构建缓存；测试截图、日志及临时数据写入项目 del，归档时只移动文件。性能比较使用同一测试范围和实际 CI 耗时，不把开发态浏览器结果描述为原生 WebView 验收。

## 图标来源与核对

正式 logo 为 docs/assets/logo.svg，桌面 SVG、PNG 和 Windows ICO 由 node packaging/generate-icons.cjs 生成。窗口、托盘与安装包使用同一套资源。Windows ICO 包含 16、24、32、48、64、128、256 px 七种尺寸，保留透明圆角。

图标检查验证实际 ICO 图像、SVG 对应关系及 Tauri 安装图标配置。在已安装 Microsoft Edge 的 Windows 环境可运行：

```powershell
$env:PLAYWRIGHT_CHANNEL = 'msedge'
node --test packaging/icons.test.cjs
```

已安装 Playwright Chromium 时可以省略环境变量。发布时仍须检查最终 PE 图标与对应安装包资源。历史 Electron 构建入口已归档，已发布版本的说明继续保存对应历史事实。
