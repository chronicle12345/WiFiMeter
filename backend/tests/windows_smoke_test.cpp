// 真实 Windows 系统上的只读冒烟检查。
//
// Windows 的系统调用无法在 Linux 上执行（平台逻辑在 platform/windows 里已经用假数据覆盖），
// 因此这里在真实机器上确认几件只有真机才能回答的事：
//
//   * WLAN API 能返回适配器列表，且别名与 IP Helper 的别名是同一个字符串——两侧靠
//     NET_LUID 关联，这是采样能否把计数归属到网络的前提；
//   * IP Helper 的计数可用，且能找到无线网卡自己的那一行；
//   * 断开守卫：不存在的网卡只会得到“无需断开”，绝不会真的动系统状态。
//
// 所有调用都是只读的，因此可以在任何机器上安全运行；WLAN 服务未启动时按跳过处理，
// 而不是把“这台机器没有无线网卡/服务”当成失败。

#include <string>
#include <vector>

#include "../platform/win32/wlanapi_query.h"
#include "../platform/windows/windows_network_platform.h"
#include "test_support.h"

namespace platform = wifimeter::platform;
namespace win = wifimeter::platform::windows;

namespace
{

// 查询仍然来自真机；记录守卫本轮输入，并阻止测试在任何情况下执行真实断开。
class ReadOnlySystem final : public win::SystemApi
{
public:
    win::Win32System real;
    win::QueryResult<std::vector<win::WlanStatus>> wlan;
    win::QueryResult<std::vector<platform::WifiLink>> wired;
    int disconnectCalls = 0;

