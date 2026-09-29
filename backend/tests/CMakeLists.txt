# 测试目标按“依赖哪些平台实现”分组：
#
#   * Windows 用例不调用系统接口，因此在 Linux 与 Windows 上都能构建并运行；
#   * Linux 用例依赖 platform/linux，只在本机为 Linux 时构建；
#   * core/storage/support/ipc 与平台无关，两种系统都构建。
#
# 交叉编译到 Windows 时 ctest 无法直接运行 .exe，因此这些用例只在构建主机就是
# 目标系统时注册到 ctest；交叉编译脚本改用 Wine 逐个运行（见 packaging/windows/）。

set(WIFIMETER_COMMON_TEST_OPTIONS -Wall -Wextra -Wpedantic)

# 通用测试：只依赖给定库。
function(wifimeter_add_test test_name)
    add_executable(${test_name} ${test_name}.cpp)
    target_link_libraries(${test_name} PRIVATE ${ARGN})
    target_include_directories(${test_name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_link_libraries(${test_name} PRIVATE wifimeter-warnings)
    if(NOT WIFIMETER_CROSS_COMPILING)
        add_test(NAME ${test_name} COMMAND ${test_name})
    endif()
endfunction()

# Windows 平台用例：不调用系统接口，任何主机都能运行。
set(WIFIMETER_WINDOWS_TESTS
    windows_text_convert_test
    windows_interface_counters_test
    windows_wlan_test
    windows_platform_test
    # 接缝测试：真实 WindowsNetworkPlatform + 假的 SystemApi，序列与 Linux 侧共用。
    windows_integration_usage_test
)

foreach(test_name IN LISTS WIFIMETER_WINDOWS_TESTS)
    wifimeter_add_test(${test_name} wifimeter-platform-windows wifimeter-core)
endforeach()

# 真机冒烟：只读地调用 WLAN API 与 IP Helper，验证别名一致性与断开守卫。
# 只能在 Windows 上构建；交叉编译时它不能由 Wine 代表（Wine 的 WLAN 实现与真实系统不同），
# 因此不进 ctest，需要时在 Windows 机器上单独运行 build/windows/tests/windows_smoke_test.exe。
if(CMAKE_SYSTEM_NAME STREQUAL "Windows")
    wifimeter_add_test(windows_smoke_test wifimeter-platform-win32)
endif()

set(WIFIMETER_CORE_TESTS
    byte_count_test
    local_time_test
    network_key_test
    usage_accumulator_test
    quota_test
)

foreach(test_name IN LISTS WIFIMETER_CORE_TESTS)
    wifimeter_add_test(${test_name} wifimeter-core)
endforeach()

set(WIFIMETER_STORAGE_TESTS
    storage_database_test
    storage_test
)

foreach(test_name IN LISTS WIFIMETER_STORAGE_TESTS)
    wifimeter_add_test(${test_name} wifimeter-storage)
endforeach()

wifimeter_add_test(json_test wifimeter-support)

# 协议与服务层用例都用假的平台实现，不依赖任何系统接口，因此两种平台都能跑。
set(WIFIMETER_IPC_TESTS
    ipc_messages_test
    ipc_service_test
)

foreach(test_name IN LISTS WIFIMETER_IPC_TESTS)
    wifimeter_add_test(${test_name} wifimeter-ipc)
endforeach()

# Linux 平台用例：依赖 /proc、sysfs 与 nmcli 的解析实现。
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    set(WIFIMETER_LINUX_TESTS
        proc_net_dev_test
        sysfs_net_test
        nmcli_parse_test
        wifi_control_test
        linux_platform_test
    )

    foreach(test_name IN LISTS WIFIMETER_LINUX_TESTS)
        wifimeter_add_test(${test_name} wifimeter-platform-linux)
    endforeach()

    # 跨层接缝：平台实现 + 业务规则一起跑。
    wifimeter_add_test(integration_usage_test wifimeter-platform-linux wifimeter-core)
endif()

# 端到端：真的拉起后端进程按协议对话。测试数据（假网卡、假计数）在两端是同一份，
# 断言也共用 backend_process_support.h，因此 Windows 侧能跑与 Linux 完全相同的用例。
# 交叉编译时后端是 Windows 程序、本机无法运行，因此不在这里构建；
# 交叉编译脚本会把 Windows 版一起编译出来，交给 Wine 执行。
if(NOT WIFIMETER_CROSS_COMPILING OR CMAKE_SYSTEM_NAME STREQUAL "Windows")
    if(CMAKE_SYSTEM_NAME STREQUAL "Windows")
        set(WIFIMETER_PROCESS_TEST_SOURCE backend_process_win_test.cpp)
    else()
        set(WIFIMETER_PROCESS_TEST_SOURCE backend_process_test.cpp)
    endif()

    add_executable(backend_process_test ${WIFIMETER_PROCESS_TEST_SOURCE})
    target_link_libraries(backend_process_test PRIVATE wifimeter-support)
    target_include_directories(backend_process_test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_link_libraries(backend_process_test PRIVATE wifimeter-warnings)
    target_compile_definitions(backend_process_test PRIVATE WIFIMETER_BACKEND_BINARY="$<TARGET_FILE:wifimeter-backend>")
    add_dependencies(backend_process_test wifimeter-backend)
    add_test(NAME backend_process_test COMMAND backend_process_test)
endif()
