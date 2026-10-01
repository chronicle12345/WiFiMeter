#!/bin/sh
# zig 包装脚本：把 CMake 的编译器调用转成 `zig c++ -target <三元组>`。
#
# 为什么需要它：CMake 的 CMAKE_<LANG>_COMPILER_ARG1 只能传一个参数，
# 而交叉编译需要同时传子命令与目标三元组，只有包装脚本能表达。
# 由 build-backend.mjs / 手工验证时生成到构建目录，不提交。

exec "${WIFIMETER_ZIG:?请先设置 WIFIMETER_ZIG 指向 zig 可执行文件}" c++ -target x86_64-windows-gnu "$@"
