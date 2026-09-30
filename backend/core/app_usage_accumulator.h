#pragma once

#include <map>
#include <tuple>

#include "../platform/app_traffic.h"
#include "usage_accumulator.h"

namespace wifimeter::core
{

struct AppUsageDelta
{
    NetworkRef network;
    platform::AppTrafficSample process;
    ByteCount rxBytes = 0;
    ByteCount txBytes = 0;
    TimePoint at{};
    std::chrono::seconds span{0};
};

enum class AppGapKind
{
    sourceRestart,
    counterReset,
    reattributed,
    identityUnknown,
};

struct AppCounterGap
{
    AppGapKind kind;
    std::string interfaceId;
    NetworkRef network;
    TimePoint startedAt{};
    TimePoint endedAt{};
};

struct AppAccumulateResult
{
    std::vector<AppUsageDelta> deltas;
    std::vector<AppCounterGap> gaps;
};

class AppUsageAccumulator
{
public:
    AppAccumulateResult accumulate(const platform::AppTrafficReport& apps, const platform::SampleReport& wifi, TimePoint now);
    void clear();

private:
    using Key = std::tuple<std::string, std::string, std::string>;
    std::map<Key, std::pair<ByteCount, ByteCount>> counters_;
    std::map<std::string, NetworkRef> networks_;
    std::string generation_;
    TimePoint lastAt_{};
};

}  // namespace wifimeter::core
