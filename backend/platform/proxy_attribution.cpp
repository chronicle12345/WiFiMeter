#include "proxy_attribution.h"

#include <algorithm>
#include <cctype>
#include <limits>
#include <map>
#include <set>
#include <tuple>
#include <utility>

#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#include <cstddef>
#include <cstring>
#endif

namespace wifimeter::platform
{
std::string proxyConnectionKey(const ProxyTcpConnection& row)
{
    // 地址带长度，IPv6 的冒号不会与端口分隔符产生歧义。
    return std::to_string(row.localAddress.size()) + ":" + row.localAddress + ":" + std::to_string(row.localPort) + ">" +
        std::to_string(row.remoteAddress.size()) + ":" + row.remoteAddress + ":" + std::to_string(row.remotePort);
}

namespace
{
std::string pathKey(std::string value)
{
    for (char& ch : value)
        ch = ch == '/' ? '\\' : static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    return value;
}

std::string fileName(const std::string& path)
{
    const auto separator = path.find_last_of("/\\");
    return separator == std::string::npos ? path : path.substr(separator + 1);
}

std::string processKey(std::string value)
{
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return {};
    value = pathKey(value.substr(first, value.find_last_not_of(" \t\r\n") - first + 1));
    if (value.size() >= 4 && value.substr(value.size() - 4) == ".exe")
        value.resize(value.size() - 4);
    return value;
}

bool knownApp(const std::string& appId)
{
    return !appId.empty() && appId != "unknown" && appId != "proxy/unattributed";
}


bool listenerMatches(const ProxyTcpConnection& listener, const ProxyTcpConnection& client)
{
    if (listener.localPort != client.remotePort) return false;
    if (listener.localAddress == client.remoteAddress) return true;
    // :: 可能是双栈监听；有歧义时由反向 established 行确认，不能任选一个 PID。
    return listener.localAddress == "::" ||
        (listener.localAddress == "0.0.0.0" && client.remoteAddress.find(':') == std::string::npos);
}

// 精确计算 floor(bytes * weight / total)，不依赖 MSVC 不支持的 __int128，且中间值不溢出。
std::uint64_t proportionalBytes(std::uint64_t bytes, std::uint64_t weight, std::uint64_t total)
{
    if (weight == total) return bytes;
    std::uint64_t quotient = 0, remainder = 0;
    for (int bit = 63; bit >= 0; --bit)
    {
        quotient <<= 1;
        if (remainder >= total - remainder)
        {
            remainder -= total - remainder;
            ++quotient;
        }
        else remainder += remainder;
        if (((bytes >> bit) & 1) == 0) continue;
        if (remainder >= total - weight)
        {
            remainder -= total - weight;
            ++quotient;
        }
        else remainder += weight;
    }
    return quotient;
}

#if defined(_WIN32)
std::string utf8(const std::wstring& value)
{
    if (value.empty()) return {};
    const int size = ::WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (size <= 0) return {};
    std::string result(static_cast<std::size_t>(size), '\0');
    if (::WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr) != size)
        return {};
    return result;
}

std::uint16_t portOf(DWORD port)
{
    return static_cast<std::uint16_t>(((port & 0xff) << 8) | ((port >> 8) & 0xff));
}

std::string addressOf(const void* address, bool ipv6, DWORD scope = 0)
{
    char text[INET6_ADDRSTRLEN]{};
    if (!::InetNtopA(ipv6 ? AF_INET6 : AF_INET, address, text, sizeof(text))) return {};
    std::string result(text);
    if (ipv6 && scope != 0) result += "%" + std::to_string(scope);
    return result;
}

bool loopbackOf(const unsigned char* address, bool ipv6)
{
    if (!ipv6) return address[0] == 127;
    const bool leadingZero = std::all_of(address, address + 10, [](unsigned char byte) { return byte == 0; });
    if (!leadingZero) return false;
    if (address[10] == 0xff && address[11] == 0xff) return address[12] == 127;
    return std::all_of(address + 10, address + 15, [](unsigned char byte) { return byte == 0; }) && address[15] == 1;
}

ProxyTcpState stateOf(DWORD state)
{
    if (state == MIB_TCP_STATE_LISTEN) return ProxyTcpState::listen;
    if (state == MIB_TCP_STATE_ESTAB) return ProxyTcpState::established;
    return ProxyTcpState::other;
}

bool appendTcpTable(bool ipv6, std::vector<ProxyTcpConnection>& rows, std::string& detail)
{
    const ULONG family = ipv6 ? AF_INET6 : AF_INET;
    DWORD size = 0;
    DWORD code = ::GetExtendedTcpTable(nullptr, &size, FALSE, family, TCP_TABLE_OWNER_PID_ALL, 0);
    if (code == ERROR_NO_DATA || (code == NO_ERROR && size == 0)) return true;
    std::vector<unsigned char> buffer;
    // TCP 表可能在两次调用间增长，按系统返回的大小有限重试。
    for (int attempt = 0; attempt < 3 && code == ERROR_INSUFFICIENT_BUFFER; ++attempt)
    {
        buffer.resize(size);
        code = ::GetExtendedTcpTable(buffer.data(), &size, FALSE, family, TCP_TABLE_OWNER_PID_ALL, 0);
    }
    if (code != NO_ERROR || buffer.size() < sizeof(DWORD))
    {
        detail = std::string("GetExtendedTcpTable(") + (ipv6 ? "IPv6" : "IPv4") + "): " + std::to_string(code);
        return false;
    }
    DWORD count = 0;
    std::memcpy(&count, buffer.data(), sizeof(count));
    const std::size_t offset = ipv6 ? offsetof(MIB_TCP6TABLE_OWNER_PID, table) : offsetof(MIB_TCPTABLE_OWNER_PID, table);
    const std::size_t rowSize = ipv6 ? sizeof(MIB_TCP6ROW_OWNER_PID) : sizeof(MIB_TCPROW_OWNER_PID);
    if (buffer.size() < offset || count > (buffer.size() - offset) / rowSize)
    {
        detail = "GetExtendedTcpTable: truncated table";
        return false;
    }
    for (DWORD index = 0; index < count; ++index)
    {
        ProxyTcpConnection converted;
        const auto* data = buffer.data() + offset + index * rowSize;
        if (ipv6)
        {
            MIB_TCP6ROW_OWNER_PID row{};
            std::memcpy(&row, data, sizeof(row));
            converted.state = stateOf(row.dwState);
            converted.processId = row.dwOwningPid;
            converted.localAddress = addressOf(row.ucLocalAddr, true, row.dwLocalScopeId);
            converted.localPort = portOf(row.dwLocalPort);
            converted.remoteAddress = addressOf(row.ucRemoteAddr, true, row.dwRemoteScopeId);
            converted.remotePort = portOf(row.dwRemotePort);
            converted.remoteIsLoopback = loopbackOf(row.ucRemoteAddr, true);
        }
        else
        {
            MIB_TCPROW_OWNER_PID row{};
            std::memcpy(&row, data, sizeof(row));
            converted.state = stateOf(row.dwState);
            converted.processId = row.dwOwningPid;
            converted.localAddress = addressOf(&row.dwLocalAddr, false);
            converted.localPort = portOf(row.dwLocalPort);
            converted.remoteAddress = addressOf(&row.dwRemoteAddr, false);
            converted.remotePort = portOf(row.dwRemotePort);
            converted.remoteIsLoopback = loopbackOf(reinterpret_cast<const unsigned char*>(&row.dwRemoteAddr), false);
        }
        if (converted.state != ProxyTcpState::other) rows.push_back(std::move(converted));
    }
    return true;
}

std::vector<ProxyProcess> readProcesses(const std::vector<ProxyTcpConnection>& connections)
{
    std::set<std::uint32_t> pids;
    for (const auto& row : connections) pids.insert(row.processId);
    std::vector<ProxyProcess> processes;
    for (const auto pid : pids)
    {
        const HANDLE handle = ::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (!handle) continue;
        std::wstring path(32768, L'\0');
        DWORD length = static_cast<DWORD>(path.size());
        const bool queried = ::QueryFullProcessImageNameW(handle, 0, path.data(), &length) != FALSE;
        ::CloseHandle(handle);
        if (!queried) continue;
        path.resize(length);
        auto appId = utf8(path);
        if (!appId.empty()) processes.push_back({pid, appId, fileName(appId)});
    }
    return processes;
}
#endif
}  // namespace