    win::QueryResult<std::vector<win::WlanStatus>> wlanStatuses() override
    {
        wlan = real.wlanStatuses();
        if (!wlan.ok())
        {
            WIFIMETER_CHECK(!wlan.failures.empty());
            for (const auto& failure : wlan.failures)
            {
                std::printf("WLAN: %s\n", failure.detail.c_str());
                WIFIMETER_CHECK(failure.kind == platform::FailureKind::unavailable);
            }
        }
        return wlan;
    }
    win::QueryResult<std::vector<platform::WifiLink>> ethernetLinks() override
    {
        wired = real.ethernetLinks();
        WIFIMETER_CHECK(wired.ok());
        WIFIMETER_CHECK(wired.failures.empty());
        return wired;
    }
    win::QueryResult<std::vector<win::InterfaceCounters>> interfaceCounters() override
    {
        const auto counters = real.interfaceCounters();
        WIFIMETER_CHECK(counters.ok());
        WIFIMETER_CHECK(counters.failures.empty());
        return counters;
    }
    win::DisconnectCommand requestDisconnect(const std::string&) override
    {
        ++disconnectCalls;
        WIFIMETER_CHECK(false);
        return {false, platform::FailureKind::commandFailed, "smoke forbids disconnect"};
    }
};

void checkGuard(ReadOnlySystem& system, win::WindowsNetworkPlatform& network,
    const std::string& interfaceId, const std::string& expectedSsid)
{
    const auto report = network.disconnectIfAssociated(interfaceId, expectedSsid);
    WIFIMETER_CHECK_EQ(system.disconnectCalls, 0);
    const bool hasWlan = system.wlan.ok() && !system.wlan.value->empty();
    const bool hasWired = system.wired.ok() && !system.wired.value->empty();
    auto expected = platform::DisconnectOutcome::notAssociated;
    if (!hasWlan && !hasWired && !system.wlan.failures.empty())
    {
        // 无线服务不可用且本轮没有任何链路时，才应返回 unavailable。
        WIFIMETER_CHECK(system.wlan.failures.front().kind == platform::FailureKind::unavailable);
        expected = platform::DisconnectOutcome::unavailable;
        WIFIMETER_CHECK_EQ(report.detail, system.wlan.failures.front().detail);
    }
    else if (system.wlan.ok())
    {
        const auto* status = win::findStatus(*system.wlan.value, interfaceId);
        if (status && win::identityOf(*status).associated())
        {
            WIFIMETER_CHECK(*status->ssid != expectedSsid);
            expected = platform::DisconnectOutcome::ssidMismatch;
        }
    }
    if (report.outcome != expected)
        std::printf("guard: actual=%d expected=%d wlan=%d wired=%d detail=%s\n",
            static_cast<int>(report.outcome), static_cast<int>(expected), hasWlan, hasWired, report.detail.c_str());
    WIFIMETER_CHECK(report.outcome == expected);
}

// Windows 接口别名不含 NUL，保证目标不存在，不依赖机器上的命名习惯。
const std::string missingDevice("wifimeter\0missing", 17);

bool hasFailure(const std::vector<platform::Failure>& failures, platform::FailureKind kind)
{
    for (const platform::Failure& failure : failures)
    {
        if (failure.kind == kind)
            return true;
    }
    return false;
}

void readsTheRealSystemWithoutSideEffects()
{
    ReadOnlySystem system;
    win::WindowsNetworkPlatform network(win::WindowsNetworkPlatform::Options{&system});

    const platform::LinkReport links = network.wirelessLinks();
    const bool wlanUnavailable = hasFailure(links.failures, platform::FailureKind::unavailable);
    if (wlanUnavailable)
    {
        // 这台机器没有运行 WLAN 服务（例如虚拟机、服务器或已禁用无线网卡）：
        // 计数与守卫检查仍然要过，适配器相关的断言跳过。
        std::printf("（跳过）WLAN 服务不可用，只检查计数与断开守卫。\n");
    }

    const win::QueryResult<std::vector<win::InterfaceCounters>> counters = system.interfaceCounters();
    WIFIMETER_CHECK(counters.ok());
    if (counters.ok())
    {
        for (const win::InterfaceCounters& entry : *counters.value)
            WIFIMETER_CHECK(!entry.interfaceId.empty());

        // 每张无线网卡的别名都必须能在计数里找到：找不到就意味着采样永远拿不到计数。
        for (const platform::WifiLink& link : links.links)
        {
            WIFIMETER_CHECK(!link.interfaceId.empty());
            WIFIMETER_CHECK(!link.adapterAlias.empty());
            // 展示名优先用驱动描述（媒体/型号），与 Linux 侧的厂商 + 产品名对应。
            WIFIMETER_CHECK(!link.adapterAlias.empty());
            if (link.signalPercent)
                WIFIMETER_CHECK(*link.signalPercent <= 100);
            WIFIMETER_CHECK(win::findInterfaceCounters(*counters.value, link.interfaceId).has_value());

            if (link.identity.associated())
            {
                // 已关联的网卡必须能一路报到“网络身份”这一层：
                // 没有 SSID 的样本无法归属流量，界面也显示不出网络名。
                WIFIMETER_CHECK(!link.identity.ssid->empty());
                WIFIMETER_CHECK_EQ(link.identity.profileName.empty(), false);
            }

            // 频段要么是 2.4 GHz，要么留空——5/6 GHz 的信道号与 2.4 GHz 重叠，
            // 仅凭信道号无法判断，因此平台宁可不报。这条断言防止将来“猜”出错误频段。
            if (link.frequencyMhz)
            {
                WIFIMETER_CHECK(*link.frequencyMhz >= 2400 && *link.frequencyMhz <= 2500);
                WIFIMETER_CHECK(link.band == platform::Band::ghz2_4);
            }
            else
            {
                WIFIMETER_CHECK(link.band == platform::Band::unknown);
            }
        }
    }

    // 守卫另读 WLAN + 有线状态，不能由先前仅含 WLAN 的结果推断。
    checkGuard(system, network, missingDevice, "not-a-network");

    // 采样必须只读：无线与有线样本都须有身份和对应计数。
    const platform::SampleReport samples = network.sampleWifi();
    for (const platform::WifiSample& sample : samples.samples)
    {
        WIFIMETER_CHECK(!sample.interfaceId.empty());
        WIFIMETER_CHECK(sample.identity.associated());
        // 样本里的计数必须能在这台机器的计数表里找到同一张网卡，
        // 否则累计出来的用量会一直为 0。
        if (counters.ok())
            WIFIMETER_CHECK(win::findInterfaceCounters(*counters.value, sample.interfaceId).has_value());
    }

    // 真实网卡的累计计数应当是一个合理的非零值：这台机器正在联网。
    for (const platform::WifiLink& link : links.links)
    {
        if (!counters.ok())
            continue;
        const auto counted = win::findInterfaceCounters(*counters.value, link.interfaceId);
        if (!counted)
            continue;
        WIFIMETER_CHECK(counted->txBytes > 0);
    }
}

// 断开守卫（真机版）：只有在“网卡确实关联着期望网络”时才允许断开。
//
// 这台机器可能正连着 Wi-Fi，因此这里刻意构造**不应该断开**的三种情况，
// 并断言它们被拒绝——绝不在真实网卡上执行断开。真正执行断开的路径由假数据用例覆盖
// （windows_platform_test 的 disconnectWaitsForStateToChange 等）。
void refusesDisconnectsOnRealAdapters()
{
    ReadOnlySystem system;
    win::WindowsNetworkPlatform network(win::WindowsNetworkPlatform::Options{&system});

    const platform::LinkReport links = network.wirelessLinks();
    checkGuard(system, network, missingDevice, "not-a-network");

    for (const platform::WifiLink& link : links.links)
    {
        // 1) 不存在的网卡：根据本轮查询判定未关联或服务不可用，不执行任何操作。
        checkGuard(system, network, missingDevice, "not-a-network");

        if (!link.identity.associated())
            continue;

        const std::string actual = link.identity.ssid.value_or(std::string{});
        WIFIMETER_CHECK(!actual.empty());

        // 2) 期望的网络与当前关联的不一致：必须拒绝，且绝不能调用 WlanDisconnect。
        // SSID 最长 32 字节，33 个 ASCII 字符保证即使切换网络也不会相等。
        checkGuard(system, network, link.interfaceId, std::string(33, 'x'));

        // 3) 期望空网络名同样不匹配（空值表示“未关联”，不该走到断开）。
        checkGuard(system, network, link.interfaceId, "");
    }

    // 守卫没有提交断开请求；后续样本仍须具有已关联身份。
    const platform::SampleReport samples = network.sampleWifi();
    for (const platform::WifiSample& sample : samples.samples)
        WIFIMETER_CHECK(sample.identity.associated());
}

// 别名一致性：平台直接拿 WLAN 的适配器描述作为展示名，接口标识必须与计数一致。
void interfaceIdentityIsStableAcrossCalls()
{
    ReadOnlySystem system;
    const win::QueryResult<std::vector<win::WlanStatus>> first = system.wlanStatuses();
    if (!first.ok())
    {
        std::printf("（跳过）WLAN 服务不可用，无法比对两次枚举。\n");
        return;
    }

    const win::QueryResult<std::vector<win::WlanStatus>> second = system.wlanStatuses();
    WIFIMETER_CHECK(second.ok());
    if (!second.ok())
        return;

    WIFIMETER_CHECK_EQ(first.value->size(), second.value->size());
    for (std::size_t index = 0; index < first.value->size() && index < second.value->size(); ++index)
    {
        WIFIMETER_CHECK_EQ((*first.value)[index].interfaceId, (*second.value)[index].interfaceId);
        WIFIMETER_CHECK_EQ((*first.value)[index].adapterAlias, (*second.value)[index].adapterAlias);
    }
}

}  // namespace

int main()
{
    readsTheRealSystemWithoutSideEffects();
    refusesDisconnectsOnRealAdapters();
    interfaceIdentityIsStableAcrossCalls();
    return WIFIMETER_REPORT();
}
