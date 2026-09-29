cmake_minimum_required(VERSION 3.16)

project(wifimeter-backend LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Debug CACHE STRING "构建类型" FORCE)
endif()

enable_testing()

# 目标系统为 Windows 但构建主机不是 Windows（例如在 Linux 上用 MinGW 交叉编译）时，
# 生成的 .exe 无法在本机直接运行：此时默认只构建后端程序，测试目标交给
# packaging/windows 的交叉编译脚本用 Wine 执行（-DWIFIMETER_BUILD_TESTS=ON 可强制打开）。
if(CMAKE_SYSTEM_NAME STREQUAL "Windows" AND NOT CMAKE_HOST_SYSTEM_NAME STREQUAL "Windows")
    set(WIFIMETER_CROSS_COMPILING ON)
    set(WIFIMETER_TEST_DEFAULT OFF)
    message(STATUS "交叉编译到 Windows：默认不构建测试目标，可用 -DWIFIMETER_BUILD_TESTS=ON 打开。")
else()
    set(WIFIMETER_CROSS_COMPILING OFF)
    set(WIFIMETER_TEST_DEFAULT ON)
endif()

option(WIFIMETER_BUILD_TESTS "构建测试目标" ${WIFIMETER_TEST_DEFAULT})

# 共用接口实现与业务规则，与操作系统无关。
add_subdirectory(support)
add_subdirectory(platform)
add_subdirectory(core)
add_subdirectory(storage)
add_subdirectory(ipc)

# Windows 实现中不调用系统接口的部分：文本转换、接口计数与 WLAN 状态转换。
# 它们在任何平台上都能构建与测试，因此不放在下面的系统分支里。
add_subdirectory(platform/windows)

# 平台实现按系统增量添加：只有真正实现时才创建对应目标，不预建空目录或空目标。
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    add_subdirectory(platform/linux)
elseif(CMAKE_SYSTEM_NAME STREQUAL "Windows")
    add_subdirectory(platform/win32)
else()
    message(STATUS "当前只提供 Linux 与 Windows 平台实现，未生成平台相关目标。")
endif()

if(WIFIMETER_BUILD_TESTS)
    add_subdirectory(tests)
endif()

# 可执行程序在两种平台上都要产出：交叉编译时它就是安装包里随包分发的后端。
add_subdirectory(app)
