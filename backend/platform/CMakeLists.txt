# 与平台无关的接口实现：目前是频段分类与标签。
add_library(wifimeter-platform STATIC network_platform.cpp)

target_include_directories(wifimeter-platform PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_options(wifimeter-platform PRIVATE -Wall -Wextra -Wpedantic)
