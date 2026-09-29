#include "windows_network_platform.h"

#include <algorithm>
#include <optional>
#include <thread>
#include <utility>

namespace wifimeter::platform::windows
{
namespace
{

// 已关联时返回网络名，未关联或身份缺失时返回空字符串。
std::string ssidOf(const WlanStatus* status)
{
    if (status == nullptr || !status->ssid)
        return {};
    return *status->ssid;
}

bool sameIdentity(const WlanStatus& before, const WlanStatus& after)
{
    // 配置名与 SSID 任一变化都算换了网络：同一份配置也可能匹配到不同 SSID。
    return before.profileName == after.profileName && before.ssid == after.ssid;
}

}  // namespace

WindowsNetworkPlatform::WindowsNetworkPlatform(Options options)
    : options_(std::move(options))
{
    if (!options_.wait)
        options_.wait = [](std::chrono::milliseconds duration) { std::this_thread::sleep_for(duration); };
}

QueryResult<std::vector<WlanStatus>> WindowsNetworkPlatform::readStatuses()
{
    return options_.system->wlanStatuses();
}

LinkReport WindowsNetworkPlatform::linksFrom(const std::vector<WlanStatus>& statuses)
{
    LinkReport report;
    report.links.reserve(statuses.size());
    for (const WlanStatus& status : statuses)
    {
        WifiLink link;
        link.interfaceId = status.interfaceId;
        link.adapterAlias = status.adapterAlias.empty() ? status.interfaceId : status.adapterAlias;
        link.identity = identityOf(status);
        link.signalPercent = status.signalPercent;
        link.frequencyMhz = status.frequencyMhz;
        if (link.frequencyMhz)
            link.band = classifyBand(*link.frequencyMhz);
        // 频段只在能确定频率时才有值：5/6 GHz 的信道号与 2.4 GHz 重叠，
        // 仅凭信道号推断会给出错误的频段，因此那两种情况留空显示“未知”。
        report.links.push_back(std::move(link));
    }
    return report;
}

LinkReport WindowsNetworkPlatform::wirelessLinks()
{
    const QueryResult<std::vector<WlanStatus>> statuses = readStatuses();
    if (!statuses.ok())
    {
        LinkReport report;
        report.failures.push_back(*statuses.failure);
        return report;
    }
    return linksFrom(*statuses.value);
}

SampleReport WindowsNetworkPlatform::sampleWifi()
{
    SampleReport report;
    const QueryResult<std::vector<WlanStatus>> before = readStatuses();
    if (!before.ok())
    {
        report.failures.push_back(*before.failure);
        return report;
    }

    const std::vector<WlanStatus> associated = associatedOnly(*before.value);
    if (associated.empty())
    {
        // 没有已关联网卡：不读计数，也不报告失败（与 Linux 实现一致）。
        report.links = linksFrom(*before.value).links;
        return report;
    }

    // 读取计数前后必须关联到同一个网络，否则这次样本无法可靠归属。
    const QueryResult<std::vector<InterfaceCounters>> counters = options_.system->interfaceCounters();
    const QueryResult<std::vector<WlanStatus>> after = readStatuses();
    if (!after.ok())
    {
        report.failures.push_back(*after.failure);
        return report;
    }
    if (!counters.ok())
    {
        report.failures.push_back(*counters.failure);
    }

    for (const WlanStatus& status : associated)
    {
        const WlanStatus* current = findStatus(*after.value, status.interfaceId);
        if (current == nullptr || !sameIdentity(status, *current))
        {
            report.failures.push_back({FailureKind::inconsistent, status.interfaceId, "采样期间网络发生变化，已丢弃该样本。"});
            continue;
        }

        if (!counters.ok())
            continue;

        const auto counted = findInterfaceCounters(*counters.value, status.interfaceId);
        if (!counted)
        {
            report.failures.push_back({FailureKind::countersMissing, status.interfaceId, "IP Helper 的计数中没有这张网卡。"});
            continue;
        }

        WifiSample sample;
        sample.interfaceId = status.interfaceId;
        sample.identity = identityOf(status);
        sample.rxBytes = counted->rxBytes;
        sample.txBytes = counted->txBytes;
        report.samples.push_back(std::move(sample));
    }

    // 把确认过的网卡状态一并带回去，上层展示实时状态时不必再查一次系统。
    report.links = linksFrom(*after.value).links;
    return report;
}

bool WindowsNetworkPlatform::waitUntilDisconnected(const std::string& interfaceId, const std::string& expectedSsid)
{
    // 用“最多看几次”而不是墙钟截止时间：轮询次数有确定上限，
    // 既不会因为注入的等待函数不消耗时间而变成死循环，也让测试能断言具体次数。
    const auto interval = std::max(options_.disconnectPollInterval, std::chrono::milliseconds(1));
    const auto budget = options_.disconnectTimeout.count() > 0 ? options_.disconnectTimeout : interval;
    const auto attempts = std::max<std::int64_t>(1, (budget.count() + interval.count() - 1) / interval.count());

    for (std::int64_t attempt = 0; attempt < attempts; ++attempt)
    {
        const QueryResult<std::vector<WlanStatus>> statuses = readStatuses();
        if (!statuses.ok())
        {
            // 读不到状态就不能声称断开成功；由调用方按“仍在关联”处理。
            return false;
        }
        if (ssidOf(findStatus(*statuses.value, interfaceId)) != expectedSsid)
            return true;

        if (attempt + 1 < attempts)
            options_.wait(interval);
    }
    return false;
}

DisconnectReport WindowsNetworkPlatform::disconnectIfAssociated(const std::string& interfaceId, const std::string& expectedSsid)
{
    DisconnectReport report;

    const QueryResult<std::vector<WlanStatus>> before = readStatuses();
    if (!before.ok())
    {
        report.outcome = before.failure->kind == FailureKind::unavailable ? DisconnectOutcome::unavailable : DisconnectOutcome::commandFailed;
        report.detail = before.failure->detail;
        return report;
    }

    const std::string current = ssidOf(findStatus(*before.value, interfaceId));
    if (current.empty())
    {
        report.outcome = DisconnectOutcome::notAssociated;
        return report;
    }
    if (current != expectedSsid)
    {
        report.outcome = DisconnectOutcome::ssidMismatch;
        return report;
    }

    const DisconnectCommand command = options_.system->requestDisconnect(interfaceId);
    if (!command.accepted)
    {
        report.outcome = command.failureKind == FailureKind::unavailable ? DisconnectOutcome::unavailable : DisconnectOutcome::commandFailed;
        report.detail = command.detail;
        return report;
    }

    // WlanDisconnect 只表示请求被接受，必须复核状态真的离开了期望网络：
    // 命令成功但随即被自动重连时不能报告成功。
    if (!waitUntilDisconnected(interfaceId, expectedSsid))
    {
        report.outcome = DisconnectOutcome::stillAssociated;
        return report;
    }

    report.outcome = DisconnectOutcome::disconnected;
    return report;
}

}  // namespace wifimeter::platform::windows
