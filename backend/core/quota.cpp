#include "quota.h"

#include <algorithm>
#include <cmath>

namespace wifimeter::core
{
namespace
{

// 十进制 GB。合法上限 9e9 GB 转换后为 9e18 字节，仍在 int64 范围内。
constexpr double kBytesPerGigabyte = 1e9;

double clampWarnPercent(double warnPercent)
{
    return std::clamp(warnPercent, 1.0, 100.0);
}

}  // namespace

bool normalizeWarnPercents(std::vector<double>& values, double legacy)
{
    if (values.empty()) values.push_back(legacy);
    for (double value : values)
        if (!std::isfinite(value) || value < 1 || value > 100) return false;
    std::sort(values.begin(), values.end());
    values.erase(std::unique(values.begin(), values.end()), values.end());
    return true;
}

ByteCount bytesOfGigabytes(double gigabytes)
{
    if (!(gigabytes > 0.0) || !std::isfinite(gigabytes))
        return 0;
    return std::max<ByteCount>(1, static_cast<ByteCount>(std::llround(gigabytes * kBytesPerGigabyte)));
}

std::string periodKeyFor(QuotaPeriod period, TimePoint now)
{
    if (period == QuotaPeriod::all) return "all";
    const LocalStamp stamp = localStampOf(now);
    return period == QuotaPeriod::day ? dayKeyOf(stamp) : monthKeyOf(stamp);
}

bool addToLedger(QuotaLedger& ledger, const QuotaSettings& settings, ByteCount delta, TimePoint now)
{
    const std::string key = periodKeyFor(settings.period, now);
    const bool rolled = ledger.periodKey != key;
    if (rolled)
    {
        ledger.periodKey = key;
        ledger.usedBytes = 0;
    }
    ledger.usedBytes += delta;
    return rolled;
}

ByteCount QuotaState::remainingBytes() const
{
    return capBytes > usedBytes ? capBytes - usedBytes : 0;
}

double QuotaState::percent() const
{
    if (!limited || capBytes == 0)
        return 0.0;
    return static_cast<double>(usedBytes) * 100.0 / static_cast<double>(capBytes);
}

bool QuotaState::reachedWarn(double warnPercent) const
{
    return limited && percent() >= static_cast<double>(clampWarnPercent(warnPercent));
}

bool QuotaState::reachedLimit() const
{
    return limited && usedBytes >= capBytes;
}

QuotaState quotaStateOf(const QuotaSettings& settings, ByteCount usedBytes, TimePoint now)
{
    QuotaState state;
    state.period = settings.period;
    state.periodKey = periodKeyFor(settings.period, now);
    state.usedBytes = usedBytes;
    state.capBytes = bytesOfGigabytes(settings.capGb);
    state.limited = state.capBytes > 0;
    return state;
}

}  // namespace wifimeter::core
