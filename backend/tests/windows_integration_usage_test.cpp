// 平台层与业务规则的接缝测试（Windows）：真实 WindowsNetworkPlatform 配上假的 SystemApi，
// 走一遍“采样 → 累计 → 账本 → 额度”的完整链路。
//
// 采样序列与断言在 integration_sampling_support.h 里，与 Linux 侧完全共用；
// 这里只提供 Windows 的驱动：换网络就是换 WLAN 状态，改计数就是改 IP Helper 的计数。
//
// 覆盖的是 Windows 特有的那部分语义：
//
//   * 网络键来自 SSID 散列（配置名不满足快照 network.id 的字符集，平台层不编造键）；
//   * 采样要读两次状态，期间身份变化就丢弃样本；
//   * 计数来自 IP Helper 的累计值，回落同样交给 core 判断。

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "../core/network_key.h"
#include "../platform/windows/system_api.h"
#include "../platform/windows/windows_network_platform.h"
#include "integration_sampling_support.h"
#include "test_support.h"

namespace win = wifimeter::platform::windows;

namespace
{

// 假的系统：当前网络与计数都由测试驱动。
class FakeSystem final : public win::SystemApi
{
public:
    std::string interfaceId = "WLAN";
    std::string ssid = "Home";
    std::string profileName = "Home";
    std::uint64_t rx = 0;
    std::uint64_t tx = 0;

    win::QueryResult<std::vector<win::WlanStatus>> wlanStatuses() override
    {
        win::WlanStatus status;
        status.interfaceId = interfaceId;
        status.adapterAlias = "Intel(R) Wi-Fi 6 AX201 160MHz";
        status.connected = true;
        status.mode = win::ConnectionMode::profile;
        status.profileName = profileName;
        status.ssid = ssid;
        status.signalPercent = 80;
        return win::QueryResult<std::vector<win::WlanStatus>>::success({status});
    }

    win::QueryResult<std::vector<win::InterfaceCounters>> interfaceCounters() override
    {
        win::InterfaceCounters counters;
        counters.interfaceId = interfaceId;
        counters.rxBytes = rx;
        counters.txBytes = tx;
        return win::QueryResult<std::vector<win::InterfaceCounters>>::success({counters});
    }

    win::DisconnectCommand requestDisconnect(const std::string&) override
    {
        return {};
    }

};

struct WindowsDriver final : wifimeter::test::SamplingDriver<win::WindowsNetworkPlatform>
{
    FakeSystem system;
    win::WindowsNetworkPlatform platform;

    WindowsDriver()
        : platform(options())
    {
        // Windows 没有可用的配置 UUID，键由 SSID 派生；配置名只是展示与稳定性判断用。
        homeKey = wifimeter::core::networkRefOf(identityOf("Home")).key;
        officeKey = wifimeter::core::networkRefOf(identityOf("Office")).key;
        switchNetwork(homeKey, "Home");
    }

    static wifimeter::platform::NetworkIdentity identityOf(const std::string& ssid)
    {
        wifimeter::platform::NetworkIdentity identity;
        identity.profileName = ssid;
        identity.ssid = ssid;
        return identity;
    }

    void switchNetwork(const std::string& key, const std::string& ssid) override
    {
        // 只换身份，不动计数：这样切换瞬间的处理（丢弃样本、重新归属）才是被测的对象。
        // 计数随网卡重载而回落的场景由共享序列里的“计数回落”覆盖。
        (void)key;
        system.ssid = ssid;
        system.profileName = ssid;
    }

    void setCounters(wifimeter::core::ByteCount rx, wifimeter::core::ByteCount tx) override
    {
        system.rx = rx;
        system.tx = tx;
    }

    wifimeter::platform::SampleReport sample() override
    {
        return platform.sampleWifi();
    }

    win::WindowsNetworkPlatform::Options options()
    {
        win::WindowsNetworkPlatform::Options value;
        value.system = &system;
        return value;
    }
};

void accumulatesSamplesIntoPerNetworkLedgers()
{
    WindowsDriver driver;
    wifimeter::test::runSamplingIntegration(driver);
}

void rollsTheLedgerOverAtTheMonthBoundary()
{
    WindowsDriver driver;
    wifimeter::test::runLedgerRollover(driver);
}

// 键的形状：Windows 的键必须满足快照 network.id 的字符集约束，且同名网络稳定。
void keysAreStableAndSnapshotSafe()
{
    const std::string first = wifimeter::core::networkRefOf(WindowsDriver::identityOf("家里的 Wi-Fi")).key;
    const std::string second = wifimeter::core::networkRefOf(WindowsDriver::identityOf("家里的 Wi-Fi")).key;
    WIFIMETER_CHECK_EQ(first, second);
    WIFIMETER_CHECK(wifimeter::core::isValidNetworkKey(first));
    WIFIMETER_CHECK(first.rfind("ssid_", 0) == 0);
    // 不同 SSID 必须落到不同的键。
    WIFIMETER_CHECK(first != wifimeter::core::networkRefOf(WindowsDriver::identityOf("Office")).key);
}

void ethernetKeysStaySeparateFromWifiNames()
{
    auto row = win::RawInterfaceRow{};
    row.alias = u"Ethernet";
    row.type = 6;
    row.hardware = true;
    row.up = true;
    row.guid = "00112233-4455-6677-8899-aabbccddeeff";
    const auto first = win::ethernetLinksFromRows({row})[0].identity;
    row.alias = u"Renamed cable";
    row.index = 42;
    const auto second = win::ethernetLinksFromRows({row})[0].identity;
    const auto key = wifimeter::core::networkRefOf(first).key;
    WIFIMETER_CHECK(wifimeter::core::isValidNetworkKey(key));
    WIFIMETER_CHECK_EQ(wifimeter::core::networkRefOf(second).key, key);
    WIFIMETER_CHECK(key != wifimeter::core::networkRefOf(WindowsDriver::identityOf(*first.ssid)).key);

    wifimeter::core::UsageAccumulator accumulator;
    wifimeter::platform::SampleReport report;
    report.samples.push_back({"Ethernet", first, 100, 200});
    accumulator.accumulate(report, wifimeter::test::utcTime(2026, 10, 1, 0, 0, 0));
    report.samples[0].identity = second;
    report.samples[0].rxBytes = 140;
    report.samples[0].txBytes = 260;
    const auto result = accumulator.accumulate(report, wifimeter::test::utcTime(2026, 10, 1, 0, 0, 5));
    WIFIMETER_CHECK_EQ(result.deltas.size(), std::size_t(1));
    if (!result.deltas.empty())
    {
        WIFIMETER_CHECK_EQ(result.deltas[0].network.key, key);
        WIFIMETER_CHECK_EQ(result.deltas[0].network.type, std::string("ethernet"));
        WIFIMETER_CHECK_EQ(result.deltas[0].rxBytes + result.deltas[0].txBytes, std::uint64_t(100));
    }
}

}  // namespace

int main()
{
    accumulatesSamplesIntoPerNetworkLedgers();
    rollsTheLedgerOverAtTheMonthBoundary();
    keysAreStableAndSnapshotSafe();
    ethernetKeysStaySeparateFromWifiNames();
    return WIFIMETER_REPORT();
}
