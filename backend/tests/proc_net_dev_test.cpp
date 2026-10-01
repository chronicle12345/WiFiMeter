// /proc/net/dev 解析测试。样本取自真实内核输出，包含表头、隧道接口与无线网卡。

#include "../platform/linux/proc_net_dev.h"

#include <string>

#include "test_support.h"

using wifimeter::platform::linux::findInterfaceCounters;
using wifimeter::platform::linux::parseProcNetDev;
using wifimeter::platform::linux::readInterfaceCounters;

namespace
{

const char* kRealSample =
    "Inter-|   Receive                                                |  Transmit\n"
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n"
    "    lo: 1504492025 1783493    0    0    0     0          0         0 1504492025 1783493    0    0    0     0       0          0\n"
    "enp0s31f6: 2112168343 3013652    0 146520    0     0          0    223643 613096828 1940008    0    0    0     0       0          0\n"
    "wlx90de80299b57: 20498807   21313    0    0    0     0          0         0  1295246   18944    0    0    0     0       0          0\n";

void parsesRealKernelOutput()
{
    const auto counters = parseProcNetDev(kRealSample);
    WIFIMETER_CHECK_EQ(counters.size(), std::size_t{3});

    const auto loopback = findInterfaceCounters(counters, "lo");
    WIFIMETER_CHECK(loopback.has_value());
    WIFIMETER_CHECK_EQ(loopback->rxBytes, std::uint64_t{1504492025});
    WIFIMETER_CHECK_EQ(loopback->txBytes, std::uint64_t{1504492025});

    const auto wireless = findInterfaceCounters(counters, "wlx90de80299b57");
    WIFIMETER_CHECK(wireless.has_value());
    WIFIMETER_CHECK_EQ(wireless->rxBytes, std::uint64_t{20498807});
    WIFIMETER_CHECK_EQ(wireless->txBytes, std::uint64_t{1295246});
}

void skipsHeadersAndMalformedLines()
{
    const std::string text =
        "Inter-|   Receive                                                |  Transmit\n"
        " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n"
        "wlan0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n"
        "broken-without-colon 1 2 3\n"
        "short0: 1 2 3\n"
        "negative: -5 1 0 0 0 0 0 0 -6 2 0 0 0 0 0 0\n"
        "letters: abc 1 0 0 0 0 0 0 def 2 0 0 0 0 0 0\n"
        ": 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16\n";
    const auto counters = parseProcNetDev(text);
    WIFIMETER_CHECK_EQ(counters.size(), std::size_t{1});
    WIFIMETER_CHECK_EQ(counters.front().interfaceId, std::string("wlan0"));
    WIFIMETER_CHECK_EQ(counters.front().rxBytes, std::uint64_t{100});
    WIFIMETER_CHECK_EQ(counters.front().txBytes, std::uint64_t{200});
}

void keepsLastEntryAndAcceptsFullRange()
{
    const std::string text =
        "eth0: 1 0 0 0 0 0 0 0 2 0 0 0 0 0 0 0\n"
        "eth0: 18446744073709551615 0 0 0 0 0 0 0 18446744073709551615 0 0 0 0 0 0 0\n"
        "eth1: 1 0 0 0 0 0 0 0 18446744073709551616 0 0 0 0 0 0 0\n";
    const auto counters = parseProcNetDev(text);
    // eth1 的发送计数超出 uint64，整行被丢弃。
    WIFIMETER_CHECK_EQ(counters.size(), std::size_t{1});
    WIFIMETER_CHECK_EQ(counters.front().rxBytes, std::uint64_t{18446744073709551615ULL});
    WIFIMETER_CHECK_EQ(counters.front().txBytes, std::uint64_t{18446744073709551615ULL});
}

void handlesEmptyAndLineEndings()
{
    WIFIMETER_CHECK(parseProcNetDev("").empty());
    WIFIMETER_CHECK(parseProcNetDev("\n\n").empty());
    WIFIMETER_CHECK(parseProcNetDev("wlan0: 5 0 0 0 0 0 0 0 7 0 0 0 0 0 0 0").size() == 1);
    const auto noTrailingNewline = parseProcNetDev("wlan0: 5 0 0 0 0 0 0 0 7 0 0 0 0 0 0 0\r\nwlan1: 9 0 0 0 0 0 0 0 11 0 0 0 0 0 0 0\n");
    WIFIMETER_CHECK_EQ(noTrailingNewline.size(), std::size_t{2});
    WIFIMETER_CHECK_EQ(noTrailingNewline[1].txBytes, std::uint64_t{11});
}

void readsTheLiveFile()
{
    const auto counters = readInterfaceCounters("/proc/net/dev");
    WIFIMETER_CHECK(!counters.empty());
    WIFIMETER_CHECK(findInterfaceCounters(counters, "lo").has_value());
    WIFIMETER_CHECK(readInterfaceCounters("/nonexistent/proc/net/dev").empty());
}

}  // namespace

int main()
{
    parsesRealKernelOutput();
    skipsHeadersAndMalformedLines();
    keepsLastEntryAndAcceptsFullRange();
    handlesEmptyAndLineEndings();
    readsTheLiveFile();
    return WIFIMETER_REPORT();
}