ProxyClientReport proxyClientsFromTables(const ProxyOptions& options,
    const std::vector<ProxyTcpConnection>& connections, const std::vector<ProxyProcess>& processes,
    std::uint32_t selfProcessId)
{
    ProxyClientReport report;
    report.available = true;
    report.status = ProxySampleStatus::ready;
    std::set<std::uint16_t> ports(options.ports.begin(), options.ports.end());
    ports.erase(0);
    if (ports.empty())
    {
        report.status = ProxySampleStatus::disabled;
        return report;
    }
    std::set<std::string> names;
    for (const auto& name : options.processNames)
        if (const auto key = processKey(name); !key.empty()) names.insert(key);
    std::map<std::uint32_t, const ProxyProcess*> owners;
    std::set<std::uint32_t> proxies;
    for (const auto& process : processes)
    {
        owners.emplace(process.processId, &process);
        const auto name = process.name.empty() ? fileName(process.appId) : process.name;
        if (names.count(processKey(name))) proxies.insert(process.processId);
    }
    // 监听器即使没有活跃连接也要识别；同一个代理的所有 PID 都必须排除。
    for (const auto& row : connections)
        if (row.state == ProxyTcpState::listen && ports.count(row.localPort)) proxies.insert(row.processId);

    bool missingIdentity = false;
    for (const auto pid : proxies)
    {
        const auto owner = owners.find(pid);
        if (owner == owners.end() || !knownApp(owner->second->appId)) missingIdentity = true;
        report.proxies.push_back(owner == owners.end() ? ProxyProcess{pid, {}, {}} : *owner->second);
    }

    using DetectionKey = std::tuple<std::uint32_t, std::uint16_t, std::string>;
    std::map<DetectionKey, ProxyDetectedClient> detected;
    std::map<DetectionKey, std::set<std::string>> detectedKeys;
    std::map<std::pair<std::string, std::string>, ProxyClientObservation> grouped;
    std::map<std::pair<std::string, std::string>, std::set<std::string>> seen;
    for (const auto& row : connections)
    {
        if (row.state != ProxyTcpState::established || !row.remoteIsLoopback || !ports.count(row.remotePort) ||
            row.localAddress.empty() || row.remoteAddress.empty() || ports.count(row.localPort) ||
            row.processId == selfProcessId || proxies.count(row.processId))
            continue;
        const auto client = owners.find(row.processId);
        if (client == owners.end() || !knownApp(client->second->appId))
        {
            missingIdentity = true;
            continue;
        }
        std::set<std::uint32_t> candidates;
        for (const auto& server : connections)
        {
            if (server.state == ProxyTcpState::established &&
                server.localAddress == row.remoteAddress && server.localPort == row.remotePort &&
                server.remoteAddress == row.localAddress && server.remotePort == row.localPort)
                candidates.insert(server.processId);
        }
        if (candidates.empty())
            for (const auto& listener : connections)
                if (listener.state == ProxyTcpState::listen && listenerMatches(listener, row)) candidates.insert(listener.processId);
        // 单一 TCP 属主足以展示客户端，但代理路径不可读时不能创建字节分配权重。
        if (candidates.size() == 1 && *candidates.begin() != row.processId)
        {
            const auto pid = *candidates.begin();
            const auto owner = owners.find(pid);
            if (owner == owners.end() || !knownApp(owner->second->appId))
            {
                missingIdentity = true;
                const DetectionKey key{pid, row.remotePort, pathKey(client->second->appId)};
                if (detectedKeys[key].insert(proxyConnectionKey(row)).second)
                {
                    auto& found = detected[key];
                    found.appId = client->second->appId;
                    found.name = client->second->name.empty() ? fileName(found.appId) : client->second->name;
                    found.proxyName = "端口 " + std::to_string(row.remotePort) + "（路径不可读）";
                    ++found.connections;
                    found.connectionKeys.push_back(proxyConnectionKey(row));
                }
                continue;
            }
        }
        const ProxyProcess* proxy = nullptr;
        bool ambiguous = false;
        for (const auto pid : candidates)
        {
            const auto candidate = owners.find(pid);
            if (candidate == owners.end() || !knownApp(candidate->second->appId))
            {
                missingIdentity = true;
                ambiguous = true;
                break;
            }
            if (proxy && pathKey(proxy->appId) != pathKey(candidate->second->appId))
            {
                ambiguous = true;
                break;
            }
            proxy = candidate->second;
        }
        if (ambiguous || !proxy || pathKey(proxy->appId) == pathKey(client->second->appId)) continue;
        const auto group = std::make_pair(pathKey(proxy->appId), pathKey(client->second->appId));
        const auto key = proxyConnectionKey(row);
        if (!seen[group].insert(key).second) continue;
        auto& observation = grouped[group];
        observation.proxyAppId = proxy->appId;
        observation.proxyName = proxy->name.empty() ? fileName(proxy->appId) : proxy->name;
        observation.appId = client->second->appId;
        observation.name = client->second->name.empty() ? fileName(client->second->appId) : client->second->name;
        observation.connectionKeys.push_back(key);
        ++observation.connections;
    }
    for (auto& [key, observation] : grouped)
    {
        std::sort(observation.connectionKeys.begin(), observation.connectionKeys.end());
        report.observations.push_back(std::move(observation));
    }
    for (auto& [key, client] : detected)
        report.detectedClients.push_back(std::move(client));
    // ready 表示 TCP 表读取成功；身份不可读和没有可归属连接仍需解释，不能暗示检测完整。
    if (missingIdentity)
        report.detail = "部分代理或客户端的进程路径不可读，可能受权限限制或进程已退出；这些连接未参与归属。";
    else if (report.observations.empty())
        report.detail = "未确认可归属的 TCP loopback 客户端连接；请检查端口和监听进程。仅有 TUN 流量时无法通过代理端口识别客户端。";
    return report;
}

