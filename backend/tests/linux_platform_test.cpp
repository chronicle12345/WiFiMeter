// Linux 平台实现的组合测试。
//
// 用临时目录中的假 /proc/net/dev、假 sysfs 与假 nmcli 覆盖各条分支，
// 再对真实系统做只读冒烟检查。真实断开只在身份守卫通过时才可能发生，
// 因此对真实系统只断言“拒绝断开”的分支，不会改动机器的网络状态。

#include <cstdlib>
#include <filesystem>
#include <string>
#include <vector>

#include "../platform/linux/linux_network_platform.h"
#include "../platform/linux/proc_net_dev.h"
#include "test_support.h"

using namespace wifimeter::platform;
using namespace wifimeter::platform::linux;
using wifimeter::test::TempDirectory;

namespace
{

namespace fs = std::filesystem;

// 假 nmcli：行为由 WIFIMETER_FAKE_DIR 下的文件驱动。
//   ssids.txt       每个 dev show 调用依次取一行作为当前 SSID
//   state.txt       网卡状态码，缺省 100（已激活）
//   disconnected    出现该文件后 wlan0 报告为已断开（模拟断开生效）
//   sticky.txt      出现该文件时忽略 disconnected（模拟断开后立刻被重连）
//   step            调用计数，由脚本自身维护
//   disconnect.log  记录真正的断开调用
const char* kFakeNmcli = R"SH(#!/bin/sh
dir="$WIFIMETER_FAKE_DIR"
step_now() { cat "$dir/step" 2>/dev/null || echo 0; }
ssid_at() { sed -n "${1}p" "$dir/ssids.txt" 2>/dev/null; }
escape() { printf '%s' "$1" | sed 's/:/\\:/g'; }
case "$*" in
  *"dev show"*)
    step=$(( $(step_now) + 1 ))
    printf '%s' "$step" > "$dir/step"
    state=$(cat "$dir/state.txt" 2>/dev/null || echo 100)
    if [ -f "$dir/disconnected" ] && [ ! -f "$dir/sticky.txt" ]; then
      state=30
    fi
    if [ "$state" = "100" ]; then
      printf 'GENERAL.DEVICE:wlan0\nGENERAL.TYPE:wifi\nGENERAL.STATE:100 (connected)\nGENERAL.CONNECTION:Home Profile\nGENERAL.CON-UUID:uuid-1\nGENERAL.VENDOR:AICSemi\nGENERAL.PRODUCT:AIC8800DC\n\n'
    else
      printf 'GENERAL.DEVICE:wlan0\nGENERAL.TYPE:wifi\nGENERAL.STATE:%s (disconnected)\nGENERAL.CONNECTION:\nGENERAL.CON-UUID:\nGENERAL.VENDOR:AICSemi\nGENERAL.PRODUCT:AIC8800DC\n\n' "$state"
    fi
    printf 'GENERAL.DEVICE:wlan1\nGENERAL.TYPE:wifi\nGENERAL.STATE:30 (disconnected)\nGENERAL.CONNECTION:\nGENERAL.CON-UUID:\nGENERAL.VENDOR:Intel\nGENERAL.PRODUCT:Wi-Fi 6 AX200\n\n'
    printf 'GENERAL.DEVICE:eth0\nGENERAL.TYPE:ethernet\nGENERAL.STATE:100 (connected)\nGENERAL.CONNECTION:Wired\nGENERAL.CON-UUID:uuid-2\nGENERAL.VENDOR:Intel Corporation\nGENERAL.PRODUCT:Ethernet Connection I219-V\n\n'
    ;;
  *"802-11-wireless.ssid"*)
    printf '802-11-wireless.ssid:%s\n' "$(escape "$(ssid_at "$(step_now)")")"
    ;;
  *"dev wifi list"*)
    printf '*:%s:77:5180 MHz\n' "$(escape "$(ssid_at "$(step_now)")")"
    ;;
  *"dev disconnect"*)
    printf '%s\n' "$*" >> "$dir/disconnect.log"
    : > "$dir/disconnected"
    printf 'Device %s successfully disconnected.\n' "$4"
    ;;
  *) exit 1 ;;
esac
exit 0
)SH";

struct FakeSystem
{
    TempDirectory directory{"platform"};
    std::string nmcli;
    std::string procNetDev;
    std::string sysClassNet;

