# SQLite 存储层。系统库 sqlite3 由 pkg-config 提供（Ubuntu: libsqlite3-dev + libsqlite3-0）。
find_package(PkgConfig REQUIRED)
pkg_check_modules(SQLITE3 REQUIRED IMPORTED_TARGET sqlite3)

add_library(wifimeter-storage STATIC
    database.cpp
    usage_repository.cpp
    network_repository.cpp
    settings_repository.cpp
    store.cpp
)

target_include_directories(wifimeter-storage PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(wifimeter-storage PUBLIC wifimeter-core PkgConfig::SQLITE3)
target_compile_options(wifimeter-storage PRIVATE -Wall -Wextra -Wpedantic)
