# Linux 环境打包

三个入口均在 Linux 中运行，使用 Tauri + Rust 桌面壳及 C++ 采集后端：

```bash
node packaging/build-windows.cjs  # Windows x64：NSIS 安装包 + 便携 ZIP
node packaging/build-linux.cjs    # 当前 Linux 架构：deb
node packaging/build-all.cjs      # 依次构建 Windows 和 Linux，任一失败即停止
```

可从任意工作目录调用脚本。默认输出到仓库 `dist/windows/` 与 `dist/linux/`；Windows 交叉构建要求 Linux x64，Linux 不跨 CPU 架构。Linux arm64 的入口已提供，但尚未实机验证。

## 编译依赖

需要 Node.js、npm、Rust stable（cargo/rustup）、CMake 和 C/C++ 工具链。Debian / Ubuntu 的系统依赖示例：

```bash
sudo apt install build-essential cmake pkg-config clang llvm \
  libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev libsqlite3-dev libbpf-dev libelf-dev zlib1g-dev \
  gcc-mingw-w64-x86-64 nsis zip dpkg-dev patchelf
rustup target add x86_64-pc-windows-gnu
npm ci --prefix apps/desktop
```

Windows C++ 后端沿用校验下载的 Zig 工具链；Rust 使用 MinGW 链接器，默认 `x86_64-w64-mingw32-gcc`，可设置 `CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER`。NSIS 在 Linux 上生成安装器，不需要 Wine 或 Windows 来完成打包。首次构建需要联网下载 Rust 依赖、Zig 和 Tauri 安装器工具，缓存位于 `.cross-build/` 和 Cargo / Tauri 的构建缓存目录。

同时构建两端需要安装上述 GTK / WebKit / 托盘开发依赖；当前 Tauri CLI 在 Linux 上生成 Windows 安装器时也会查询托盘库。Linux eBPF 采集程序要求支持 BPF 的 clang 和 libbpf >= 1.0，随包静态链接 libbpf。

## 参数和产物

```bash
node packaging/build-windows.cjs --formats nsis
node packaging/build-windows.cjs --formats portable,dir
node packaging/build-linux.cjs --formats deb,dir
node packaging/build-linux.cjs --formats rpm,AppImage
node packaging/build-all.cjs --arch x64 --skip-rebuild
```

`--skip-rebuild` 仅跳过 C++ 后端编译；仍构建当前 Rust / 前端代码，并检查已有两个采集程序的系统和架构。两端一起打包通常不传 `--formats`，以采用各自默认格式；`--formats dir` 可只输出两端运行目录。

| 目标 | 产物 |
| --- | --- |
| Windows 安装器 | `WiFiMeter-<版本>-windows-x64-Setup.exe` |
| Windows 便携包 | `WiFiMeter-<版本>-windows-x64-Portable.zip` |
| Windows 运行目录 | `dist/windows/win-unpacked/` |
| Linux 安装包 | `WiFiMeter-<版本>-linux-<架构>.deb`、`.rpm`、`.AppImage` |
| Linux 运行目录 | `dist/linux/linux-unpacked/bin/wifimeter` |

便携包改为 ZIP：完整解压并保留目录位置后启动 `WiFiMeter.exe`；开机启动使用这个固定路径。数据仍保存在原有用户配置目录。不要只复制主程序，它还需要同目录的采集程序和 `WebView2Loader.dll`。

Windows 安装器包含中文和英文界面，允许选择安装目录及当前用户 / 所有用户安装。升级先检查所选目录内的旧实例：旧采集器完成保存并退出才继续；正在运行的桌面应用需先正常退出。不会强制终止其他目录的 WiFiMeter。系统已有 WebView2 时复用；未安装时安装器联网获取，因此离线机器需预装 WebView2。

Linux 包安装主程序到 `/usr/bin/wifimeter`，资源到 `/usr/lib/WiFiMeter/`。deb 声明替代原有 `wifimeter-linux` 包，用户数据不在安装目录中。运行目录使用相同的 `bin/`、`lib/` 布局，可直接启动测试。

Linux 兼容范围取决于编译系统：deb 使用 `dpkg-shlibdeps` 根据实际二进制写入 libc / libstdc++ 等最低版本。应在最老的受支持发行版中构建；本机 Debian 13 产物不能视为 Ubuntu 22.04 兼容包。rpm / AppImage 的生成入口仍需各自验收，不能仅凭编译成功声称发行版兼容。

## 验证与体积

```bash
node apps/desktop/tests/tauri-packaging.test.js
node apps/desktop/tests/tauri-assets.test.js
```

资源检查包括主程序、两个采集程序、Windows WebView2 加载器的架构，以及 Linux eBPF 对象。发布包运行验证须清除 `WIFIMETER_BACKEND` 覆盖，确认应用确实使用随包后端。

2026-10-03 在 Linux x64 上构建并测试的 1.2.2 发布产物：

| 平台 | 安装包 | 便携包 | 运行文件合计 |
| --- | --- | --- | --- |
| Windows x64 | NSIS **3.45 MiB**（3,613,388 字节） | ZIP **4.55 MiB** | **9.80 MiB** |
| Linux x64 | deb **4.77 MiB**（5,005,108 字节） | — | **11.11 MiB** |

以上不包含共享 WebView2 或系统 GTK / WebKit 依赖。最终 ZIP、deb 解包后已通过真实系统 WebView 测试，使用的是随包采集器。安装、升级、卸载仍需人工验收；完整验证范围见[构建矩阵](../docs/PACKAGING-MATRIX.md)。

## 运行内存

在目标系统的图形会话运行以下脚本；默认使用 `dist/` 中的发布运行目录，也可通过 `WIFIMETER_EXECUTABLE` 指定。夹具初始化使用 `WIFIMETER_BACKEND` 或开发后端路径，被测应用启动时会清除此覆盖以使用随包后端。

```bash
node packaging/measure-runtime.mjs
```

脚本使用隔离配置、一个网络累计 3.6 GB 流量的测试数据、可见主窗口和关闭的浮窗；启动 10 秒后间隔 2 秒采样三次。结果包含宿主、系统 WebView 及采集后端的完整进程树，不连接 WebDriver/CDP，写入 `artifacts/runtime-<平台>.json`。

| 本地环境 | 三次采样范围 |
| --- | --- |
| Windows / WebView2 | 工作集求和 **396–397 MiB**；私有提交 **202–203 MiB** |
| Linux / WSLg X11 / WebKitGTK | PSS **412.5–413.1 MiB**；RSS 求和 **634–635 MiB**；私有物理内存 **263–264 MiB** |

Linux 本次通过本地运行库包装程序启动，数字含其约 0.8 MiB PSS。RSS / 工作集求和会重复计算共享页，PSS 按比例分摊共享页；Windows 私有提交也不是物理内存。这些口径不能跨系统直接比较，WSLg 结果也不代表所有 Linux 桌面。旧 Electron 约 391 MiB 的测试使用隐藏窗口且未计入采集器，条件不同；当前能确认安装包明显缩小，不能据此认定运行内存下降。
