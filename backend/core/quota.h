#pragma once

// 流量额度：周期键、账本滚动与额度状态。
//
// 额度按“日”或“月”为一个周期，周期键取本地日期（YYYY-MM-DD）或本地月份（YYYY-MM）。
// 账本记录当前周期内的累计用量：周期变化时归零再累加，而不是回头重算历史记录——
// 归零保证了账本始终是当前周期用量的权威来源，重算会让记录裁剪（retention）影响额度。

#include <chrono>
#include <string>

#include "byte_count.h"
#include "local_time.h"

namespace wifimeter::core
{

enum class QuotaPeriod
{
    day,
    month,
};

struct QuotaSettings
{
    double capGb = 0.0;  // 十进制 GB；0 表示不限量
    int warnPercent = 80;
    QuotaPeriod period = QuotaPeriod::month;
};

// 当前周期的累计用量。
struct QuotaLedger
{
    std::string periodKey;
    ByteCount usedBytes = 0;
};

struct QuotaState
{
    QuotaPeriod period = QuotaPeriod::month;
    std::string periodKey;
    ByteCount usedBytes = 0;
    ByteCount capBytes = 0;
    bool limited = false;  // 是否设置了上限

    ByteCount remainingBytes() const;
    double percent() const;  // 无上限时为 0
    bool reachedWarn(int warnPercent) const;
    bool reachedLimit() const;
};

// GB（十进制，1 GB = 10^9 字节）转字节；负值按 0 处理。
ByteCount bytesOfGigabytes(double gigabytes);

// 周期键：日额度用 YYYY-MM-DD，月额度用 YYYY-MM。
std::string periodKeyFor(QuotaPeriod period, TimePoint now);

// 把增量计入账本。跨周期时先把账本归零，返回是否发生了滚动。
bool addToLedger(QuotaLedger& ledger, const QuotaSettings& settings, ByteCount delta, TimePoint now);

QuotaState quotaStateOf(const QuotaSettings& settings, ByteCount usedBytes, TimePoint now);

}  // namespace wifimeter::core
