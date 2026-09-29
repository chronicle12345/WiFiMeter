# Windows 平台实现：目前包含文本转换、接口计数、WLAN 状态转换与采样编排。
#
# 这些源文件都不直接调用 Win32 API（系统调用在 wlanapi_query.* 中，那里只在 Windows 目标下构建），
# 因此可以在 Linux 上原生构建并运行单元测试，只有交叉编译整个后端时才面向 Windows。
add_library(wifimeter-platform-windows STATIC
    text_convert.cpp
    interface_counters.cpp
    wlan.cpp
    system_api.cpp
    windows_network_platform.cpp
)

# 共用接口 network_platform.h 位于上一级 platform/ 目录。
target_include_directories(wifimeter-platform-windows PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/..)
target_link_libraries(wifimeter-platform-windows PUBLIC wifimeter-platform)
target_link_libraries(wifimeter-platform-windows PRIVATE wifimeter-warnings)
