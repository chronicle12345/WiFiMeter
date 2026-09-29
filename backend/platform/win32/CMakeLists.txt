# Windows 系统调用实现：WLAN API（状态、身份、断开）与 IP Helper（累计计数）。
#
# 这些源文件直接包含 Win32 头文件，因此只在目标系统为 Windows 时构建；
# 所有解析与判断都在 platform/windows/ 下，可以在任何平台上测试。
add_library(wifimeter-platform-win32 STATIC
    wlanapi_query.cpp
)

# 平台无关部分的头文件（system_api.h、wlan.h 等）在上一级 platform/windows/ 下。
target_include_directories(wifimeter-platform-win32 PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/../windows)
target_link_libraries(wifimeter-platform-win32 PUBLIC wifimeter-platform-windows wlanapi iphlpapi)
target_compile_options(wifimeter-platform-win32 PRIVATE -Wall -Wextra -Wpedantic)

# netioapi.h 需要 Winsock 的地址族类型，并且只在定义了目标 Windows 版本时才完整。
# zig 与 MinGW 的驱动已按目标给出默认值，因此只在尚未定义时补上，避免“宏重定义”告警。
add_compile_options("$<$<NOT:$<BOOL:$<TARGET_PROPERTY:COMPILE_DEFINITIONS>>>:-D_WIN32_WINNT=0x0A00>")
