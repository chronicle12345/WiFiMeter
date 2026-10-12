# Third-party sources

English | [简体中文](README.zh-CN.md)

This directory contains only third-party code that must be distributed with the sources. It is kept unchanged, without local modifications. Other dependencies still use system package managers; see the build instructions in the [root README](../../README.md).

## sqlite/

Official SQLite amalgamation, version **3.50.4** (2025-07-30).

The Windows backend uses this pinned amalgamation, distributed with the project sources, to make builds reproducible and avoid downloading SQLite during the build. Linux uses the system `libsqlite3` by default and can explicitly select the bundled version.

- Source: <https://www.sqlite.org/download.html> (`sqlite-amalgamation-3500400.zip`)
- Contents: `sqlite3.c`, `sqlite3.h`, `sqlite3ext.h`
- License: SQLite is in the public domain; see the declaration at the start of its sources.
- Updating: download a new archive, replace these three files, and update `sqlite/CMakeLists.txt` and the version in this section.

Linux builds still use the system library by default. To distribute bundled SQLite, use `-DWIFIMETER_BUNDLED_SQLITE=ON` to select this amalgamation.

The Linux eBPF program in [app_capture.bpf.c](../platform/linux/app_capture.bpf.c) is licensed under GPL-2.0-only. Its license text is in [COPYING.BPF](../platform/linux/COPYING.BPF) and is included with the distributed BPF object. The desktop application and the userspace loader retain their own licenses; libbpf is distributed under its BSD-2-Clause option.