    FakeSystem()
    {
        nmcli = directory.file("nmcli");
        wifimeter::test::writeFile(nmcli, kFakeNmcli, true);
        procNetDev = directory.file("dev");
        wifimeter::test::writeFile(procNetDev,
            "Inter-|   Receive                                                |  Transmit\n"
            " face |bytes    packets errs drop fifo frame compressed multicast|bytes    "
            "packets errs drop fifo colls carrier compressed\n"
            "wlan0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n"
            "wlan1: 7 0 0 0 0 0 0 0 8 0 0 0 0 0 0 0\n"
            "eth0: 11 0 0 0 0 0 0 0 22 0 0 0 0 0 0 0\n");
        sysClassNet = directory.file("class-net");
        addInterface("wlan0", "up");
        addInterface("wlan1", "down");
        addInterface("eth0", "up");
        // 每次身份识别都会消费一行，默认给足同名行以保持连接不变。
        writeSsids(std::vector<std::string>(12, "Home"));
        ::setenv("WIFIMETER_FAKE_DIR", directory.path().c_str(), 1);
    }

    ~FakeSystem()
    {
        ::unsetenv("WIFIMETER_FAKE_DIR");
    }

    void addInterface(const std::string& name, const std::string& operstate, bool wireless = true)
    {
        const fs::path path = fs::path(sysClassNet) / name;
        fs::create_directories(path);
        if (wireless)
            wifimeter::test::writeFile((path / "phy80211").string(), "");
        wifimeter::test::writeFile((path / "operstate").string(), operstate + "\n");
    }

    void writeSsids(const std::vector<std::string>& ssids)
    {
        std::string content;
        for (const std::string& ssid : ssids)
            content += ssid + "\n";
        wifimeter::test::writeFile(directory.file("ssids.txt"), content);
    }

    void markSticky()
    {
        wifimeter::test::writeFile(directory.file("sticky.txt"), "");
    }

    std::string file(const std::string& name) const
    {
        return directory.file(name);
    }

    LinuxNetworkPlatform::Options options() const
    {
        LinuxNetworkPlatform::Options options;
        options.procNetDevPath = procNetDev;
        options.sysClassNet = sysClassNet;
        options.nmcliExecutable = nmcli;
        options.commandTimeout = std::chrono::seconds(5);
        return options;
    }
};

const WifiLink* linkOf(const LinkReport& report, const std::string& interfaceId)
{
    for (const WifiLink& link : report.links)
    {
        if (link.interfaceId == interfaceId)
            return &link;
    }
    return nullptr;
}

bool hasFailure(const std::vector<Failure>& failures, FailureKind kind, const std::string& interfaceId)
{
    for (const Failure& failure : failures)
    {
        if (failure.kind == kind && (interfaceId.empty() || failure.interfaceId == interfaceId))
            return true;
    }
    return false;
}

void reportsAssociatedAndUnassociatedInterfaces()
{
    FakeSystem system;
    LinuxNetworkPlatform platform(system.options());

    const LinkReport report = platform.wirelessLinks();
    WIFIMETER_CHECK_EQ(report.links.size(), std::size_t{2});  // 以太网卡不出现
    WIFIMETER_CHECK(report.complete());

    const WifiLink* associated = linkOf(report, "wlan0");
    WIFIMETER_CHECK(associated != nullptr);
    if (associated != nullptr)
    {
        WIFIMETER_CHECK(associated->identity.associated());
        WIFIMETER_CHECK_EQ(associated->identity.ssid.value_or(""), std::string("Home"));
        WIFIMETER_CHECK_EQ(associated->identity.profileName, std::string("Home Profile"));
        WIFIMETER_CHECK_EQ(associated->identity.profileUuid.value_or(""), std::string("uuid-1"));
        // 展示名称来自厂商与产品，而不是内核接口名。
        WIFIMETER_CHECK_EQ(associated->adapterAlias, std::string("AICSemi AIC8800DC"));
        WIFIMETER_CHECK_EQ(associated->signalPercent.value_or(-1), 77);
        WIFIMETER_CHECK_EQ(associated->frequencyMhz.value_or(-1), 5180);
        WIFIMETER_CHECK(associated->band == Band::ghz5);
    }

    // 未关联的网卡也要报告：上层据此区分“没有无线网卡”和“有网卡但未连接”。
    const WifiLink* idle = linkOf(report, "wlan1");
    WIFIMETER_CHECK(idle != nullptr);
    if (idle != nullptr)
    {
        WIFIMETER_CHECK(!idle->identity.associated());
        WIFIMETER_CHECK(!idle->identity.ssid.has_value());
        WIFIMETER_CHECK(!idle->signalPercent.has_value());
        WIFIMETER_CHECK_EQ(idle->adapterAlias, std::string("Intel Wi-Fi 6 AX200"));
        WIFIMETER_CHECK(idle->band == Band::unknown);
    }
}

