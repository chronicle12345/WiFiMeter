// Linux 采集辅助进程：只输出进程/IP 字节元数据，stdin 关闭后自动卸载自身 BPF links。
#include <bpf/bpf.h>
#include <bpf/libbpf.h>

#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstring>
#include <filesystem>
#include <fcntl.h>
#include <iostream>
#include <map>
#include <memory>
#include <net/if.h>
#include <poll.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <tuple>
#include <unistd.h>

#include "../platform/app_traffic.h"
#include "../platform/linux/app_capture_types.h"
#include "../platform/linux/app_process_identity.h"

namespace platform = wifimeter::platform;
namespace
{
using ProcessKey = std::tuple<std::uint32_t, std::uint64_t, std::uint32_t, std::uint64_t>;
struct Metadata
{
    std::string appId;
    std::string name;
};

void emit(const platform::AppTrafficReport& report)
{
    std::cout << platform::serializeAppTrafficReport(report) << std::endl;
}

platform::AppTrafficReport failure(int code, const std::string& context)
{
    return {code == EPERM || code == EACCES ? platform::AppCollectorState::permission : platform::AppCollectorState::unavailable,
        {}, context + ": " + std::strerror(code), {}};
}

class Capture
{
public:
    ~Capture()
    {
        for (auto* link : links_)
            bpf_link__destroy(link);
        if (object_)
            bpf_object__close(object_);
        if (cgroup_ >= 0)
            ::close(cgroup_);
    }

    platform::AppTrafficReport open()
    {
        if (::geteuid() != 0)
            return failure(EACCES, "应用采集辅助进程需要系统授权");
        const rlimit limit{RLIM_INFINITY, RLIM_INFINITY};
        ::setrlimit(RLIMIT_MEMLOCK, &limit);
        std::error_code error;
        const auto executable = std::filesystem::read_symlink("/proc/self/exe", error);
        if (error)
            return failure(error.value(), "读取辅助进程位置失败");
        const auto path = executable.parent_path() / "wifimeter-app-capture.bpf.o";
        object_ = bpf_object__open_file(path.c_str(), nullptr);
        const auto opened = libbpf_get_error(object_);
        if (opened)
        {
            object_ = nullptr;
            return failure(static_cast<int>(-opened), "打开应用采集程序失败");
        }
        const int loaded = bpf_object__load(object_);
        if (loaded)
            return failure(-loaded, "加载应用采集程序失败");
        cgroup_ = ::open("/sys/fs/cgroup", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        if (cgroup_ < 0)
            return failure(errno, "打开 cgroup v2 根目录失败");
        bpf_program* program = nullptr;
        bpf_object__for_each_program(program, object_)
        {
            auto* link = bpf_program__attach_cgroup(program, cgroup_);
            const auto attached = libbpf_get_error(link);
            if (attached)
                return failure(static_cast<int>(-attached), "挂载应用采集程序失败");
            links_.push_back(link);
        }
        counters_ = bpf_object__find_map_fd_by_name(object_, "counters");
        lost_ = bpf_object__find_map_fd_by_name(object_, "lost");
        if (counters_ < 0 || lost_ < 0)
            return failure(EINVAL, "应用采集计数 map 不可用");
        generation_ = std::to_string(::getpid()) + ":" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
        return {platform::AppCollectorState::running, generation_, {}, {}};
    }

    platform::AppTrafficReport read()
    {
        platform::AppTrafficReport report{platform::AppCollectorState::running, generation_, {}, {}};
        wm_counter_key key{}, next{};
        const wm_counter_key* previous = nullptr;
        bool incomplete = false;
        while (bpf_map_get_next_key(counters_, previous, &next) == 0)
        {
            wm_counter counter{};
            if (bpf_map_lookup_elem(counters_, &next, &counter) != 0)
                return failure(errno, "读取应用字节计数失败");
            const auto& process = next.process;
            const ProcessKey identity{process.pid, process.started_ns, process.executable_device, process.executable_inode};
            const auto actual = platform::linux::appProcessIdentity(process.pid, process.started_ns, process.executable_inode, process.executable_device);
            auto metadata = metadata_.find(identity);
            if (metadata == metadata_.end())
            {
                Metadata value{"unknown", "未识别应用"};
                if (actual.active && !actual.path.empty() && actual.path.size() <= 1024)
                {
                    value.appId = actual.path;
                    value.name = std::filesystem::path(actual.path).filename().string();
                    if (value.name.empty() || value.name.size() > 256)
                        value.name = "应用";
                }
                // 同一计数 key 的标识固定，不能在累计到一半时换 appId 重复计数。
                metadata = metadata_.emplace(identity, std::move(value)).first;
            }
            char interfaceName[IF_NAMESIZE]{};
            if (!::if_indextoname(next.interface_index, interfaceName))
            {
                incomplete = true;
            }
            else
            {
                const auto before = previousBytes_.find({identity, next.interface_index});
                if (metadata->second.appId == "unknown" && (before == previousBytes_.end() || before->second != std::pair<std::uint64_t, std::uint64_t>(counter.rx, counter.tx)))
                    incomplete = true;
                previousBytes_[{identity, next.interface_index}] = {counter.rx, counter.tx};
                report.samples.push_back({interfaceName, metadata->second.appId, metadata->second.name,
                    std::to_string(process.pid) + ":" + std::to_string(process.started_ns) + ":" + std::to_string(process.executable_device) + ":" + std::to_string(process.executable_inode),
                    actual.active && metadata->second.appId != "unknown" ? process.pid : 0,
                    counter.rx, counter.tx, actual.active});
            }
            key = next;
            previous = &key;
        }
        if (errno != ENOENT)
            return failure(errno, "遍历应用计数失败");
        std::uint32_t zero = 0;
        std::uint64_t lost = 0;
        if (bpf_map_lookup_elem(lost_, &zero, &lost) != 0)
            return failure(errno, "读取应用丢失计数失败");
        incomplete = incomplete || lost != lastLost_;
        lastLost_ = lost;
        if (incomplete)
        {
            report.state = platform::AppCollectorState::partial;
            report.detail = "部分流量的进程或接口身份不可读，或采集计数容量已满。";
        }
        return report;
    }

private:
    bpf_object* object_ = nullptr;
    std::vector<bpf_link*> links_;
    int cgroup_ = -1;
    int counters_ = -1;
    int lost_ = -1;
    std::uint64_t lastLost_ = 0;
    std::string generation_;
    std::map<ProcessKey, Metadata> metadata_;
    std::map<std::pair<ProcessKey, std::uint32_t>, std::pair<std::uint64_t, std::uint64_t>> previousBytes_;
};
}  // namespace

int main()
{
    // 辅助进程随后端退出；后端崩溃时也不能让特权采集留在后台。
    if (::prctl(PR_SET_PDEATHSIG, SIGTERM) != 0 || ::getppid() == 1)
        return 1;
    pollfd caller{STDIN_FILENO, POLLHUP, 0};
    if (::poll(&caller, 1, 0) > 0 && (caller.revents & POLLHUP))
        return 0;
    Capture capture;
    const auto opened = capture.open();
    emit(opened);
    if (opened.state != platform::AppCollectorState::running)
        return 1;
    std::string command;
    while (std::getline(std::cin, command))
    {
        if (command == "shutdown")
            break;
        if (command == "read")
            emit(capture.read());
    }
    return 0;
}
