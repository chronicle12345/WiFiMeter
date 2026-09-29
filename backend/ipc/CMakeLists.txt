# 与 Electron 之间的协议、服务逻辑与输入输出循环。
add_library(wifimeter-ipc STATIC
    messages.cpp
    service.cpp
    server.cpp
)

target_include_directories(wifimeter-ipc PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(wifimeter-ipc PUBLIC wifimeter-storage wifimeter-support wifimeter-core)
target_compile_options(wifimeter-ipc PRIVATE -Wall -Wextra -Wpedantic)
