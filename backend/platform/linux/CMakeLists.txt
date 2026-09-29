add_library(wifimeter-platform-linux STATIC
    text_file.cpp
    proc_net_dev.cpp
    sysfs_net.cpp
    nmcli.cpp
    wifi_control.cpp
    linux_network_platform.cpp
)

# 共用接口 network_platform.h 位于上一级 platform/ 目录，实现与标签在 wifimeter-platform 中。
target_include_directories(wifimeter-platform-linux PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/..)
target_link_libraries(wifimeter-platform-linux PUBLIC wifimeter-platform)
target_compile_options(wifimeter-platform-linux PRIVATE -Wall -Wextra -Wpedantic)
