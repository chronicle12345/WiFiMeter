#include "quota.h"

#include <algorithm>
#include <cmath>

namespace wifimeter::core
{
namespace
{

// 十进制 GB。上限 100000 GB 时仍远小于 2^53，llround 不会丢精度。
constexpr double kBytesPerGigabyte = 1e9;

int clampWarnPercent(int warnPercent)
{
    return std::clamp(warnPercent, 1, 100);
}

}  // namespace

ByteCount bytesOfGigabytes(double gigabytes)
{
    if (!(gigabytes > 0.0))
        return 0;
    return static_cast<ByteCount>(std::llround(gigabytes * kBytesPerGigabyte));
}

std::string periodKeyFor(QuotaPeriod period, TimePoint now)
{
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

bool QuotaState::reachedWarn(int warnPercent) const
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
