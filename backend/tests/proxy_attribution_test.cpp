#include "../platform/proxy_attribution.h"
#include "test_support.h"

#include <algorithm>
#include <limits>

using namespace wifimeter::platform;

namespace
{
ProxyTcpConnection listener(std::uint32_t pid, std::uint16_t port, std::string address = "0.0.0.0")
{
    return {pid, ProxyTcpState::listen, std::move(address), port, {}, 0, false};
}
ProxyTcpConnection client(std::uint32_t pid, std::uint16_t local, std::uint16_t remote = 7890)
{
    return {pid, ProxyTcpState::established, "127.0.0.1", local, "127.0.0.1", remote, true};
}
ProxyClientObservation weight(std::string proxy, std::string app, std::uint64_t count)
{
    return {std::move(proxy), "proxy.exe", std::move(app), "client.exe", count, {}};
}

void identifiesListenersAndDeduplicatesConnections()
{
    const std::vector<ProxyProcess> processes{
        {10, R"(C:\proxy\core.exe)", "core.exe"}, {11, R"(C:\proxy\core.exe)", "core.exe"},
        {20, R"(C:\apps\browser.exe)", "browser.exe"}, {21, R"(D:\apps\browser.exe)", "browser.exe"},
        {30, R"(C:\named\proxy.exe)", "Proxy.EXE"}, {40, R"(C:\meter.exe)", "meter.exe"}};
    std::vector<ProxyTcpConnection> rows{listener(10, 7890), listener(11, 7891), client(20, 50000),
        client(20, 50000), client(20, 50001), client(21, 50002), client(11, 50003),
        client(30, 50004), client(40, 50005), client(999, 50006), client(20, 7890)};
    auto notLoopback = client(20, 50007);
    notLoopback.remoteAddress = "1.2.3.4";
    notLoopback.remoteIsLoopback = false;
    rows.push_back(notLoopback);
    rows.push_back(client(20, 50008, 443));
    auto notEstablished = client(20, 50009);
    notEstablished.state = ProxyTcpState::other;
    rows.push_back(notEstablished);
    const auto report = proxyClientsFromTables({{7890, 7891}, {"  pRoXy.exe "}}, rows, processes, 40);
    WIFIMETER_CHECK(report.available);
    WIFIMETER_CHECK_EQ(report.observations.size(), std::size_t(2));
    if (report.observations.size() != 2) return;
    WIFIMETER_CHECK_EQ(report.observations[0].proxyAppId, processes[0].appId);
    WIFIMETER_CHECK_EQ(report.observations[0].appId, processes[2].appId);
    WIFIMETER_CHECK_EQ(report.observations[0].connections, std::uint64_t(2));
    WIFIMETER_CHECK_EQ(report.observations[0].connectionKeys.size(), std::size_t(2));
    WIFIMETER_CHECK_EQ(report.observations[1].connections, std::uint64_t(1));
}

void allocatesPerProxyAndPreservesRemainders()
{
    const std::vector<ProxyAppBytes> bytes{{"p1", "Proxy 1", 101, 11}, {"p2", "Proxy 2", 50, 70}, {"p3", "Proxy 3", 9, 8}};
    const std::vector<ProxyClientObservation> observations{weight("p1", "a", 1), weight("p1", "b", 2), weight("p2", "c", 1)};
    const auto estimated = estimateProxyUsage("2026-10-01", bytes, observations);
    WIFIMETER_CHECK_EQ(estimated.size(), std::size_t(5));
    std::uint64_t rx = 0, tx = 0;
    bool sawRemainder = false, sawNoEvidence = false;
    for (const auto& row : estimated)
    {
        WIFIMETER_CHECK(row.estimated);
        WIFIMETER_CHECK_EQ(row.day, std::string("2026-10-01"));
        rx += row.rxBytes;
        tx += row.txBytes;
        if (row.proxyAppId == "p1" && row.appId == "a")
        {
            WIFIMETER_CHECK_EQ(row.rxBytes, std::uint64_t(33));
            WIFIMETER_CHECK_EQ(row.txBytes, std::uint64_t(3));
        }
        if (row.proxyAppId == "p1" && row.unattributed)
        {
            sawRemainder = true;
            WIFIMETER_CHECK_EQ(row.appId, std::string("proxy/unattributed"));
            WIFIMETER_CHECK_EQ(row.rxBytes, std::uint64_t(1));
            WIFIMETER_CHECK_EQ(row.txBytes, std::uint64_t(1));
        }
        if (row.proxyAppId == "p3" && row.unattributed) sawNoEvidence = true;
    }
    WIFIMETER_CHECK_EQ(rx, std::uint64_t(160));
    WIFIMETER_CHECK_EQ(tx, std::uint64_t(89));
    WIFIMETER_CHECK(sawRemainder && sawNoEvidence);
    WIFIMETER_CHECK_EQ(bytes[0].rxBytes, std::uint64_t(101));
}
void resolvesProxyOwnersWithoutMixingPortsOrGuessing()
{
    const std::vector<ProxyProcess> processes{{10, "proxy-a", "a.exe"}, {11, "proxy-b", "b.exe"}, {20, "client-a", "browser.exe"}};
    auto first = client(20, 50000);
    auto second = client(20, 50001, 1080);
    auto report = proxyClientsFromTables({{7890, 1080}, {}}, {listener(10, 7890), listener(11, 1080), first, second}, processes);
    WIFIMETER_CHECK_EQ(report.observations.size(), std::size_t(2));
    if (report.observations.size() == 2)
    {
        WIFIMETER_CHECK_EQ(report.observations[0].proxyAppId, std::string("proxy-a"));
        WIFIMETER_CHECK_EQ(report.observations[1].proxyAppId, std::string("proxy-b"));
    }
    std::vector<ProxyTcpConnection> ambiguous{listener(10, 7890), listener(11, 7890), first};
    WIFIMETER_CHECK(proxyClientsFromTables({{7890}, {}}, ambiguous, processes).observations.empty());
    auto server = first;
    server.processId = 11;
    std::swap(server.localAddress, server.remoteAddress);
    std::swap(server.localPort, server.remotePort);
    ambiguous.push_back(server);
    report = proxyClientsFromTables({{7890}, {}}, ambiguous, processes);
    WIFIMETER_CHECK_EQ(report.observations.size(), std::size_t(1));
    if (!report.observations.empty()) WIFIMETER_CHECK_EQ(report.observations[0].proxyAppId, std::string("proxy-b"));
    WIFIMETER_CHECK(proxyClientsFromTables({{7890}, {}}, {listener(999, 7890), first}, processes).observations.empty());
    // 监听器已经消失，仍可由尚存的反向连接确定代理属主。
    WIFIMETER_CHECK_EQ(proxyClientsFromTables({{7890}, {}}, {server, first}, processes).observations.size(), std::size_t(1));
}

void exposesIdleListenersForPortOnlyConfiguration()
{
    const auto report = proxyClientsFromTables({{7890}, {}},
        {listener(10, 7890), listener(11, 7890), listener(999, 7890)},
        {{10, "proxy-path", "proxy.exe"}, {11, "proxy-path", "proxy.exe"}});
    WIFIMETER_CHECK(report.available);
    WIFIMETER_CHECK(report.observations.empty());
    WIFIMETER_CHECK_EQ(report.proxies.size(), std::size_t(3));
    if (report.proxies.size() != 3) return;
    WIFIMETER_CHECK_EQ(report.proxies[0].appId, std::string("proxy-path"));
    WIFIMETER_CHECK_EQ(report.proxies[1].processId, std::uint32_t(11));
    WIFIMETER_CHECK_EQ(report.proxies[2].processId, std::uint32_t(999));
    WIFIMETER_CHECK(report.proxies[2].appId.empty());
}

void supportsIpv6AndStableConnectionKeys()
{
    const std::vector<ProxyProcess> processes{{10, "proxy", "proxy.exe"}, {20, "client", "client.exe"}, {21, "CLIENT", "client.exe"}};
    auto ipv6 = client(20, 51000);
    ipv6.localAddress = ipv6.remoteAddress = "::1";
    auto duplicate = ipv6;
    duplicate.processId = 21;
    const auto report = proxyClientsFromTables({{7890}, {}}, {listener(10, 7890, "::"), ipv6, duplicate}, processes);
    WIFIMETER_CHECK_EQ(report.observations.size(), std::size_t(1));
    if (report.observations.empty()) return;
    WIFIMETER_CHECK_EQ(report.observations[0].connections, std::uint64_t(1));
    const auto next = proxyClientsFromTables({{7890}, {}}, {listener(10, 7890, "::"), ipv6}, processes);
    WIFIMETER_CHECK(report.observations[0].connectionKeys == next.observations[0].connectionKeys);
    WIFIMETER_CHECK(proxyClientsFromTables({{}, {"proxy"}}, {ipv6}, processes).observations.empty());
    WIFIMETER_CHECK(proxyClientsFromTables({{0}, {}}, {ipv6}, processes).status == ProxySampleStatus::disabled);
    // 非环回地址的监听器不能解释指向 loopback 的客户端。
    WIFIMETER_CHECK(proxyClientsFromTables({{7890}, {}}, {listener(10, 7890, "192.168.1.2"), client(20, 51000)}, processes).observations.empty());
}

void mergesClientWeightsAndKeepsUnknownShares()
{
    const auto rows = estimateProxyUsage("2026-10-01", {{"p", "Proxy", 11, 5}},
        {weight("p", "a", 1), weight("p", "A", 1), weight("p", "", 1), weight("p", "b", 0)});
    WIFIMETER_CHECK_EQ(rows.size(), std::size_t(2));
    if (rows.size() != 2) return;
    WIFIMETER_CHECK_EQ(rows[0].rxBytes, std::uint64_t(7));
    WIFIMETER_CHECK_EQ(rows[0].txBytes, std::uint64_t(3));
    WIFIMETER_CHECK(rows[1].unattributed);
    WIFIMETER_CHECK_EQ(rows[1].rxBytes, std::uint64_t(4));
    WIFIMETER_CHECK_EQ(rows[1].txBytes, std::uint64_t(2));
    WIFIMETER_CHECK(estimateProxyUsage("2026-10-01", {{"p", "Proxy", 0, 0}}, {}).empty());
    const auto self = estimateProxyUsage("2026-10-01", {{"p", "Proxy", 4, 9}}, {weight("p", "p", 100)});
    WIFIMETER_CHECK_EQ(self.size(), std::size_t(1));
    WIFIMETER_CHECK(self[0].unattributed);
}

void conservesFullWidthByteCounts()
{
    const auto maximum = std::numeric_limits<std::uint64_t>::max();
    const auto rows = estimateProxyUsage("2026-10-01", {{"p", "Proxy", maximum, maximum}}, {weight("p", "a", 1), weight("p", "b", 1)});
    WIFIMETER_CHECK_EQ(rows.size(), std::size_t(3));
    if (rows.size() != 3) return;
    WIFIMETER_CHECK_EQ(rows[0].rxBytes, maximum / 2);
    WIFIMETER_CHECK_EQ(rows[1].txBytes, maximum / 2);
    WIFIMETER_CHECK_EQ(rows[2].rxBytes, std::uint64_t(1));
    WIFIMETER_CHECK_EQ(rows[2].txBytes, std::uint64_t(1));
    const auto wideWeights = estimateProxyUsage("2026-10-01", {{"p", "Proxy", maximum, maximum}},
        {weight("p", "a", maximum - 1), weight("p", "b", 1)});
    WIFIMETER_CHECK_EQ(wideWeights.size(), std::size_t(2));
    WIFIMETER_CHECK_EQ(wideWeights[0].rxBytes, maximum - 1);
    WIFIMETER_CHECK_EQ(wideWeights[1].txBytes, std::uint64_t(1));
    const auto overflow = estimateProxyUsage("2026-10-01", {{"p", "Proxy", 3, 7}},
        {weight("p", "a", maximum), weight("p", "b", 1)});
    WIFIMETER_CHECK_EQ(overflow.size(), std::size_t(1));
    WIFIMETER_CHECK(overflow[0].unattributed);
    WIFIMETER_CHECK_EQ(overflow[0].rxBytes, std::uint64_t(3));
    WIFIMETER_CHECK_EQ(overflow[0].txBytes, std::uint64_t(7));
    // 用可直接相乘的小整数校验比例，而大整数边界由上面的具体例子覆盖。
    for (std::uint64_t bytes = 1; bytes < 100; bytes += 7)
    {
        const auto small = estimateProxyUsage("day", {{"p", "Proxy", bytes, bytes + 1}}, {weight("p", "a", 3), weight("p", "b", 4)});
        std::uint64_t rx = 0, tx = 0;
        for (const auto& row : small)
        {
            rx += row.rxBytes; tx += row.txBytes;
            if (row.appId == "a") WIFIMETER_CHECK_EQ(row.rxBytes, bytes * 3 / 7);
            if (row.appId == "b") WIFIMETER_CHECK_EQ(row.txBytes, (bytes + 1) * 4 / 7);
        }
        WIFIMETER_CHECK_EQ(rx, bytes);
        WIFIMETER_CHECK_EQ(tx, bytes + 1);
    }
}

void samplesTheNativeApiReadOnly()
{
    const auto empty = sampleProxyClients({});
    const auto native = sampleProxyClients({{7890, 1080, 65535}, {}});
#if defined(_WIN32)
    WIFIMETER_CHECK(empty.available);
    WIFIMETER_CHECK(empty.status == ProxySampleStatus::disabled);
    WIFIMETER_CHECK(native.available);
    WIFIMETER_CHECK(native.status == ProxySampleStatus::ready);
    if (!native.available) std::fprintf(stderr, "%s\n", native.detail.c_str());
    for (const auto& row : native.observations)
    {
        WIFIMETER_CHECK(!row.proxyAppId.empty() && !row.appId.empty());
        WIFIMETER_CHECK_EQ(row.connections, row.connectionKeys.size());
    }
#else
    WIFIMETER_CHECK(!empty.available && !native.available);
    WIFIMETER_CHECK(native.status == ProxySampleStatus::unsupported);
    WIFIMETER_CHECK(!native.detail.empty());
#endif
}

}  // namespace

int main()
{
    identifiesListenersAndDeduplicatesConnections();
    allocatesPerProxyAndPreservesRemainders();
    resolvesProxyOwnersWithoutMixingPortsOrGuessing();
    exposesIdleListenersForPortOnlyConfiguration();
    supportsIpv6AndStableConnectionKeys();
    mergesClientWeightsAndKeepsUnknownShares();
    conservesFullWidthByteCounts();
    samplesTheNativeApiReadOnly();
    return WIFIMETER_REPORT();
}
