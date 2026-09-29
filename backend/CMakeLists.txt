cmake_minimum_required(VERSION 3.16)

project(wifimeter-backend LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Debug CACHE STRING "构建类型" FORCE)
endif()

enable_testing()

# 共用接口实现与业务规则，与操作系统无关。
add_subdirectory(support)
add_subdirectory(platform)
add_subdirectory(core)
add_subdirectory(storage)
add_subdirectory(ipc)

# 平台实现按系统增量添加：只有真正实现时才创建对应目标，不预建空目录或空目标。
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    add_subdirectory(platform/linux)
    add_subdirectory(app)
    add_subdirectory(tests)
else()
    message(STATUS "当前只提供 Linux 平台实现，未生成平台相关目标。")
endif()
