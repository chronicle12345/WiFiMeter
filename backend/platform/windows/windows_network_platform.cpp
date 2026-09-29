#include "windows_network_platform.h"

#include "../counter_source.h"
#include "../fake_source.h"
#include "../sampling.h"

#include <algorithm>
#include <optional>
#include <thread>
#include <utility>

namespace wifimeter::platform::windows
{
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

LinkReport WindowsNetworkPlatform::linkReportFrom(const std::vector<WlanStatus>& statuses)
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
    LinkReport report;
    report.failures = statuses.failures;
    if (statuses.ok())
        report.links = linkReportFrom(*statuses.value).links;
    return report;
}

SampleReport WindowsNetworkPlatform::sampleWifi()
{
    // 采样时序由 platform/sampling.cpp 统一实现，与 Linux 侧是同一份代码。
    return sampleFrom(*this);
}

bool WindowsNetworkPlatform::fakeAdapterActive() const
{
    return fake::adapterOverrideActive();
}

bool WindowsNetworkPlatform::fakeCountersActive() const
{
    return fake::countersOverrideActive();
}

LinkReadResult WindowsNetworkPlatform::readLinks()
{
    LinkReadResult result;

    // 测试数据源优先：端到端测试用同一份 JSON 驱动两端，不必碰真实无线网卡。
    if (fakeAdapterActive())
    {
        const auto adapters = fake::readOverriddenAdapters();
        if (!adapters)
        {
            result.failures.push_back({FailureKind::unavailable, {}, "无法读取测试用网卡数据。"});
            return result;
        }
        result.links = fake::linksFromAdapters(*adapters);
        return result;
    }

    const QueryResult<std::vector<WlanStatus>> statuses = readStatuses();
    result.failures = statuses.failures;
    if (statuses.ok())
        result.links = linkReportFrom(*statuses.value).links;
    return result;
}

CounterReadResult WindowsNetworkPlatform::readCounters()
{
    CounterReadResult result;

    if (fakeCountersActive())
    {
        const auto counters = fake::readOverriddenCounters();
        if (!counters)
        {
            result.failures.push_back({FailureKind::unavailable, {}, "无法读取测试用计数数据。"});
            return result;
        }
        result.counters = *counters;
        return result;
    }

    const QueryResult<std::vector<InterfaceCounters>> counters = options_.system->interfaceCounters();
    result.failures = counters.failures;
    if (!counters.ok())
        return result;
    result.counters.reserve(counters.value->size());
    for (const InterfaceCounters& entry : *counters.value)
    {
        CounterReading reading;
        reading.interfaceId = entry.interfaceId;
        reading.rxBytes = entry.rxBytes;
        reading.txBytes = entry.txBytes;
        result.counters.push_back(std::move(reading));
    }
    return result;
}

DisconnectOutcome WindowsNetworkPlatform::requestDisconnect(const std::string& interfaceId, std::string& detail)
{
    const DisconnectCommand command = options_.system->requestDisconnect(interfaceId);
    detail = command.detail;
    if (command.accepted)
        return DisconnectOutcome::disconnected;
    return command.failureKind == FailureKind::unavailable ? DisconnectOutcome::unavailable : DisconnectOutcome::commandFailed;
}

DisconnectReport WindowsNetworkPlatform::disconnectIfAssociated(const std::string& interfaceId, const std::string& expectedSsid)
{
    return disconnectFrom(*this, interfaceId, expectedSsid, [this](const std::string& target, const std::string& expected) {
        // 复核：WlanDisconnect 只表示请求被接受，要等状态真的离开期望网络。
        return waitUntilDisconnected(target, expected);
    });
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
            // 这里只在整体查询失败时提前返回：单张网卡的失败不影响目标网卡的判断。
            return false;
        }
        const std::vector<WifiLink> links = linkReportFrom(*statuses.value).links;
        if (ssidOfLink(links, interfaceId) != expectedSsid)
            return true;

        if (attempt + 1 < attempts)
            options_.wait(interval);
    }
    return false;
}

}  // namespace wifimeter::platform::windows
