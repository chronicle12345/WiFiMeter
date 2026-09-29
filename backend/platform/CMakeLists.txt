# 与平台无关的部分：频段分类、采样编排、以及测试用的假数据源。
#
# 采样编排（sampling.cpp）放在这里是有意的：时序只有一份，Linux 与 Windows 都调用它，
# 任何一侧改了“采样前后各确认一次身份”的做法，另一侧的测试会一起失败。
add_library(wifimeter-platform STATIC
    network_platform.cpp
    sampling.cpp
    counter_source.cpp
    fake_source.cpp
)

# 假数据源依赖 JSON 解析，因此这里公开 support。
target_link_libraries(wifimeter-platform PUBLIC wifimeter-support)
target_include_directories(wifimeter-platform PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_options(wifimeter-platform PRIVATE -Wall -Wextra -Wpedantic)
