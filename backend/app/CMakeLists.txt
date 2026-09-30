# 后端可执行程序。入口按平台选择，差别只在数据目录位置与标准输入输出的等待方式：
#
#   * Linux：XDG 数据目录 + poll；
#   * Windows：%LOCALAPPDATA%\WiFiMeter + 管道句柄等待。
#
# 两者的命令行参数、输出协议与退出码一致。

if(CMAKE_SYSTEM_NAME STREQUAL "Windows")
    set(WIFIMETER_MAIN_SOURCE main_windows.cpp)
    set(WIFIMETER_PLATFORM_LIBRARY wifimeter-platform-win32)
else()
    set(WIFIMETER_MAIN_SOURCE main.cpp)
    set(WIFIMETER_PLATFORM_LIBRARY wifimeter-platform-linux)
endif()

add_executable(wifimeter-backend ${WIFIMETER_MAIN_SOURCE})
# MSVC 的多配置生成器默认追加 Release/Debug 子目录；桌面程序与打包配置
# 都按 app/wifimeter-backend(.exe) 查找，因此固定各配置的输出位置。
set_target_properties(wifimeter-backend PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "$<1:${CMAKE_CURRENT_BINARY_DIR}>"
)

target_link_libraries(wifimeter-backend PRIVATE wifimeter-ipc ${WIFIMETER_PLATFORM_LIBRARY})
target_link_libraries(wifimeter-backend PRIVATE wifimeter-warnings)

if(CMAKE_SYSTEM_NAME STREQUAL "Windows")
    # 静态链接运行库：安装包里不必再附带 libstdc++-6.dll / libgcc_s_seh-1.dll。
    if(NOT MSVC)
        target_link_options(wifimeter-backend PRIVATE -static-libgcc -static-libstdc++ -static)
    endif()
    add_compile_options("$<$<NOT:$<BOOL:$<TARGET_PROPERTY:COMPILE_DEFINITIONS>>>:-D_WIN32_WINNT=0x0A00>")
endif()
