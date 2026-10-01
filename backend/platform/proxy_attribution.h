#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace wifimeter::platform
{

struct ProxyOptions
{
    std::vector<std::uint16_t> ports;
    std::vector<std::string> processNames;
};

struct ProxyClientObservation
{
    std::string proxyAppId;  // 与原生应用采集相同的完整可执行文件路径
    std::string proxyName;
    std::string appId;
    std::string name;
    std::uint64_t connections = 0;
    // 当前快照内已去重的四元组键；调用方可按日期、代理路径、客户端路径跨快照去重。
    std::vector<std::string> connectionKeys;
};

struct ProxyProcess
{
    std::uint32_t processId = 0;
    std::string appId;
    std::string name;
};

enum class ProxySampleStatus { disabled, ready, unsupported, failed };

struct ProxyClientReport
{
    bool available = false;
    std::vector<ProxyClientObservation> observations;
    ProxySampleStatus status = ProxySampleStatus::unsupported;
    std::string detail;
    // 包含空闲监听器；路径读不到时保留 PID，appId/name 为空，不用于猜测字节归属。
    std::vector<ProxyProcess> proxies;
};

enum class ProxyTcpState { other, listen, established };

// 系统边界的数据格式。地址需为规范形式，remoteIsLoopback 由系统地址字节判断。
struct ProxyTcpConnection
{
    std::uint32_t processId = 0;
    ProxyTcpState state = ProxyTcpState::other;
    std::string localAddress;
    std::uint16_t localPort = 0;
    std::string remoteAddress;
    std::uint16_t remotePort = 0;
    bool remoteIsLoopback = false;
};

// 纯函数：注入同一轮 TCP 表和进程表。识别所有代理 PID，排除代理及采样进程自身。
// 同端口有多个不同代理且无法用反向连接确定属主时，不猜测归属。
ProxyClientReport proxyClientsFromTables(const ProxyOptions& options,
    const std::vector<ProxyTcpConnection>& connections, const std::vector<ProxyProcess>& processes,
    std::uint32_t selfProcessId = 0);

// Windows 直接调用 GetExtendedTcpTable 和进程查询 API；其他系统明确返回 unsupported。
// 不创建线程或子进程。建议调用方仅在配置端口非空时按 5 秒间隔调用，间隔由调用方控制。
// 空端口不扫描系统；仅配置进程名不会自动发现端口，与 main 的客户端筛选口径一致。
ProxyClientReport sampleProxyClients(const ProxyOptions& options);

struct ProxyAppBytes
{
    std::string proxyAppId;
    std::string proxyName;
    std::uint64_t rxBytes = 0;
    std::uint64_t txBytes = 0;
};

struct ProxyEstimatedUsage
{
    std::string day;
    std::string proxyAppId;
    std::string proxyName;
    std::string appId;
    std::string name;
    std::uint64_t rxBytes = 0;
    std::uint64_t txBytes = 0;
    bool estimated = true;
    bool unattributed = false;
};

// 只传入该日各代理的原始字节与该日持久化观测，返回独立估算行，不混入或修改原生记录。
// 每个代理分别按连接权重向下取整，未知客户端、缺失证据和舍入余量均保留为
// appId=proxy/unattributed 的估算行。Rx、Tx 分别守恒。输入和 SQLite 均不被修改。
std::vector<ProxyEstimatedUsage> estimateProxyUsage(const std::string& day,
    const std::vector<ProxyAppBytes>& proxyBytes, const std::vector<ProxyClientObservation>& observations);

}  // namespace wifimeter::platform