void samplesOnlyAssociatedInterfaces()
{
    FakeSystem system;
    LinuxNetworkPlatform platform(system.options());

    const SampleReport report = platform.sampleWifi();
    WIFIMETER_CHECK_EQ(report.samples.size(), std::size_t{1});
    WIFIMETER_CHECK(report.complete());
    if (!report.samples.empty())
    {
        WIFIMETER_CHECK_EQ(report.samples[0].interfaceId, std::string("wlan0"));
        WIFIMETER_CHECK_EQ(report.samples[0].identity.ssid.value_or(""), std::string("Home"));
        WIFIMETER_CHECK_EQ(report.samples[0].identity.profileUuid.value_or(""), std::string("uuid-1"));
        WIFIMETER_CHECK_EQ(report.samples[0].rxBytes, std::uint64_t{1000});
        WIFIMETER_CHECK_EQ(report.samples[0].txBytes, std::uint64_t{2000});
    }
}

void reportsNothingWhenNoInterfaceIsAssociated()
{
    FakeSystem system;
    wifimeter::test::writeFile(system.file("state.txt"), "30\n");
    LinuxNetworkPlatform platform(system.options());

    const LinkReport links = platform.wirelessLinks();
    WIFIMETER_CHECK_EQ(links.links.size(), std::size_t{2});
    WIFIMETER_CHECK(links.complete());
    for (const WifiLink& link : links.links)
        WIFIMETER_CHECK(!link.identity.associated());

    const SampleReport samples = platform.sampleWifi();
    WIFIMETER_CHECK(samples.samples.empty());
    WIFIMETER_CHECK(samples.complete());  // 没有连接不算失败
}

void discardsSamplesWhenTheNetworkChanges()
{
    FakeSystem system;
    // 第一次身份识别是 Home，读取计数后的第二次识别变成 Other：样本不能归属。
    system.writeSsids({"Home", "Other"});
    LinuxNetworkPlatform platform(system.options());

    const SampleReport report = platform.sampleWifi();
    WIFIMETER_CHECK(report.samples.empty());
    WIFIMETER_CHECK(hasFailure(report.failures, FailureKind::inconsistent, "wlan0"));
}

void reportsMissingCounters()
{
    FakeSystem system;
    // 计数文件里没有这张网卡，样本缺失必须上报而不是当作 0。
    wifimeter::test::writeFile(system.procNetDev,
        "Inter-|   Receive                                                |  Transmit\n"
        " face |bytes    packets errs drop fifo frame compressed multicast|bytes    "
        "packets errs drop fifo colls carrier compressed\n"
        "eth0: 11 0 0 0 0 0 0 0 22 0 0 0 0 0 0 0\n");
    LinuxNetworkPlatform platform(system.options());

    const SampleReport report = platform.sampleWifi();
    WIFIMETER_CHECK(report.samples.empty());
    WIFIMETER_CHECK(hasFailure(report.failures, FailureKind::countersMissing, "wlan0"));
}

void reportsInconsistentKernelState()
{
    FakeSystem system;
    // 内核说链路已断开，连接管理器却说已激活：身份不可靠，本轮不报告该网卡。
    system.addInterface("wlan0", "down");
    LinuxNetworkPlatform platform(system.options());

    const LinkReport report = platform.wirelessLinks();
    WIFIMETER_CHECK(linkOf(report, "wlan0") == nullptr);
    WIFIMETER_CHECK(hasFailure(report.failures, FailureKind::inconsistent, "wlan0"));
    WIFIMETER_CHECK(linkOf(report, "wlan1") != nullptr);
}

void reportsMissingDependency()
{
    FakeSystem system;
    LinuxNetworkPlatform::Options options = system.options();
    options.nmcliExecutable = system.file("no-such-nmcli");
    LinuxNetworkPlatform platform(options);

    const LinkReport links = platform.wirelessLinks();
    WIFIMETER_CHECK(links.links.empty());
    WIFIMETER_CHECK(hasFailure(links.failures, FailureKind::unavailable, ""));

    const SampleReport samples = platform.sampleWifi();
    WIFIMETER_CHECK(samples.samples.empty());
    WIFIMETER_CHECK(hasFailure(samples.failures, FailureKind::unavailable, ""));
}

