# SQLite 存储层。
#
# SQLite 的来源按平台选择：
#
#   * Windows（含在 Linux 上交叉编译）：使用 backend/third_party/sqlite 的合并源码，
#     因为 Windows 没有系统 libsqlite3，交叉编译时也用不了 pkg-config；
#   * Linux：默认仍用系统库（Ubuntu: libsqlite3-dev + libsqlite3-0），
#     这样开发机上的构建与发行版安全更新保持一致。
#
# 也可以显式指定 -DWIFIMETER_BUNDLED_SQLITE=ON/OFF 强制其中一种：
# 打包 Linux 时用得上（随包分发可以避免用户没装 libsqlite3-0）。

option(WIFIMETER_BUNDLED_SQLITE "使用仓库内置的 SQLite 合并源码" OFF)

if(CMAKE_SYSTEM_NAME STREQUAL "Windows")
    set(WIFIMETER_USE_BUNDLED_SQLITE ON)
elseif(WIFIMETER_BUNDLED_SQLITE)
    set(WIFIMETER_USE_BUNDLED_SQLITE ON)
else()
    set(WIFIMETER_USE_BUNDLED_SQLITE OFF)
endif()

add_library(wifimeter-storage STATIC
    database.cpp
    usage_repository.cpp
    network_repository.cpp
    settings_repository.cpp
    store.cpp
    total_quota.cpp
)

target_include_directories(wifimeter-storage PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(wifimeter-storage PUBLIC wifimeter-core wifimeter-support)
target_link_libraries(wifimeter-storage PRIVATE wifimeter-warnings)

if(WIFIMETER_USE_BUNDLED_SQLITE)
    message(STATUS "存储层使用仓库内置的 SQLite 合并源码。")
    add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../third_party/sqlite ${CMAKE_CURRENT_BINARY_DIR}/sqlite)
    target_link_libraries(wifimeter-storage PUBLIC wifimeter-sqlite3)
else()
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(SQLITE3 REQUIRED IMPORTED_TARGET sqlite3)
    message(STATUS "存储层使用系统 SQLite：${SQLITE3_VERSION}")
    target_link_libraries(wifimeter-storage PUBLIC PkgConfig::SQLITE3)
endif()
