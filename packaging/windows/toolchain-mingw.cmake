# 在 Linux 上交叉编译 Windows 后端时使用的 CMake 工具链文件。
#
# 目标是 MinGW 兼容的 x86_64-windows-gnu，默认用 Zig 自带的 clang 作为编译器
# （zig cc / zig c++ 按目标平台选择头文件与运行库），因此不需要安装 mingw-w64。
#
# 编译器通过环境变量传入，而不是 -D 缓存变量：工具链文件在 project() 之前执行，
# 而 try_compile 会派生子项目，子项目的缓存不继承父项目，只有环境变量与方法无关地传下去。
#
#   WIFIMETER_ZIG=/path/to/zig            使用 zig cc / zig c++
#   WIFIMETER_ZIG_CACHE_DIR=/path         指定 zig 的缓存目录（HOME 只读时必须给）
#
# 也可以不设置任何变量，此时按 x86_64-w64-mingw32-g++ 查找系统 MinGW。

set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

if(NOT CMAKE_C_COMPILER)
    if(DEFINED ENV{WIFIMETER_ZIG_CC})
        set(CMAKE_C_COMPILER "$ENV{WIFIMETER_ZIG_CC}")
    elseif(DEFINED ENV{WIFIMETER_ZIG})
        set(CMAKE_C_COMPILER "$ENV{WIFIMETER_ZIG}")
        set(CMAKE_C_COMPILER_ARG1 "cc" "-target" "x86_64-windows-gnu")
    else()
        find_program(WIFIMETER_MINGW_CC NAMES x86_64-w64-mingw32-gcc)
        if(WIFIMETER_MINGW_CC)
            set(CMAKE_C_COMPILER "${WIFIMETER_MINGW_CC}")
        endif()
    endif()
endif()

if(NOT CMAKE_CXX_COMPILER)
    if(DEFINED ENV{WIFIMETER_ZIG_CXX})
        set(CMAKE_CXX_COMPILER "$ENV{WIFIMETER_ZIG_CXX}")
    elseif(DEFINED ENV{WIFIMETER_ZIG})
        set(CMAKE_CXX_COMPILER "$ENV{WIFIMETER_ZIG}")
        set(CMAKE_CXX_COMPILER_ARG1 "c++" "-target" "x86_64-windows-gnu")
    else()
        find_program(WIFIMETER_MINGW_CXX NAMES x86_64-w64-mingw32-g++)
        if(WIFIMETER_MINGW_CXX)
            set(CMAKE_CXX_COMPILER "${WIFIMETER_MINGW_CXX}")
        endif()
    endif()
endif()

if(NOT CMAKE_CXX_COMPILER)
    message(FATAL_ERROR "没有可用的 Windows C++ 交叉编译器：请设置 WIFIMETER_ZIG（zig 可执行文件路径），或安装 x86_64-w64-mingw32-g++。")
endif()

# Zig 使用自己的缓存目录；HOME 只读时（沙箱、CI 容器）必须显式指定可写位置。
if(DEFINED ENV{WIFIMETER_ZIG_CACHE_DIR})
    set(ENV{ZIG_GLOBAL_CACHE_DIR} "$ENV{WIFIMETER_ZIG_CACHE_DIR}/global")
    set(ENV{ZIG_LOCAL_CACHE_DIR} "$ENV{WIFIMETER_ZIG_CACHE_DIR}/local")
endif()

# 目标 Windows 版本不在这里定义：zig 的编译器驱动已经按目标平台给出默认值，
# 再定义一遍只会产生“宏重定义”告警。需要的目标（ipc、platform/win32、app）
# 各自用生成器表达式在“尚未定义时”补上，见各自的 CMakeLists.txt。

# 依赖一律走仓库内置源码或显式路径，不在目标系统里搜索。
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
