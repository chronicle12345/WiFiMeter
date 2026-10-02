#pragma once
#include <map>
#include "../platform/app_traffic.h"
#include "../core/local_time.h"
#include "../support/json.h"

namespace wifimeter::ipc
{
// 回环字节只用于实时展示，与 Wi-Fi 归属及持久化累计分开。
class LoopbackLive
{
public:
    void clear();
    support::JsonValue update(const platform::AppTrafficReport& report, core::TimePoint now,
        std::chrono::seconds staleAfter = std::chrono::seconds(5));
private:
    struct Counter { std::uint64_t rx, tx, totalRx, totalTx; };
    std::map<std::string, Counter> previous_;
    std::string generation_;
    core::TimePoint at_{};
    std::int64_t sampledAtMs_ = 0;
    support::JsonValue latest_ = support::JsonValue::makeArray();
};
void addProxyMeasurement(support::JsonValue& client, const support::JsonValue& processes,
    const std::vector<std::string>& connectionKeys);
}
