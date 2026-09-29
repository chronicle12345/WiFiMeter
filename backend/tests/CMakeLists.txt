set(WIFIMETER_PLATFORM_TESTS
    proc_net_dev_test
    sysfs_net_test
    nmcli_parse_test
    wifi_control_test
    linux_platform_test
)

foreach(test_name IN LISTS WIFIMETER_PLATFORM_TESTS)
    add_executable(${test_name} ${test_name}.cpp)
    target_link_libraries(${test_name} PRIVATE wifimeter-platform-linux)
    target_include_directories(${test_name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_compile_options(${test_name} PRIVATE -Wall -Wextra -Wpedantic)
    add_test(NAME ${test_name} COMMAND ${test_name})
endforeach()

set(WIFIMETER_CORE_TESTS
    byte_count_test
    local_time_test
    network_key_test
    usage_accumulator_test
    quota_test
)

foreach(test_name IN LISTS WIFIMETER_CORE_TESTS)
    add_executable(${test_name} ${test_name}.cpp)
    target_link_libraries(${test_name} PRIVATE wifimeter-core)
    target_include_directories(${test_name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_compile_options(${test_name} PRIVATE -Wall -Wextra -Wpedantic)
    add_test(NAME ${test_name} COMMAND ${test_name})
endforeach()

# 跨层接缝：平台实现 + 业务规则一起跑。
set(WIFIMETER_INTEGRATION_TESTS
    integration_usage_test
)

foreach(test_name IN LISTS WIFIMETER_INTEGRATION_TESTS)
    add_executable(${test_name} ${test_name}.cpp)
    target_link_libraries(${test_name} PRIVATE wifimeter-platform-linux wifimeter-core)
    target_include_directories(${test_name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_compile_options(${test_name} PRIVATE -Wall -Wextra -Wpedantic)
    add_test(NAME ${test_name} COMMAND ${test_name})
endforeach()

set(WIFIMETER_STORAGE_TESTS
    storage_database_test
    storage_test
)

foreach(test_name IN LISTS WIFIMETER_STORAGE_TESTS)
    add_executable(${test_name} ${test_name}.cpp)
    target_link_libraries(${test_name} PRIVATE wifimeter-storage)
    target_include_directories(${test_name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_compile_options(${test_name} PRIVATE -Wall -Wextra -Wpedantic)
    add_test(NAME ${test_name} COMMAND ${test_name})
endforeach()

set(WIFIMETER_SUPPORT_TESTS
    json_test
)

foreach(test_name IN LISTS WIFIMETER_SUPPORT_TESTS)
    add_executable(${test_name} ${test_name}.cpp)
    target_link_libraries(${test_name} PRIVATE wifimeter-support)
    target_include_directories(${test_name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_compile_options(${test_name} PRIVATE -Wall -Wextra -Wpedantic)
    add_test(NAME ${test_name} COMMAND ${test_name})
endforeach()

set(WIFIMETER_IPC_TESTS
    ipc_messages_test
    ipc_service_test
)

foreach(test_name IN LISTS WIFIMETER_IPC_TESTS)
    add_executable(${test_name} ${test_name}.cpp)
    target_link_libraries(${test_name} PRIVATE wifimeter-ipc wifimeter-platform-linux)
    target_include_directories(${test_name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
    target_compile_options(${test_name} PRIVATE -Wall -Wextra -Wpedantic)
    add_test(NAME ${test_name} COMMAND ${test_name})
endforeach()

# 端到端：真的拉起后端进程按协议对话。
add_executable(backend_process_test backend_process_test.cpp)
target_link_libraries(backend_process_test PRIVATE wifimeter-support)
target_include_directories(backend_process_test PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_options(backend_process_test PRIVATE -Wall -Wextra -Wpedantic)
target_compile_definitions(backend_process_test PRIVATE WIFIMETER_BACKEND_BINARY="$<TARGET_FILE:wifimeter-backend>")
add_dependencies(backend_process_test wifimeter-backend)
add_test(NAME backend_process_test COMMAND backend_process_test)
