# Linux 打包

从仓库根目录执行 `npm run dist:linux`。需要 Ubuntu x64、桌面应用的 npm 依赖和系统命令 `dpkg-deb`。

流程：确保 Electron 已下载 → electron-builder 组装应用目录 → 本目录的 `build-deb.mjs` 封装 deb。复用应用目录中的 Electron，不额外下载 fpm 打包器。

输出目录为根目录 `dist/linux/`，包含 `linux-unpacked/` 和 `WiFiMeter-<版本>-linux-amd64.deb`。脚本从自身位置定位仓库，不依赖调用者的工作目录。

deb 安装到 `/opt/WiFiMeter/`，同时提供命令入口、桌面菜单和图标。构建命令只生成文件，不安装到系统。
