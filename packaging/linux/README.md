# Linux Tauri 打包

在 Linux x64 或 ARM64 主机安装对应架构的 Node.js、Rust、C++20 工具链、CMake、WebKitGTK 4.1、libbpf、libelf、SQLite、zlib、rpm、patchelf，安装桌面 npm 依赖后执行：

```bash
npm run dist:linux
node packaging/tauri/verify-linux.cjs --arch x64
```

ARM64 把验证参数改为 --arch arm64。默认生成 deb、rpm、AppImage，分别位于 dist/linux 和 dist/linux-arm64；内部校验清单不进入 Release 附件。三个格式分别解包后核对资源及架构，并在隔离配置、Xvfb 与 D-Bus 环境中运行真实 WebKitGTK 检查。CI 采用 Ubuntu 22.04 构建基线。运行仍需桌面库和内核采集能力，RPM 包管理安装及 FUSE 启动方式需目标系统验收。

详见[平台矩阵](../../docs/PACKAGING-MATRIX.md)。

## Electron 历史参考

# Linux 打包

从仓库根目录执行 `npm run dist:linux`。需要 Ubuntu x64、桌面应用的 npm 依赖和系统命令 `dpkg-deb`。

流程：确保 Electron 已下载 → electron-builder 组装应用目录 → 本目录的 `build-deb.mjs` 封装 deb。复用应用目录中的 Electron，不额外下载 fpm 打包器。

输出目录为根目录 `dist/linux/`，包含 `linux-unpacked/` 和 `WiFiMeter-<版本>-linux-amd64.deb`。脚本从自身位置定位仓库，不依赖调用者的工作目录。

deb 安装到 `/opt/WiFiMeter/`，同时提供命令入口、桌面菜单和图标。构建命令只生成文件，不安装到系统。

## 多架构入口

从根目录执行 `node packaging/linux/build.cjs --arch x64 --formats deb,rpm,AppImage`，ARM64 主机可执行 `node packaging/linux/build.cjs --arch arm64 --formats deb`。新增入口包含后端编译和打包前后架构检查。原 npm 脚本保留给既有 x64 流程。

工具链、输出目录、系统依赖和未验证项目见 [打包总说明](../README.md)。
