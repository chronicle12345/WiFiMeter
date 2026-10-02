#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace wifimeter::platform
{

enum class AppCollectorState
{
    disabled,
    starting,
    running,
    paused,
    permission,
    unavailable,
    partial,
};

std::string_view appCollectorStateName(AppCollectorState state);

// 计数从采集器 generation 开始累计，不是应用或系统启动以来的流量。
// instanceId 必须区分同一 PID 的不同进程实例；appId 跨实例稳定。
struct AppTrafficSample
{
    std::string interfaceId;
    std::string appId;
    std::string name;
    std::string instanceId;
    std::uint32_t processId = 0;
    std::uint64_t rxBytes = 0;
    std::uint64_t txBytes = 0;
    bool active = true;
    // 仅 loopback TCP 样本使用；与代理连接快照共用规范四元组。
    std::string connectionKey{};
    // 原生验证与诊断使用的实际采样来源，旧快照可省略。
    std::string source{};
};

struct AppTrafficReport
{
    AppCollectorState state = AppCollectorState::disabled;
    std::string generation;
    std::string detail;
    std::vector<AppTrafficSample> samples;
    // 采集端单调时钟毫秒数；0 表示旧格式，EStats 独立于 ETW 刷新。
    std::int64_t sampledAtMs = 0;
    std::int64_t loopbackSampledAtMs = 0;
};

class AppTrafficSource
{
public:
    virtual ~AppTrafficSource() = default;
    virtual void start() = 0;
    virtual void stop() = 0;
    virtual AppTrafficReport read() = 0;
};

// 原生采集辅助进程和测试夹具共用的快照格式，字节必须是十进制字符串。
AppTrafficReport parseAppTrafficReport(std::string_view text);
std::string serializeAppTrafficReport(const AppTrafficReport& report);

}  // namespace wifimeter::platform
