#include "app_usage_accumulator.h"

#include <set>

namespace wifimeter::core
{

void AppUsageAccumulator::clear()
{
    counters_.clear();
    networks_.clear();
    generation_.clear();
    lastAt_ = {};
}

AppAccumulateResult AppUsageAccumulator::accumulate(const platform::AppTrafficReport& apps, const platform::SampleReport& wifi, TimePoint now)
{
    AppAccumulateResult result;
    if (apps.state != platform::AppCollectorState::running && apps.state != platform::AppCollectorState::partial)
    {
        clear();
        return result;
    }
    if (apps.generation.empty())
    {
        clear();
        return result;
    }
    std::map<std::string, NetworkRef> current;
    for (const auto& sample : wifi.samples)
    {
        auto network = networkRefOf(sample.identity);
        if (network.valid())
            current[sample.interfaceId] = std::move(network);
    }
    const bool newGeneration = generation_ != apps.generation;
    if (newGeneration)
    {
        if (!generation_.empty())
            result.gaps.push_back({AppGapKind::sourceRestart, {}, {}, lastAt_, now});
        counters_.clear();
    }
    const auto span = now > lastAt_ ? std::chrono::duration_cast<std::chrono::seconds>(now - lastAt_) : std::chrono::seconds(0);
    std::set<std::string> gapped;
    for (const auto& sample : apps.samples)
    {
        const Key key{sample.interfaceId, sample.appId, sample.instanceId};
        const auto old = counters_.find(key);
        ByteCount rx = 0, tx = 0;
        bool reset = false;
        if (!newGeneration)
        {
            // 本 generation 中新创建的进程计数从零开始；PID 重用由 instanceId 区分。
            const ByteCount beforeRx = old == counters_.end() ? 0 : old->second.first;
            const ByteCount beforeTx = old == counters_.end() ? 0 : old->second.second;
            reset = sample.rxBytes < beforeRx || sample.txBytes < beforeTx;
            if (!reset)
            {
                rx = sample.rxBytes - beforeRx;
                tx = sample.txBytes - beforeTx;
            }
        }
        // 即便本轮无法归属也推进基线，恢复后不能把未知区间写到新的 Wi-Fi。
        counters_[key] = {sample.rxBytes, sample.txBytes};
        if (newGeneration)
            continue;
        const auto network = current.find(sample.interfaceId);
        const auto previous = networks_.find(sample.interfaceId);
        if (network == current.end() || previous == networks_.end())
        {
            // 有线和回环接口不属于 Wi-Fi 统计；只有曾关联 Wi-Fi 的接口才记录归属缺失。
            if (previous != networks_.end() && gapped.insert(sample.interfaceId).second)
                result.gaps.push_back({AppGapKind::identityUnknown, sample.interfaceId, previous->second, lastAt_, now});
            continue;
        }
        if (network->second.key != previous->second.key || network->second.ssid != previous->second.ssid)
        {
            if (gapped.insert(sample.interfaceId).second)
                result.gaps.push_back({AppGapKind::reattributed, sample.interfaceId, previous->second, lastAt_, now});
            continue;
        }
        if (reset)
        {
            result.gaps.push_back({AppGapKind::counterReset, sample.interfaceId, network->second, lastAt_, now});
            continue;
        }
        if (rx || tx)
            result.deltas.push_back({network->second, sample, rx, tx, now, span});
    }
    generation_ = apps.generation;
    networks_ = std::move(current);
    lastAt_ = now;
    return result;
}

}  // namespace wifimeter::core
