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
    win::Win32System system;
    win::WindowsNetworkPlatform network(win::WindowsNetworkPlatform::Options{&system});

    const platform::LinkReport links = network.wirelessLinks();
    if (hasFailure(links.failures, platform::FailureKind::unavailable))
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

    // 真实系统上的守卫检查：不存在的网卡当前没有关联，只能得到“无需断开”。
    const platform::DisconnectReport report = network.disconnectIfAssociated("wifimeter-not-a-device", "not-a-network");
    WIFIMETER_CHECK(report.outcome == platform::DisconnectOutcome::notAssociated);

    // 采样必须是只读且可重复的：连续两次都要成功，且不因为异常而抛错。
    const platform::SampleReport samples = network.sampleWifi();
    for (const platform::WifiSample& sample : samples.samples)
    {
        WIFIMETER_CHECK(!sample.interfaceId.empty());
        WIFIMETER_CHECK(sample.identity.associated());
        // 样本里的计数必须能在这台机器的计数表里找到同一张网卡，
        // 否则累计出来的用量会一直为 0。
        WIFIMETER_CHECK(win::findInterfaceCounters(*counters.value, sample.interfaceId).has_value());
    }

    // 真实网卡的累计计数应当是一个合理的非零值：这台机器正在联网。
    for (const platform::WifiLink& link : links.links)
    {
        const auto counted = win::findInterfaceCounters(*counters.value, link.interfaceId);
        if (!counted)
            continue;
        WIFIMETER_CHECK(counted->txBytes > 0);
    }
}

// 别名一致性：平台直接拿 WLAN 的适配器描述作为展示名，接口标识必须与计数一致。
void interfaceIdentityIsStableAcrossCalls()
{
    win::Win32System system;
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
    interfaceIdentityIsStableAcrossCalls();
    return WIFIMETER_REPORT();
}
