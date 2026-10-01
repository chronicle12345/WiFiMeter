# 与平台无关的部分：频段分类、采样编排、以及测试用的假数据源。
#
# 采样编排（sampling.cpp）放在这里是有意的：时序只有一份，Linux 与 Windows 都调用它，
# 任何一侧改了“采样前后各确认一次身份”的做法，另一侧的测试会一起失败。
add_library(wifimeter-platform STATIC
    network_platform.cpp
    sampling.cpp
    counter_source.cpp
    fake_source.cpp
    app_traffic.cpp
    fake_app_traffic.cpp
)

# 假数据源依赖 JSON 解析，因此这里公开 support。
target_link_libraries(wifimeter-platform PUBLIC wifimeter-support)
target_include_directories(wifimeter-platform PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(wifimeter-platform PRIVATE wifimeter-warnings)

# sysfs 枚举只依赖标准文件 API，可用伪目录在两个平台验证。
if(WIFIMETER_BUILD_TESTS)
    add_executable(ethernet_sysfs_test
        ../tests/ethernet_sysfs_test.cpp
        linux/sysfs_net.cpp
        linux/text_file.cpp)
    target_link_libraries(ethernet_sysfs_test PRIVATE wifimeter-platform wifimeter-warnings)
    if(NOT WIFIMETER_CROSS_COMPILING)
        add_test(NAME ethernet_sysfs_test COMMAND ethernet_sysfs_test)
    endif()
endif()

# 本地代理归属观测：纯函数跨平台可测，系统查询仅在 Windows 启用。
target_sources(wifimeter-platform PRIVATE proxy_attribution.cpp)
if(CMAKE_SYSTEM_NAME STREQUAL "Windows")
    target_link_libraries(wifimeter-platform PUBLIC iphlpapi ws2_32)
    target_compile_definitions(wifimeter-platform PRIVATE $<$<CXX_COMPILER_ID:MSVC>:_WIN32_WINNT=0x0A00>)
endif()
