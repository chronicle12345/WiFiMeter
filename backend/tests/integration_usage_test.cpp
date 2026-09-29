// 平台层与业务规则的接缝测试（Linux）：真实 LinuxNetworkPlatform 配上假的
// /proc/net/dev、sysfs 与 nmcli，走一遍“采样 → 累计 → 账本 → 额度”的完整链路。
//
// 采样序列与断言在 integration_sampling_support.h 里，与 Windows 侧共用同一份；
// 这里只提供 Linux 的驱动：改假文件就等于换网络、改计数。

#include <cstdlib>
#include <filesystem>
#include <string>

#include "../core/network_key.h"
#include "../platform/linux/linux_network_platform.h"
#include "integration_sampling_support.h"
#include "test_support.h"

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

// Linux 侧的网络键来自配置 UUID，因此两个网络用两个不同的 UUID。
struct LinuxDriver final : wifimeter::test::SamplingDriver<linux_platform::LinuxNetworkPlatform>
{
    TempDirectory directory{"integration-linux"};
    std::string nmcli;
    std::string procNetDev;
    std::string sysClassNet;
    linux_platform::LinuxNetworkPlatform platform;

    LinuxDriver()
        : nmcli(directory.file("nmcli")),
          procNetDev(directory.file("dev")),
          sysClassNet(directory.file("class-net")),
          platform(options())
    {
        wifimeter::test::writeFile(nmcli, kFakeNmcli, true);
        fs::create_directories(fs::path(sysClassNet) / "wlan0");
        wifimeter::test::writeFile((fs::path(sysClassNet) / "wlan0" / "phy80211").string(), "");
        wifimeter::test::writeFile((fs::path(sysClassNet) / "wlan0" / "operstate").string(), "up\n");
        ::setenv("WIFIMETER_FAKE_DIR", directory.path().c_str(), 1);

        homeKey = wifimeter::core::networkRefOf(identityOf("uuid-1", "Home")).key;
        officeKey = wifimeter::core::networkRefOf(identityOf("uuid-2", "Office")).key;
        switchNetwork(homeKey, "Home");
        setCounters(0, 0);
    }

    ~LinuxDriver() override
    {
        ::unsetenv("WIFIMETER_FAKE_DIR");
    }

    static wifimeter::platform::NetworkIdentity identityOf(const std::string& uuid, const std::string& ssid)
    {
        wifimeter::platform::NetworkIdentity identity;
        identity.profileUuid = uuid;
        identity.profileName = ssid;
        identity.ssid = ssid;
        return identity;
    }

    void switchNetwork(const std::string& key, const std::string& ssid) override
    {
        // 键与 UUID 一一对应：Home → uuid-1，Office → uuid-2。
        const std::string uuid = key == officeKey ? "uuid-2" : "uuid-1";
        wifimeter::test::writeFile(directory.file("uuid.txt"), uuid + "\n");
        wifimeter::test::writeFile(directory.file("ssid.txt"), ssid + "\n");
    }

    void setCounters(wifimeter::core::ByteCount rx, wifimeter::core::ByteCount tx) override
    {
        wifimeter::test::writeFile(procNetDev,
            "Inter-|   Receive                                                |  Transmit\n"
            " face |bytes    packets errs drop fifo frame compressed multicast|bytes    "
            "packets errs drop fifo colls carrier compressed\n"
            "wlan0: " +
                std::to_string(rx) + " 0 0 0 0 0 0 0 " + std::to_string(tx) + " 0 0 0 0 0 0 0\n");
    }

    wifimeter::platform::SampleReport sample() override
    {
        return platform.sampleWifi();
    }

    linux_platform::LinuxNetworkPlatform::Options options() const
    {
        linux_platform::LinuxNetworkPlatform::Options value;
        value.procNetDevPath = procNetDev;
        value.sysClassNet = sysClassNet;
        value.nmcliExecutable = nmcli;
        value.commandTimeout = std::chrono::seconds(5);
        return value;
    }
};

void accumulatesSamplesIntoPerNetworkLedgers()
{
    LinuxDriver driver;
    wifimeter::test::runSamplingIntegration(driver);
}

void rollsTheLedgerOverAtTheMonthBoundary()
{
    LinuxDriver driver;
    wifimeter::test::runLedgerRollover(driver);
}

}  // namespace

int main()
{
    accumulatesSamplesIntoPerNetworkLedgers();
    rollsTheLedgerOverAtTheMonthBoundary();
    return WIFIMETER_REPORT();
}
