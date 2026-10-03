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

2026-10-03 在 Linux x64 上生成的 Windows Tauri NSIS 包约 **3.45 MiB**，解压运行文件约 **9.9 MiB**；这不包含目标机共享的 WebView2 安装体积。Linux deb 约 **4.77 MiB**，系统 GTK / WebKit 等依赖单独安装。两端运行目录已通过真实 WebView 的发布构建测试；安装、升级及无调试连接的内存测量仍待验收。此前 Electron 的约 104 MB 安装包、约 391 MiB 工作集求和属于旧架构基准，不代表 Tauri。
