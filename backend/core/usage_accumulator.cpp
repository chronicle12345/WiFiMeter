#include "usage_accumulator.h"

#include <algorithm>
#include <set>

namespace wifimeter::core
{
namespace
{

CounterEvent makeEvent(CounterEventKind kind, const std::string& interfaceId, const NetworkRef& network, std::chrono::seconds span)
{
    CounterEvent event;
    event.kind = kind;
    event.interfaceId = interfaceId;
    event.network = network;
    event.span = span;
    return event;
}

}  // namespace

UsageAccumulator::UsageAccumulator()
    : UsageAccumulator(Options{})
{}

UsageAccumulator::UsageAccumulator(Options options)
    : options_(options)
{
    if (options_.baselineTtl < std::chrono::seconds::zero())
        options_.baselineTtl = std::chrono::seconds::zero();
}

void UsageAccumulator::dropStaleBaselines(TimePoint now, AccumulateResult& result)
{
    for (auto entry = baselines_.begin(); entry != baselines_.end();)
    {
        const std::chrono::seconds raw = std::chrono::duration_cast<std::chrono::seconds>(now - entry->second.seenAt);
        const std::chrono::seconds idle = raw > std::chrono::seconds::zero() ? raw : std::chrono::seconds::zero();
        if (idle <= options_.baselineTtl)
        {
            ++entry;
            continue;
        }
        result.events.push_back(makeEvent(CounterEventKind::detached, entry->first, {}, idle));
        entry = baselines_.erase(entry);
    }
}

AccumulateResult UsageAccumulator::accumulate(const platform::SampleReport& report, TimePoint now)
{
    AccumulateResult result;
    std::set<std::string> seen;

    for (const platform::WifiSample& sample : report.samples)
    {
        const NetworkRef network = networkRefOf(sample.identity);
        if (!network.valid())
            continue;  // 无法确定身份就不建立基线，下一次采样会重新开始
        if (!seen.insert(sample.interfaceId).second)
            continue;  // 同一网卡重复出现时只取第一条，避免重复计入

        auto existing = baselines_.find(sample.interfaceId);
        if (existing == baselines_.end())
        {
            baselines_.insert_or_assign(sample.interfaceId, Baseline{network, sample.rxBytes, sample.txBytes, now});
            result.events.push_back(makeEvent(CounterEventKind::baseline, sample.interfaceId, network, std::chrono::seconds::zero()));
            continue;
        }

        Baseline& baseline = existing->second;
        // 系统时钟被回拨（例如 NTP 校正）时不能让区间长度变成负数。
        const std::chrono::seconds elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - baseline.seenAt);
        const std::chrono::seconds span = elapsed > std::chrono::seconds::zero() ? elapsed : std::chrono::seconds::zero();

        // 键或网络名任一变化都说明换了网络：同一份配置也可能匹配到不同的 SSID。
        if (baseline.network.key != network.key || baseline.network.ssid != network.ssid)
        {
            baseline = Baseline{network, sample.rxBytes, sample.txBytes, now};
            result.events.push_back(makeEvent(CounterEventKind::reattributed, sample.interfaceId, network, span));
            continue;
        }

        if (sample.rxBytes < baseline.rx || sample.txBytes < baseline.tx)
        {
            baseline = Baseline{network, sample.rxBytes, sample.txBytes, now};
            result.events.push_back(makeEvent(CounterEventKind::counterReset, sample.interfaceId, network, span));
            continue;
        }

        UsageDelta delta;
        delta.network = network;
        delta.interfaceId = sample.interfaceId;
        delta.rxBytes = sample.rxBytes - baseline.rx;
        delta.txBytes = sample.txBytes - baseline.tx;
        delta.at = now;
        delta.span = span;
        // 差值可能为 0（例如 5 秒内没有任何流量），仍然上报，便于上层推进“最后采样时间”。
        result.deltas.push_back(delta);

        baseline.rx = sample.rxBytes;
        baseline.tx = sample.txBytes;
        baseline.seenAt = now;
    }

    // 报告完整却没出现的网卡，说明它确实不再关联。
    if (report.complete())
    {
        for (auto entry = baselines_.begin(); entry != baselines_.end();)
        {
            if (seen.count(entry->first) > 0)
            {
                ++entry;
                continue;
            }
            const std::chrono::seconds raw = std::chrono::duration_cast<std::chrono::seconds>(now - entry->second.seenAt);
            const std::chrono::seconds idle = raw > std::chrono::seconds::zero() ? raw : std::chrono::seconds::zero();
            result.events.push_back(makeEvent(CounterEventKind::detached, entry->first, {}, idle));
            entry = baselines_.erase(entry);
        }
    }
    else
    {
        dropStaleBaselines(now, result);
    }

    return result;
}

}  // namespace wifimeter::core
