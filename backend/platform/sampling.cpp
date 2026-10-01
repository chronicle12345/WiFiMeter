#include "sampling.h"

#include <algorithm>

namespace wifimeter::platform
{

std::string ssidOfLink(const std::vector<WifiLink>& links, const std::string& interfaceId)
{
    for (const WifiLink& link : links)
    {
        if (link.interfaceId != interfaceId || link.identity.type != "wifi")
            continue;
        if (!link.identity.ssid)
            return {};
        return *link.identity.ssid;
    }
    return {};
}

namespace
{

bool isAssociated(const WifiLink& link)
{
    return link.identity.associated();
}

// 两次身份是否指向同一个网络：配置键与网络名任一变化都算换了网络。
bool sameIdentity(const NetworkIdentity& before, const NetworkIdentity& after)
{
    return before.type == after.type && before.profileUuid == after.profileUuid &&
        (before.type == "ethernet" || before.profileName == after.profileName) && before.ssid == after.ssid;
}

const WifiLink* findLink(const std::vector<WifiLink>& links, const std::string& interfaceId)
{
    const auto found = std::find_if(links.begin(), links.end(), [&interfaceId](const WifiLink& link) { return link.interfaceId == interfaceId; });
    return found == links.end() ? nullptr : &*found;
}

}  // namespace

LinkReport linksFrom(LinkSource& source)
{
    const LinkReadResult result = source.readLinks();
    LinkReport report;
    report.links = result.links;
    report.failures = result.failures;
    return report;
}

SampleReport sampleFrom(LinkSource& source)
{
    SampleReport report;
    const LinkReadResult before = source.readLinks();
    report.failures = before.failures;

    const bool anyAssociated = std::any_of(before.links.begin(), before.links.end(), isAssociated);

    // 没有已关联网卡：不读计数，也不报告失败（“未关联”不是错误）。
    const CounterReadResult counters = anyAssociated ? source.readCounters() : CounterReadResult{};
    // 计数整体读不到时仍然要把确认过的网卡状态报上去：界面要显示“连着但读不到计数”，
    // 而不是显示成没有网卡。因此这里只跳过样本，不提前返回。
    const bool countersAvailable = !anyAssociated || counters.failures.empty();
    report.failures.insert(report.failures.end(), counters.failures.begin(), counters.failures.end());

    LinkReadResult after;
    if (anyAssociated)
    {
        after = source.readLinks();
        report.failures.insert(report.failures.end(), after.failures.begin(), after.failures.end());
    }
    else
    {
        // 没有已关联网卡：直接把第一次读到的状态报上去，
        // 界面据此显示“有网卡但未连接”，而不是显示成没有网卡。
        after = before;
    }

    for (const WifiLink& link : before.links)
    {
        if (!isAssociated(link))
            continue;

        // 读取计数前后必须关联到同一个网络，否则这次样本无法可靠归属。
        const WifiLink* current = findLink(after.links, link.interfaceId);
        if (current == nullptr || !sameIdentity(link.identity, current->identity))
        {
            report.failures.push_back({FailureKind::inconsistent, link.interfaceId, "采样期间网络发生变化，已丢弃该样本。"});
            continue;
        }

        if (!countersAvailable)
            continue;  // 计数整体不可用：已经上报过失败，这里不再逐张网卡重复报

        const auto counted = fake::findCounters(counters.counters, link.interfaceId);
        if (!counted)
        {
            report.failures.push_back({FailureKind::countersMissing, link.interfaceId, "计数中没有这张网卡。"});
            continue;
        }

        WifiSample sample;
        sample.interfaceId = link.interfaceId;
        sample.identity = link.identity;
        sample.rxBytes = counted->rxBytes;
        sample.txBytes = counted->txBytes;
        report.samples.push_back(std::move(sample));
    }

    // 把确认过的网卡状态一并带回去，上层展示实时状态时不必再查一次系统。
    report.links = after.links;
    return report;
}

DisconnectOutcome decideDisconnect(std::string_view currentSsid, std::string_view expectedSsid)
{
    if (currentSsid.empty())
        return DisconnectOutcome::notAssociated;
    if (currentSsid != expectedSsid)
        return DisconnectOutcome::ssidMismatch;
    return DisconnectOutcome::disconnected;
}

}  // namespace wifimeter::platform
