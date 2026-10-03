# Linux 包

在对应架构的 Linux 中运行 `./packaging/build-linux.sh`，默认生成 deb。编译依赖、格式参数及三个入口见[统一打包说明](../README.md)。

程序安装到 `/usr/bin/wifimeter`，后端与 eBPF 采集资源在 `/usr/lib/WiFiMeter/`。运行目录保持相同的 `bin/`、`lib/` 结构。GTK/WebKit 使用系统依赖，用户数据在 `$XDG_CONFIG_HOME/WiFiMeter`（默认 `~/.config/WiFiMeter`）。

deb 的运行库最低版本由实际二进制计算，须在最老的目标发行版上构建。CI 使用 Ubuntu 24.04；本机 Debian 13 产物不代表 Ubuntu 兼容性。rpm/AppImage 提供生成参数，但尚未完成发布验收。

使用 `apps/desktop/tests/e2e/smoke-linux.mjs --packaged` 验证解包程序和随包后端，具体环境变量见[桌面说明](../../apps/desktop/README.md)。
