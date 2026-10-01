# 第三方源码

本目录只放**必须随源码一起分发**的第三方代码，并且保持原样、不加本地修改。
其他依赖仍走系统包管理器（见根目录 README 的构建说明）。

## sqlite/

SQLite 官方合并源码（amalgamation），版本 **3.50.4**（2025-07-30）。

为什么放进仓库：Windows 没有系统 libsqlite3，在 Linux 上交叉编译 Windows 后端时也用不了
pkg-config；把合并源码纳入版本控制后，Windows 构建与 Linux 开发机构建的 SQLite 版本完全一致，
且不需要联网即可复现。

- 来源：<https://www.sqlite.org/download.html>（`sqlite-amalgamation-3500400.zip`）
- 内容：`sqlite3.c`、`sqlite3.h`、`sqlite3ext.h`
- 许可：SQLite 处于公有领域（public domain），见源码开头的声明
- 更新方式：下载新版压缩包，覆盖上述三个文件，并同步更新 `sqlite/CMakeLists.txt`
  与本节中的版本号

Linux 构建默认仍使用系统库；需要随包分发 SQLite 时用 `-DWIFIMETER_BUNDLED_SQLITE=ON`
改用这里的合并源码。

The Linux eBPF program in [app_capture.bpf.c](../platform/linux/app_capture.bpf.c) is licensed under GPL-2.0-only. Its license text is in [COPYING.BPF](../platform/linux/COPYING.BPF) and is included with the distributed BPF object. The desktop application and the userspace loader retain their own licenses; libbpf is distributed under its BSD-2-Clause option.
