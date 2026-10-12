# 第三方源码

[English](README.md) | 简体中文

本目录只放必须随源码一起分发的第三方代码，并且保持原样、不加本地修改。其他依赖仍走系统包管理器，见[根目录 README](../../README.zh-CN.md) 的构建说明。

## sqlite/

SQLite 官方合并源码（amalgamation），版本 **3.50.4**（2025-07-30）。

Windows 后端使用随项目源码提供的固定版本合并源码，便于复现构建，并避免在构建时下载 SQLite。Linux 默认使用系统 `libsqlite3`，也可显式选择随项目提供的版本。

- 来源：<https://www.sqlite.org/download.html>（`sqlite-amalgamation-3500400.zip`）
- 内容：`sqlite3.c`、`sqlite3.h`、`sqlite3ext.h`
- 许可：SQLite 处于公有领域（public domain），见源码开头的声明。
- 更新方式：下载新版压缩包，覆盖上述三个文件，并同步更新 `sqlite/CMakeLists.txt` 与本节中的版本号。

Linux 构建默认仍使用系统库；需要随包分发 SQLite 时用 `-DWIFIMETER_BUNDLED_SQLITE=ON` 改用这里的合并源码。

Linux eBPF 程序 [app_capture.bpf.c](../platform/linux/app_capture.bpf.c) 采用 GPL-2.0-only 许可证。许可原文保存在 [COPYING.BPF](../platform/linux/COPYING.BPF)，并随发布的 BPF 对象一同分发。桌面应用与用户态加载器仍使用各自的许可证；libbpf 按其 BSD-2-Clause 许可选项分发。
