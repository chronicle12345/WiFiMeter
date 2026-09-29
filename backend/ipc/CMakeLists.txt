# 与 Electron 之间的协议、服务逻辑与输入输出循环。
#
# 输入输出循环按平台选择：POSIX 用 poll 同时等待标准输入与采样定时器，
# Windows 用 WaitForSingleObject 等待管道句柄超时。两者的对外接口一致，
# 因此 main.cpp 与 main_windows.cpp 使用相同的调用方式。
if(CMAKE_SYSTEM_NAME STREQUAL "Windows")
    set(WIFIMETER_SERVER_SOURCE server_windows.cpp)
else()
    set(WIFIMETER_SERVER_SOURCE server.cpp)
endif()

add_library(wifimeter-ipc STATIC
    messages.cpp
    service.cpp
    ${WIFIMETER_SERVER_SOURCE}
)

target_include_directories(wifimeter-ipc PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(wifimeter-ipc PUBLIC wifimeter-storage wifimeter-support wifimeter-core)
target_compile_options(wifimeter-ipc PRIVATE -Wall -Wextra -Wpedantic)

# Windows 实现的头文件里要用 HANDLE 与 WaitForSingleObject，需要目标 Windows 版本定义。
if(CMAKE_SYSTEM_NAME STREQUAL "Windows")
    add_compile_options("$<$<NOT:$<BOOL:$<TARGET_PROPERTY:COMPILE_DEFINITIONS>>>:-D_WIN32_WINNT=0x0A00>")
endif()
