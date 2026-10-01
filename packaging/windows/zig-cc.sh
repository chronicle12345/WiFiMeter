#!/bin/sh
# zig 包装脚本（C 语言）：见同目录 zig-cxx.sh 的说明。

exec "${WIFIMETER_ZIG:?请先设置 WIFIMETER_ZIG 指向 zig 可执行文件}" cc -target x86_64-windows-gnu "$@"
