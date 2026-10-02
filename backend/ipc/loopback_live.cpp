#include "loopback_live.h"
#include <algorithm>
#include <chrono>
#include <set>

namespace wifimeter::ipc
{
using support::JsonValue;
void LoopbackLive::clear() { previous_.clear(); generation_.clear(); at_ = {}; sampledAtMs_ = 0; latest_ = JsonValue::makeArray(); }
JsonValue LoopbackLive::update(const platform::AppTrafficReport& report, core::TimePoint now, std::chrono::seconds staleAfter)
{
    auto result = JsonValue::makeArray();
    if ((report.state != platform::AppCollectorState::running && report.state != platform::AppCollectorState::partial) || report.generation.empty())
    { clear(); return result; }
    if (generation_ != report.generation) clear();
    const auto stamp = report.loopbackSampledAtMs;
    if (stamp > 0 && sampledAtMs_ > 0 && stamp <= sampledAtMs_)
    {
        auto cached = JsonValue::makeArray();
        for (auto row : latest_.items())
        {
            if (now - at_ > staleAfter)
            {
                row.set("measurementAvailable", JsonValue::makeBool(false));
                row.set("rxPerSecond", JsonValue{});
                row.set("txPerSecond", JsonValue{});
            }
            cached.push(std::move(row));
        }
        return cached;
    }
    const double elapsed = stamp > 0 && sampledAtMs_ > 0 ?
        static_cast<double>(stamp - sampledAtMs_) / 1000.0 : std::chrono::duration<double>(now - at_).count();
    std::map<std::string, Counter> next;
    for (const auto& sample : report.samples)
    {
        if (sample.interfaceId != "loopback" || !sample.active || !sample.processId) continue;
        const auto key = sample.instanceId + "|" + sample.appId + "|" + sample.connectionKey;
        const auto old = previous_.find(key);
        const bool measured = old != previous_.end() && elapsed > 0 &&
            sample.rxBytes >= old->second.rx && sample.txBytes >= old->second.tx;
        const auto rx = measured ? sample.rxBytes - old->second.rx : 0;
        const auto tx = measured ? sample.txBytes - old->second.tx : 0;
        Counter counter{sample.rxBytes, sample.txBytes,
            (old != previous_.end() ? old->second.totalRx : 0) + rx,
            (old != previous_.end() ? old->second.totalTx : 0) + tx};
        next[key] = counter;
        auto row = JsonValue::makeObject();
        row.set("networkId", JsonValue::makeString(""));
        row.set("appId", JsonValue::makeString(sample.appId));
        row.set("name", JsonValue::makeString(sample.name));
        row.set("processId", JsonValue::makeInt(sample.processId));
        row.set("instanceId", JsonValue::makeString(sample.instanceId));
        row.set("connectionKey", JsonValue::makeString(sample.connectionKey));
        row.set("source", JsonValue::makeString("WindowsTcpEStats"));
        row.set("scope", JsonValue::makeString("loopback"));
        row.set("measurementAvailable", JsonValue::makeBool(measured));
        row.set("rxBytes", JsonValue::makeString(std::to_string(counter.totalRx)));
        row.set("txBytes", JsonValue::makeString(std::to_string(counter.totalTx)));
        row.set("rxPerSecond", measured ? JsonValue::makeString(std::to_string(static_cast<std::uint64_t>(rx / elapsed))) : JsonValue{});
        row.set("txPerSecond", measured ? JsonValue::makeString(std::to_string(static_cast<std::uint64_t>(tx / elapsed))) : JsonValue{});
        result.push(std::move(row));
    }
    previous_ = std::move(next); generation_ = report.generation; at_ = now;
    sampledAtMs_ = stamp; latest_ = result;
    return result;
}
void addProxyMeasurement(JsonValue& client, const JsonValue& processes, const std::vector<std::string>& keys)
{
    std::uint64_t rx=0, tx=0, rxRate=0, txRate=0;
    std::set<std::string> matched;
    for (const auto& row : processes.items())
    {
        const auto key = row.stringOr("connectionKey");
        if (row.stringOr("scope") != "loopback" || row.stringOr("appId") != client.stringOr("appId") ||
            !row.boolOr("measurementAvailable") || std::find(keys.begin(),keys.end(),key)==keys.end() || !matched.insert(key).second) continue;
        rx += std::stoull(row.stringOr("rxBytes")); tx += std::stoull(row.stringOr("txBytes"));
        rxRate += std::stoull(row.stringOr("rxPerSecond")); txRate += std::stoull(row.stringOr("txPerSecond"));
    }
    const bool measured = !matched.empty();
    client.set("measurementAvailable",JsonValue::makeBool(measured));
    client.set("sampledConnections",JsonValue::makeInt(static_cast<std::int64_t>(matched.size())));
    client.set("source",JsonValue::makeString("WindowsTcpEStats"));
    client.set("scope",JsonValue::makeString("loopback"));
    client.set("estimated",JsonValue::makeBool(false));
    client.set("rxBytes",measured ? JsonValue::makeString(std::to_string(rx)) : JsonValue{});
    client.set("txBytes",measured ? JsonValue::makeString(std::to_string(tx)) : JsonValue{});
    client.set("rxPerSecond",measured ? JsonValue::makeString(std::to_string(rxRate)) : JsonValue{});
    client.set("txPerSecond",measured ? JsonValue::makeString(std::to_string(txRate)) : JsonValue{});
}
}
