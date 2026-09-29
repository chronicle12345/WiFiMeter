# SQLite 合并源码（amalgamation）：Windows 上没有系统 libsqlite3，
# 交叉编译时也无法使用 pkg-config，因此把官方合并源码放进仓库。
#
# 版本：SQLite 3.50.4（2025-07-30）。
# 更新方式：从 https://www.sqlite.org/download.html 下载对应版本的
# sqlite-amalgamation-<版本号>.zip，把 sqlite3.c、sqlite3.h、sqlite3ext.h
# 覆盖到本目录，并同步更新本注释与 third_party/README.md 中的版本号。
#
# 编译选项说明：
#   * THREADSAFE=1 使用 SQLite 自己的互斥实现：不依赖 pthread，Linux 与 Windows 行为一致；
#   * 关闭列元数据与扩展结果码等本项目用不到的编译开关，减小体积；
#   * 不使用扩展加载，避免引入动态库加载路径相关的差异化行为。

add_library(wifimeter-sqlite3 STATIC sqlite3.c)

target_include_directories(wifimeter-sqlite3 PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})

target_compile_definitions(wifimeter-sqlite3 PRIVATE
    SQLITE_THREADSAFE=1
    SQLITE_OMIT_LOAD_EXTENSION
    SQLITE_OMIT_DEPRECATED
    SQLITE_DQS=0
    SQLITE_DEFAULT_MEMSTATUS=0
    SQLITE_DEFAULT_FOREIGN_KEYS=1
    SQLITE_LIKE_DOESNT_MATCH_BLOBS
    SQLITE_OMIT_PROGRESS_CALLBACK
    SQLITE_OMIT_SHARED_CACHE
    SQLITE_USE_URI=1
)

if(MSVC)
    # 官方合并源码在 MSVC 下会有大量无害告警，静音以免淹没真正的问题。
    target_compile_options(wifimeter-sqlite3 PRIVATE /w)
else()
    # Win32 部分包含第三方代码，不参与本项目的告警标准。
    target_compile_options(wifimeter-sqlite3 PRIVATE -w)
endif()
