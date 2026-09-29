// 接口计数测试：用构造的 MIB_IF_ROW2 行验证转换规则，不依赖真实网卡。
//
// 覆盖中文网卡名（例如“无线网卡”）、缺名称时用索引兜底、只保留无线网卡，
// 以及超过 2^32 的计数器不被截断。

#include "../platform/windows/interface_counters.h"

#include <cstdint>
#include <string>
#include <vector>

#include "test_support.h"
#include "windows_test_support.h"

using namespace wifimeter::platform::windows;
using wifimeter::test::windows_support::utf16;

namespace
{

RawInterfaceRow wifiRow(const std::string& alias, std::uint64_t rx, std::uint64_t tx, std::size_t index = 1)
{
    RawInterfaceRow row;
    row.alias = utf16(alias);
    row.description = utf16("Intel(R) Wi-Fi 6 AX201 160MHz");
    row.index = index;
    row.type = kIeee80211InterfaceType;
    row.rxBytes = rx;
    row.txBytes = tx;
    return row;
}

RawInterfaceRow ethernetRow(const std::string& alias, std::uint64_t rx, std::uint64_t tx, std::size_t index = 2)
{
    RawInterfaceRow row;
    row.alias = utf16(alias);
    row.description = utf16("Realtek PCIe GbE Family Controller");
    row.index = index;
    row.type = 6;  // IF_TYPE_ETHERNET_CSMACD
    row.rxBytes = rx;
    row.txBytes = tx;
    return row;
}

void keepsAllInterfaces()
{
    const std::vector<RawInterfaceRow> rows{ethernetRow("以太网", 100, 200), wifiRow("WLAN", 3000, 4000)};
    const std::vector<InterfaceCounters> counters = countersFromRows(rows);
    WIFIMETER_CHECK_EQ(counters.size(), std::size_t(2));
    WIFIMETER_CHECK_EQ(counters[0].interfaceId, std::string("以太网"));
    WIFIMETER_CHECK_EQ(counters[0].rxBytes, std::uint64_t(100));
    WIFIMETER_CHECK_EQ(counters[1].interfaceId, std::string("WLAN"));
    WIFIMETER_CHECK_EQ(counters[1].txBytes, std::uint64_t(4000));
}

void keepsWirelessOnly()
{
    const std::vector<RawInterfaceRow> rows{ethernetRow("Ethernet", 1, 2), wifiRow("WLAN", 3, 4), wifiRow("WLAN 2", 5, 6, 3)};
    const std::vector<InterfaceCounters> counters = wifiCountersFromRows(rows);
    WIFIMETER_CHECK_EQ(counters.size(), std::size_t(2));
    WIFIMETER_CHECK_EQ(counters[0].interfaceId, std::string("WLAN"));
    WIFIMETER_CHECK_EQ(counters[1].interfaceId, std::string("WLAN 2"));
}

void fallsBackToIndexWhenAliasMissing()
{
    const RawInterfaceRow row = wifiRow("", 7, 8, 12);
    const std::vector<InterfaceCounters> counters = countersFromRows({row});
    WIFIMETER_CHECK_EQ(counters.size(), std::size_t(1));
    WIFIMETER_CHECK_EQ(counters[0].interfaceId, std::string("if12"));
    WIFIMETER_CHECK_EQ(counters[0].rxBytes, std::uint64_t(7));
}

void convertsNonAsciiAlias()
{
    // 别名含非 ASCII 字符时必须按 UTF-8 输出，而不是本地代码页。
    const std::vector<InterfaceCounters> counters = countersFromRows({wifiRow("无线网卡", 1, 2)});
    WIFIMETER_CHECK_EQ(counters[0].interfaceId, std::string("\xE6\x97\xA0\xE7\xBA\xBF\xE7\xBD\x91\xE5\x8D\xA1"));
}

void keepsWindowsAliasWithSpaces()
{
    // Windows 上同一台机器可以有多张无线网卡，名称形如 "WLAN"、"WLAN 2"。
    const std::vector<InterfaceCounters> counters = wifiCountersFromRows({wifiRow("WLAN", 11, 12), wifiRow("WLAN 2", 13, 14, 5)});
    WIFIMETER_CHECK_EQ(counters.size(), std::size_t(2));
    const auto found = findInterfaceCounters(counters, "WLAN 2");
    WIFIMETER_CHECK(found.has_value());
    WIFIMETER_CHECK_EQ(found->rxBytes, std::uint64_t(13));
    WIFIMETER_CHECK_EQ(found->txBytes, std::uint64_t(14));
    WIFIMETER_CHECK(!findInterfaceCounters(counters, "WLAN 3").has_value());
}

void handlesEmptyList()
{
    WIFIMETER_CHECK(countersFromRows({}).empty());
    WIFIMETER_CHECK(wifiCountersFromRows({}).empty());
}

void keepsFullSixtyFourBitRange()
{
    // IPv6 的计数器可以超过 2^32；转换不能截断成 32 位。
    const std::uint64_t big = 0x100000001ULL;
    const std::vector<InterfaceCounters> counters = countersFromRows({wifiRow("WLAN", big, big + 1)});
    WIFIMETER_CHECK_EQ(counters[0].rxBytes, big);
    WIFIMETER_CHECK_EQ(counters[0].txBytes, big + 1);
}

}  // namespace

int main()
{
    keepsAllInterfaces();
    keepsWirelessOnly();
    fallsBackToIndexWhenAliasMissing();
    convertsNonAsciiAlias();
    keepsWindowsAliasWithSpaces();
    handlesEmptyList();
    keepsFullSixtyFourBitRange();
    return WIFIMETER_REPORT();
}
