// 平台层与业务规则的接缝测试：真实 LinuxNetworkPlatform 配上假的 /proc/net/dev、sysfs 与 nmcli，
// 走一遍“采样 → 累计 → 账本 → 额度”的完整链路。
//
// 这里覆盖的是两层之间的约定：平台给累计计数，core 负责差值、归属与失效判断。

#include <cstdlib>
#include <filesystem>
#include <map>
#include <string>

#include "../core/quota.h"
#include "../core/usage_accumulator.h"
#include "../platform/linux/linux_network_platform.h"
#include "test_support.h"

using namespace wifimeter::core;
using wifimeter::test::utcTime;

namespace platform = wifimeter::platform;
namespace linux_platform = wifimeter::platform::linux;
using wifimeter::test::TempDirectory;

namespace
{

namespace fs = std::filesystem;

// 假 nmcli：当前网络由 ssid.txt 与 uuid.txt 决定，状态固定为已激活。
const char* kFakeNmcli = R"SH(#!/bin/sh
dir="$WIFIMETER_FAKE_DIR"
ssid=$(cat "$dir/ssid.txt" 2>/dev/null)
uuid=$(cat "$dir/uuid.txt" 2>/dev/null)
case "$*" in
  *"dev show"*)
    printf 'GENERAL.DEVICE:wlan0\nGENERAL.TYPE:wifi\nGENERAL.STATE:100 (connected)\nGENERAL.CONNECTION:Profile\nGENERAL.CON-UUID:%s\nGENERAL.VENDOR:AICSemi\nGENERAL.PRODUCT:AIC8800DC\n\n' "$uuid"
    ;;
  *"802-11-wireless.ssid"*)
    printf '802-11-wireless.ssid:%s\n' "$ssid"
    ;;
  *"dev wifi list"*)
    printf '*:%s:77:5180 MHz\n' "$ssid"
    ;;
  *) exit 1 ;;
esac
exit 0
)SH";

struct FakeSystem
{
    TempDirectory directory{"integration"};
    std::string nmcli;
    std::string procNetDev;
    std::string sysClassNet;

    FakeSystem()
    {
        nmcli = directory.file("nmcli");
        wifimeter::test::writeFile(nmcli, kFakeNmcli, true);
        procNetDev = directory.file("dev");
        sysClassNet = directory.file("class-net");
        fs::create_directories(fs::path(sysClassNet) / "wlan0");
        wifimeter::test::writeFile((fs::path(sysClassNet) / "wlan0" / "phy80211").string(), "");
        wifimeter::test::writeFile((fs::path(sysClassNet) / "wlan0" / "operstate").string(), "up\n");
        ::setenv("WIFIMETER_FAKE_DIR", directory.path().c_str(), 1);
        setNetwork("uuid-1", "Home");
        setCounters(0, 0);
    }

    ~FakeSystem()
    {
        ::unsetenv("WIFIMETER_FAKE_DIR");
    }

    void setNetwork(const std::string& uuid, const std::string& ssid)
    {
        wifimeter::test::writeFile(directory.file("uuid.txt"), uuid + "\n");
        wifimeter::test::writeFile(directory.file("ssid.txt"), ssid + "\n");
    }

    void setCounters(ByteCount rx, ByteCount tx)
    {
        wifimeter::test::writeFile(procNetDev,
            "Inter-|   Receive                                                |  Transmit\n"
            " face |bytes    packets errs drop fifo frame compressed multicast|bytes    "
            "packets errs drop fifo colls carrier compressed\n"
            "wlan0: " +
                std::to_string(rx) + " 0 0 0 0 0 0 0 " + std::to_string(tx) + " 0 0 0 0 0 0 0\n");
    }

    linux_platform::LinuxNetworkPlatform::Options options() const
    {
        linux_platform::LinuxNetworkPlatform::Options options;
        options.procNetDevPath = procNetDev;
        options.sysClassNet = sysClassNet;
        options.nmcliExecutable = nmcli;
        options.commandTimeout = std::chrono::seconds(5);
        return options;
    }
};

