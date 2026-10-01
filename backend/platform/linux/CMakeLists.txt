add_library(wifimeter-platform-linux STATIC
    text_file.cpp
    proc_net_dev.cpp
    sysfs_net.cpp
    nmcli.cpp
    wifi_control.cpp
    linux_network_platform.cpp
    app_process_identity.cpp
    linux_app_traffic.cpp
)

# 共用接口 network_platform.h 位于上一级 platform/ 目录，实现与标签在 wifimeter-platform 中。
target_include_directories(wifimeter-platform-linux PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/..)
target_link_libraries(wifimeter-platform-linux PUBLIC wifimeter-platform)
target_link_libraries(wifimeter-platform-linux PRIVATE wifimeter-warnings)
find_package(Threads REQUIRED)
target_link_libraries(wifimeter-platform-linux PUBLIC Threads::Threads)

# 原生应用采集是可选能力；普通网卡采集不依赖 libbpf 或系统授权。
find_program(WIFIMETER_BPF_CLANG NAMES clang-18 clang-17 clang-16 clang-15 clang-14 clang)
find_path(WIFIMETER_LIBBPF_INCLUDE_DIR bpf/libbpf.h)
find_library(WIFIMETER_LIBBPF_LIBRARY NAMES libbpf.a)
set(WIFIMETER_LIBBPF_MODERN OFF)
if(WIFIMETER_LIBBPF_INCLUDE_DIR)
    file(STRINGS "${WIFIMETER_LIBBPF_INCLUDE_DIR}/bpf/libbpf_version.h" WIFIMETER_LIBBPF_MAJOR
        REGEX "^#define LIBBPF_MAJOR_VERSION ")
    if(WIFIMETER_LIBBPF_MAJOR MATCHES " [1-9][0-9]*$")
        set(WIFIMETER_LIBBPF_MODERN ON)
    endif()
endif()
if(WIFIMETER_BPF_CLANG AND WIFIMETER_LIBBPF_MODERN AND WIFIMETER_LIBBPF_LIBRARY)
    set(WIFIMETER_APP_CAPTURE_DEFAULT ON)
else()
    set(WIFIMETER_APP_CAPTURE_DEFAULT OFF)
endif()
option(WIFIMETER_LINUX_APP_CAPTURE "构建 Linux eBPF 应用采集辅助进程" ${WIFIMETER_APP_CAPTURE_DEFAULT})
if(WIFIMETER_LINUX_APP_CAPTURE)
    target_compile_definitions(wifimeter-platform-linux PUBLIC WIFIMETER_HAS_LINUX_APP_CAPTURE=1)
    if(NOT WIFIMETER_BPF_CLANG OR NOT WIFIMETER_LIBBPF_MODERN OR NOT WIFIMETER_LIBBPF_LIBRARY)
        message(FATAL_ERROR "Linux 应用采集需要支持 BPF 的 clang 和 libbpf-dev >= 1.0（静态库及头文件）。")
    endif()
    set(WIFIMETER_BPF_OBJECT "${CMAKE_BINARY_DIR}/app/wifimeter-app-capture.bpf.o")
    add_custom_command(OUTPUT "${WIFIMETER_BPF_OBJECT}"
        COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_BINARY_DIR}/app"
        COMMAND ${WIFIMETER_BPF_CLANG} -O2 -g -target bpf "-ffile-prefix-map=${CMAKE_SOURCE_DIR}=backend"
            -I${WIFIMETER_LIBBPF_INCLUDE_DIR} -I/usr/include/${CMAKE_LIBRARY_ARCHITECTURE}
            -c "${CMAKE_CURRENT_SOURCE_DIR}/app_capture.bpf.c" -o "${WIFIMETER_BPF_OBJECT}"
        DEPENDS app_capture.bpf.c app_capture_types.h
        VERBATIM)
    add_custom_target(wifimeter-app-capture-bpf DEPENDS "${WIFIMETER_BPF_OBJECT}")
    add_executable(wifimeter-app-capture "${CMAKE_SOURCE_DIR}/app/app_capture_linux.cpp")
    set_target_properties(wifimeter-app-capture PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/app")
    target_include_directories(wifimeter-app-capture SYSTEM PRIVATE "${WIFIMETER_LIBBPF_INCLUDE_DIR}")
    find_library(WIFIMETER_LIBELF_LIBRARY NAMES elf libelf.so.1)
    if(NOT WIFIMETER_LIBELF_LIBRARY)
        message(FATAL_ERROR "Linux 应用采集需要 libelf。")
    endif()
    find_package(ZLIB REQUIRED)
    target_link_libraries(wifimeter-app-capture PRIVATE wifimeter-platform-linux ${WIFIMETER_LIBBPF_LIBRARY}
        ${WIFIMETER_LIBELF_LIBRARY} ZLIB::ZLIB wifimeter-warnings)
    add_dependencies(wifimeter-app-capture wifimeter-app-capture-bpf)
endif()