void preservesUserDataAcrossTheProcessBoundary()
{
    FakeSystem system;
    // SSID 是 UTF-8 用户数据，可能含非 ASCII 字符与冒号；nmcli 会把冒号写成 \:。
    const std::string ssid = "咖啡店:Café";
    system.writeSsids(std::vector<std::string>(12, ssid));
    LinuxNetworkPlatform platform(system.options());

    const LinkReport links = platform.wirelessLinks();
    const WifiLink* link = linkOf(links, "wlan0");
    WIFIMETER_CHECK(link != nullptr);
    if (link != nullptr)
        WIFIMETER_CHECK_EQ(link->identity.ssid.value_or(""), ssid);

    const SampleReport samples = platform.sampleWifi();
    WIFIMETER_CHECK_EQ(samples.samples.size(), std::size_t{1});
    if (!samples.samples.empty())
        WIFIMETER_CHECK_EQ(samples.samples[0].identity.ssid.value_or(""), ssid);
}

void refusesMismatchedDisconnectAndAllowsTheMatch()
{
    FakeSystem system;
    LinuxNetworkPlatform platform(system.options());
    const std::string log = system.file("disconnect.log");

    const DisconnectReport mismatch = platform.disconnectIfAssociated("wlan0", "Other");
    WIFIMETER_CHECK(mismatch.outcome == DisconnectOutcome::ssidMismatch);
    WIFIMETER_CHECK(!fs::exists(log));

    const DisconnectReport unknownInterface = platform.disconnectIfAssociated("wlan9", "Home");
    WIFIMETER_CHECK(unknownInterface.outcome == DisconnectOutcome::notAssociated);
    WIFIMETER_CHECK(!fs::exists(log));

    const DisconnectReport matched = platform.disconnectIfAssociated("wlan0", "Home");
    WIFIMETER_CHECK(matched.outcome == DisconnectOutcome::disconnected);
    WIFIMETER_CHECK(wifimeter::test::readFile(log).find("dev disconnect wlan0") != std::string::npos);
}

void detectsReconnectionAfterDisconnect()
{
    FakeSystem system;
    system.markSticky();  // 断开后立刻被重连
    LinuxNetworkPlatform platform(system.options());

    const DisconnectReport report = platform.disconnectIfAssociated("wlan0", "Home");
    WIFIMETER_CHECK(report.outcome == DisconnectOutcome::stillAssociated);
}

void readsTheRealSystemWithoutSideEffects()
{
    LinuxNetworkPlatform platform;
    const LinkReport links = platform.wirelessLinks();
    for (const WifiLink& link : links.links)
    {
        WIFIMETER_CHECK(!link.interfaceId.empty());
        WIFIMETER_CHECK(!link.adapterAlias.empty());
        if (link.signalPercent)
            WIFIMETER_CHECK(*link.signalPercent <= 100);
        if (link.frequencyMhz)
            WIFIMETER_CHECK(link.band != Band::unknown);
    }

    const SampleReport samples = platform.sampleWifi();
    for (const WifiSample& sample : samples.samples)
    {
        WIFIMETER_CHECK(!sample.interfaceId.empty());
        WIFIMETER_CHECK(sample.identity.associated());
        WIFIMETER_CHECK(findInterfaceCounters(readInterfaceCounters(), sample.interfaceId).has_value());
    }

    // 真实系统上的守卫检查：不存在的网卡当前 SSID 为空，只能得到“无需断开”，绝不执行断开。
    const DisconnectReport report = platform.disconnectIfAssociated("wifimeter-not-a-device", "not-a-network");
    WIFIMETER_CHECK(report.outcome == DisconnectOutcome::notAssociated);
}

}  // namespace

int main()
{
    reportsAssociatedAndUnassociatedInterfaces();
    samplesOnlyAssociatedInterfaces();
    reportsNothingWhenNoInterfaceIsAssociated();
    discardsSamplesWhenTheNetworkChanges();
    reportsMissingCounters();
    reportsInconsistentKernelState();
    reportsMissingDependency();
    preservesUserDataAcrossTheProcessBoundary();
    refusesMismatchedDisconnectAndAllowsTheMatch();
    detectsReconnectionAfterDisconnect();
    readsTheRealSystemWithoutSideEffects();
    return WIFIMETER_REPORT();
}
