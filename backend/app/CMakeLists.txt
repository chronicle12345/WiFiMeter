# 可执行程序只在有对应平台实现时构建（目前只有 Linux）。
add_executable(wifimeter-backend main.cpp)

target_link_libraries(wifimeter-backend PRIVATE wifimeter-ipc wifimeter-platform-linux)
target_compile_options(wifimeter-backend PRIVATE -Wall -Wextra -Wpedantic)
