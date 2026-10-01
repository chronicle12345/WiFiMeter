# 与平台无关的业务规则：字节计数、本地日历、网络键、用量累计与额度。
add_library(wifimeter-core STATIC
    byte_count.cpp
    local_time.cpp
    network_key.cpp
    usage_accumulator.cpp
    app_usage_accumulator.cpp
    quota.cpp
)

target_include_directories(wifimeter-core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(wifimeter-core PUBLIC wifimeter-platform)
target_link_libraries(wifimeter-core PRIVATE wifimeter-warnings)