ProxyClientReport sampleProxyClients(const ProxyOptions& options)
{
#if defined(_WIN32)
    if (std::none_of(options.ports.begin(), options.ports.end(), [](auto port) { return port != 0; }))
        return proxyClientsFromTables(options, {}, {});
    std::vector<ProxyTcpConnection> connections;
    ProxyClientReport report;
    if (!appendTcpTable(false, connections, report.detail) || !appendTcpTable(true, connections, report.detail))
    {
        report.status = ProxySampleStatus::failed;
        return report;
    }
    return proxyClientsFromTables(options, connections, readProcesses(connections), ::GetCurrentProcessId());
#else
    (void)options;
    ProxyClientReport report;
    report.detail = "Proxy TCP observation is unsupported on this platform.";
    return report;
#endif
}

std::vector<ProxyEstimatedUsage> estimateProxyUsage(const std::string& day,
    const std::vector<ProxyAppBytes>& proxyBytes, const std::vector<ProxyClientObservation>& observations)
{
    std::vector<ProxyEstimatedUsage> result;
    for (const auto& proxy : proxyBytes)
    {
        std::uint64_t total = 0;
        bool overflow = false;
        std::map<std::string, ProxyClientObservation> weights;
        for (const auto& observation : observations)
        {
            if (pathKey(observation.proxyAppId) != pathKey(proxy.proxyAppId)) continue;
            if (observation.connections > std::numeric_limits<std::uint64_t>::max() - total)
            {
                overflow = true;
                break;
            }
            total += observation.connections;
            auto [entry, inserted] = weights.try_emplace(pathKey(observation.appId), observation);
            if (!inserted) entry->second.connections += observation.connections;
        }
        auto remainingRx = proxy.rxBytes, remainingTx = proxy.txBytes;
        if (total != 0 && !overflow)
        {
            for (const auto& [key, observation] : weights)
            {
                if (!observation.connections || !knownApp(observation.appId) || key == pathKey(proxy.proxyAppId)) continue;
                const auto rx = proportionalBytes(proxy.rxBytes, observation.connections, total);
                const auto tx = proportionalBytes(proxy.txBytes, observation.connections, total);
                if (rx == 0 && tx == 0) continue;
                result.push_back({day, proxy.proxyAppId, proxy.proxyName, observation.appId, observation.name, rx, tx, true, false});
                remainingRx -= rx;
                remainingTx -= tx;
            }
        }
        if (remainingRx != 0 || remainingTx != 0)
            result.push_back({day, proxy.proxyAppId, proxy.proxyName, "proxy/unattributed", "Unattributed", remainingRx, remainingTx, true, true});
    }
    return result;
}

}  // namespace wifimeter::platform
