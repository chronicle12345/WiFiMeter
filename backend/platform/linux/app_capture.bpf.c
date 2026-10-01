// SPDX-License-Identifier: GPL-2.0-only
// 所有 cgroup 程序始终返回允许；这里只读取元数据、累计 IP 层字节，不改变网络。
#include <linux/bpf.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>
#include "app_capture_types.h"

// CO-RE 按运行内核 BTF 解析字段，不固定内核结构偏移。
struct super_block { __u32 s_dev; } __attribute__((preserve_access_index));
struct inode { unsigned long i_ino; unsigned short i_mode; struct super_block *i_sb; } __attribute__((preserve_access_index));
struct file { struct inode *f_inode; void *private_data; } __attribute__((preserve_access_index));
struct mm_struct { struct file *exe_file; } __attribute__((preserve_access_index));
struct task_struct { struct task_struct *group_leader; struct mm_struct *mm; __u64 start_boottime; } __attribute__((preserve_access_index));
// 所有者随 socket 生命周期保存；内核将监听 socket 的身份复制给 accepted socket。
struct {
    __uint(type, BPF_MAP_TYPE_SK_STORAGE);
    __uint(map_flags, BPF_F_NO_PREALLOC | BPF_F_CLONE);
    __type(key, int);
    __type(value, struct wm_owner);
} owners SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 65536);
    __type(key, struct wm_counter_key);
    __type(value, struct wm_counter);
} counters SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key, __u32);
    __type(value, __u64);
} lost SEC(".maps");

static __always_inline void current_owner(struct wm_owner *owner)
{
    struct task_struct *task = (void *)bpf_get_current_task();
    struct task_struct *leader = BPF_CORE_READ(task, group_leader);
    owner->process.pid = bpf_get_current_pid_tgid() >> 32;
    owner->process.started_ns = BPF_CORE_READ(leader, start_boottime);
    struct inode *exe = BPF_CORE_READ(task, mm, exe_file, f_inode);
    owner->process.executable_inode = BPF_CORE_READ(exe, i_ino);
    owner->process.executable_device = BPF_CORE_READ(exe, i_sb, s_dev);
    bpf_get_current_comm(owner->comm, sizeof(owner->comm));
}

SEC("cgroup/sock_create")
int created(struct bpf_sock *socket)
{
    if (socket->family != 2 && socket->family != 10)
        return 1;
    struct wm_owner owner = {};
    current_owner(&owner);
    bpf_sk_storage_get(&owners, socket, &owner, BPF_SK_STORAGE_GET_F_CREATE);
    return 1;
}

static __always_inline int count(struct __sk_buff *skb, int receive)
{
    if (skb->family != 2 && skb->family != 10)
        return 1;
    struct wm_owner *owner = skb->sk ? bpf_sk_storage_get(&owners, skb->sk, 0, 0) : 0;
    struct wm_counter_key key = {};
    key.interface_index = skb->ifindex;
    if (!key.interface_index)
        key.interface_index = skb->ingress_ifindex;
    if (owner)
        key.process = owner->process;
    struct wm_counter *counter = bpf_map_lookup_elem(&counters, &key);
    if (!counter)
    {
        struct wm_counter initial = {};
        if (owner)
            __builtin_memcpy(initial.comm, owner->comm, sizeof(initial.comm));
        bpf_map_update_elem(&counters, &key, &initial, BPF_NOEXIST);
        counter = bpf_map_lookup_elem(&counters, &key);
    }
    if (counter)
    {
        if (receive)
            __sync_fetch_and_add(&counter->rx, skb->len);
        else
            __sync_fetch_and_add(&counter->tx, skb->len);
    }
    else
    {
        __u32 zero = 0;
        __u64 *missing = bpf_map_lookup_elem(&lost, &zero);
        if (missing)
            __sync_fetch_and_add(missing, 1);
    }
    return 1;
}

SEC("cgroup_skb/ingress")
int received(struct __sk_buff *skb) { return count(skb, 1); }

SEC("cgroup_skb/egress")
int sent(struct __sk_buff *skb) { return count(skb, 0); }

char LICENSE[] SEC("license") = "GPL";