void accumulatesSamplesIntoPerNetworkLedgers()
{
    FakeSystem system;
    linux_platform::LinuxNetworkPlatform platform(system.options());
    UsageAccumulator accumulator;
    std::map<std::string, QuotaLedger> ledgers;

    QuotaSettings settings;
    settings.period = QuotaPeriod::month;
    settings.capGb = 1.0;

    const auto sampleAt = [&](ByteCount rx, ByteCount tx, int second) {
        system.setCounters(rx, tx);
        const auto report = accumulator.accumulate(platform.sampleWifi(), utcTime(2026, 9, 29, 10, 0, second));
        for (const UsageDelta& delta : report.deltas)
            addToLedger(ledgers[delta.network.key], settings, delta.rxBytes + delta.txBytes, delta.at);
        return report;
    };

    // 第一次采样只建立基线：没有增量，也就还没有账本条目。
    const auto baseline = sampleAt(1000, 2000, 0);
    WIFIMETER_CHECK(baseline.deltas.empty());
    WIFIMETER_CHECK(ledgers.empty());

    // 正常累计：两次差值都进入 Home 的账本。
    sampleAt(1500, 2600, 5);
    sampleAt(2000, 3000, 10);
    WIFIMETER_CHECK_EQ(ledgers["uuid-1"].usedBytes, ByteCount{1100 + 900});
    WIFIMETER_CHECK_EQ(ledgers["uuid-1"].periodKey, std::string("2026-09"));

    // 计数回落：这段流量无法估算，不进入账本。
    const auto reset = sampleAt(10, 20, 15);
    WIFIMETER_CHECK(reset.deltas.empty());
    WIFIMETER_CHECK_EQ(ledgers["uuid-1"].usedBytes, ByteCount{2000});

    // 重建基线后继续累计。
    sampleAt(60, 100, 20);
    WIFIMETER_CHECK_EQ(ledgers["uuid-1"].usedBytes, ByteCount{2000 + 50 + 80});

    // 换网络：切换瞬间的流量不计入任何一边，之后归到新网络。
    system.setNetwork("uuid-2", "Office");
    const auto switched = sampleAt(100, 150, 25);
    WIFIMETER_CHECK(switched.deltas.empty());
    WIFIMETER_CHECK_EQ(ledgers["uuid-1"].usedBytes, ByteCount{2130});

    sampleAt(140, 200, 30);
    WIFIMETER_CHECK_EQ(ledgers["uuid-2"].usedBytes, ByteCount{40 + 50});
    WIFIMETER_CHECK_EQ(ledgers.size(), std::size_t{2});

    // 账本可以直接喂给额度状态。
    const QuotaState home = quotaStateOf(settings, ledgers["uuid-1"].usedBytes, utcTime(2026, 9, 29, 10, 0, 30));
    WIFIMETER_CHECK(home.limited);
    WIFIMETER_CHECK(!home.reachedWarn(80));
    WIFIMETER_CHECK_EQ(home.remainingBytes(), ByteCount{1000000000ULL - 2130});
}

void rollsTheLedgerOverAtTheMonthBoundary()
{
    wifimeter::test::useTimeZone("UTC");
    FakeSystem system;
    linux_platform::LinuxNetworkPlatform platform(system.options());
    UsageAccumulator accumulator;
    QuotaLedger ledger;

    QuotaSettings settings;
    settings.period = QuotaPeriod::month;

    system.setCounters(1000, 1000);
    accumulator.accumulate(platform.sampleWifi(), utcTime(2026, 9, 30, 23, 59, 50));

    system.setCounters(1400, 1400);
    for (const UsageDelta& delta : accumulator.accumulate(platform.sampleWifi(), utcTime(2026, 10, 1, 0, 0, 0)).deltas)
        addToLedger(ledger, settings, delta.rxBytes + delta.txBytes, delta.at);

    // 跨月后账本归零重记，跨月那一次增量算进新月份。
    WIFIMETER_CHECK_EQ(ledger.periodKey, std::string("2026-10"));
    WIFIMETER_CHECK_EQ(ledger.usedBytes, ByteCount{800});
}

}  // namespace

int main()
{
    accumulatesSamplesIntoPerNetworkLedgers();
    rollsTheLedgerOverAtTheMonthBoundary();
    return WIFIMETER_REPORT();
}
