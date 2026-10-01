#pragma once

// eBPF 与辅助进程共用的 map 布局；只包含固定宽度数据，不传输数据包内容。
#include <linux/types.h>

struct wm_process
{
    __u64 started_ns;
    __u64 executable_inode;
    __u32 executable_device;
    __u32 pid;
};

struct wm_owner
{
    struct wm_process process;
    char comm[16];
};

struct wm_counter_key
{
    struct wm_process process;
    __u32 interface_index;
    __u32 reserved;
};

struct wm_counter
{
    __u64 rx;
    __u64 tx;
    char comm[16];
};
