# Windows 系统调用实现：WLAN API（状态、身份、断开）与 IP Helper（累计计数）。
#
# 这些源文件直接包含 Win32 头文件，因此只在目标系统为 Windows 时构建；
# 所有解析与判断都在 platform/windows/ 下，可以在任何平台上测试。
add_library(wifimeter-platform-win32 STATIC
    wlanapi_query.cpp
    etw_app_capture.cpp
    windows_app_traffic.cpp
)

# 平台无关部分的头文件（system_api.h、wlan.h 等）在上一级 platform/windows/ 下。
target_include_directories(wifimeter-platform-win32 PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/../windows)
target_link_libraries(wifimeter-platform-win32 PUBLIC wifimeter-platform-windows wlanapi iphlpapi advapi32 ws2_32 ole32 shell32)
target_link_libraries(wifimeter-platform-win32 PRIVATE wifimeter-warnings)

# netioapi.h 需要 Winsock 的地址族类型，并且只在定义了目标 Windows 版本时才完整。
# MSVC 显式指定 Windows 10；Zig 与 MinGW 已给出默认值，避免重复定义。
target_compile_definitions(wifimeter-platform-win32 PUBLIC $<$<CXX_COMPILER_ID:MSVC>:_WIN32_WINNT=0x0A00>)

add_executable(wifimeter-app-capture "${CMAKE_SOURCE_DIR}/app/app_capture_windows.cpp")
set_target_properties(wifimeter-app-capture PROPERTIES RUNTIME_OUTPUT_DIRECTORY "$<1:${CMAKE_BINARY_DIR}/app>")
target_link_libraries(wifimeter-app-capture PRIVATE wifimeter-platform-win32 wifimeter-warnings)
if(NOT MSVC)
    target_link_options(wifimeter-app-capture PRIVATE -static-libgcc -static-libstdc++ -static)
endif()
