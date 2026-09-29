# 通用支撑：目前是 JSON 值类型、解析与序列化。
add_library(wifimeter-support STATIC
    json.cpp
)

target_include_directories(wifimeter-support PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(wifimeter-support PRIVATE wifimeter-warnings)
