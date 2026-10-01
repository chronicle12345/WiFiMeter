// 额度测试：GB 换算、周期键、账本滚动与额度状态。

#include "../core/quota.h"

#include <limits>
#include <string>

#include "test_support.h"

using namespace wifimeter::core;
using wifimeter::test::utcTime;

namespace
{

void convertsGigabytes()
{
    WIFIMETER_CHECK_EQ(bytesOfGigabytes(0.0), ByteCount{0});
    WIFIMETER_CHECK_EQ(bytesOfGigabytes(1.0), ByteCount{1000000000});
    WIFIMETER_CHECK_EQ(bytesOfGigabytes(42.68), ByteCount{42680000000});
    WIFIMETER_CHECK_EQ(bytesOfGigabytes(0.5), ByteCount{500000000});
    // 负值与非法值按 0 处理，避免出现负的上限。
    WIFIMETER_CHECK_EQ(bytesOfGigabytes(-5.0), ByteCount{0});
    WIFIMETER_CHECK_EQ(bytesOfGigabytes(std::numeric_limits<double>::quiet_NaN()), ByteCount{0});
}

void buildsPeriodKeys()
{
    wifimeter::test::useTimeZone("Asia/Shanghai");
    const auto at = utcTime(2026, 9, 29, 17, 12, 30);  // 上海时间 2026-09-30 01:12
    WIFIMETER_CHECK_EQ(periodKeyFor(QuotaPeriod::day, at), std::string("2026-09-30"));
    WIFIMETER_CHECK_EQ(periodKeyFor(QuotaPeriod::month, at), std::string("2026-09"));
}

void accumulatesWithinThePeriod()
{
    // 每个依赖本地日期的用例都自己钉住时区，避免用例之间互相影响。
    wifimeter::test::useTimeZone("UTC");
    QuotaSettings settings;
    settings.period = QuotaPeriod::month;
    QuotaLedger ledger;

    WIFIMETER_CHECK(addToLedger(ledger, settings, 100, utcTime(2026, 9, 29, 10, 0, 0)));
    WIFIMETER_CHECK_EQ(ledger.periodKey, std::string("2026-09"));
    WIFIMETER_CHECK_EQ(ledger.usedBytes, ByteCount{100});

    WIFIMETER_CHECK(!addToLedger(ledger, settings, 50, utcTime(2026, 9, 29, 11, 0, 0)));
    WIFIMETER_CHECK_EQ(ledger.usedBytes, ByteCount{150});
}

void rollsOverAtThePeriodBoundary()
{
    wifimeter::test::useTimeZone("UTC");
    QuotaSettings settings;
    settings.period = QuotaPeriod::month;
    QuotaLedger ledger;
    addToLedger(ledger, settings, 500, utcTime(2026, 9, 30, 23, 0, 0));

    // 进入新月份：账本归零后只累加本次增量，而不是回头重算历史记录。
    WIFIMETER_CHECK(addToLedger(ledger, settings, 30, utcTime(2026, 10, 1, 0, 0, 5)));
    WIFIMETER_CHECK_EQ(ledger.periodKey, std::string("2026-10"));
    WIFIMETER_CHECK_EQ(ledger.usedBytes, ByteCount{30});
}

void rollsOverDaily()
{
    wifimeter::test::useTimeZone("UTC");
    QuotaSettings settings;
    settings.period = QuotaPeriod::day;
    QuotaLedger ledger;
    addToLedger(ledger, settings, 500, utcTime(2026, 9, 30, 23, 59, 0));
    WIFIMETER_CHECK_EQ(ledger.periodKey, std::string("2026-09-30"));

    WIFIMETER_CHECK(addToLedger(ledger, settings, 7, utcTime(2026, 10, 1, 0, 0, 3)));
    WIFIMETER_CHECK_EQ(ledger.periodKey, std::string("2026-10-01"));
    WIFIMETER_CHECK_EQ(ledger.usedBytes, ByteCount{7});
}

void reportsUnlimitedQuota()
{
    QuotaSettings settings;
    settings.capGb = 0.0;
    const QuotaState state = quotaStateOf(settings, 5000000000ULL, utcTime(2026, 9, 29, 10, 0, 0));

    WIFIMETER_CHECK(!state.limited);
    WIFIMETER_CHECK_EQ(state.capBytes, ByteCount{0});
    WIFIMETER_CHECK_EQ(state.remainingBytes(), ByteCount{0});
    WIFIMETER_CHECK_EQ(state.percent(), 0.0);
    WIFIMETER_CHECK(!state.reachedWarn(80));
    WIFIMETER_CHECK(!state.reachedLimit());
}

void reportsLimitedQuota()
{
    QuotaSettings settings;
    settings.capGb = 10.0;
    settings.warnPercent = 80;
    const QuotaState state = quotaStateOf(settings, 8500000000ULL, utcTime(2026, 9, 29, 10, 0, 0));

    WIFIMETER_CHECK(state.limited);
    WIFIMETER_CHECK_EQ(state.capBytes, ByteCount{10000000000ULL});
    WIFIMETER_CHECK_EQ(state.usedBytes, ByteCount{8500000000ULL});
    WIFIMETER_CHECK_EQ(state.remainingBytes(), ByteCount{1500000000ULL});
    WIFIMETER_CHECK_EQ(state.percent(), 85.0);
    WIFIMETER_CHECK(state.reachedWarn(80));
    WIFIMETER_CHECK(!state.reachedWarn(90));
    WIFIMETER_CHECK(!state.reachedLimit());
}

void reportsExhaustedQuota()
{
    QuotaSettings settings;
    settings.capGb = 1.0;
    const QuotaState exact = quotaStateOf(settings, 1000000000ULL, utcTime(2026, 9, 29, 10, 0, 0));
    WIFIMETER_CHECK(exact.reachedLimit());
    WIFIMETER_CHECK_EQ(exact.remainingBytes(), ByteCount{0});

    const QuotaState exceeded = quotaStateOf(settings, 2000000000ULL, utcTime(2026, 9, 29, 10, 0, 0));
    WIFIMETER_CHECK(exceeded.reachedLimit());
    WIFIMETER_CHECK_EQ(exceeded.remainingBytes(), ByteCount{0});
    WIFIMETER_CHECK_EQ(exceeded.percent(), 200.0);
}

void fractionalWarningBoundary()
{
    const QuotaSettings settings{0.000001, 85.5, QuotaPeriod::all};
    const auto now = utcTime(2026, 10, 1);
    WIFIMETER_CHECK(!quotaStateOf(settings, 854, now).reachedWarn(settings.warnPercent));
    WIFIMETER_CHECK(quotaStateOf(settings, 855, now).reachedWarn(settings.warnPercent));
    WIFIMETER_CHECK(quotaStateOf(settings, 856, now).reachedWarn(settings.warnPercent));
}

void clampsTheWarnThreshold()
{
    QuotaSettings settings;
    settings.capGb = 1.0;
    const QuotaState state = quotaStateOf(settings, 500000000ULL, utcTime(2026, 9, 29, 10, 0, 0));

    // 阈值被限制在 1..100，0 或 200 这类取值不会导致永远提醒或永远不提醒。
    WIFIMETER_CHECK(state.reachedWarn(0));
    WIFIMETER_CHECK(state.reachedWarn(-5));
    WIFIMETER_CHECK(state.reachedWarn(50));
    WIFIMETER_CHECK(!state.reachedWarn(51));
    WIFIMETER_CHECK(!state.reachedWarn(200));
}

}  // namespace

int main()
{
    convertsGigabytes();
    buildsPeriodKeys();
    accumulatesWithinThePeriod();
    rollsOverAtThePeriodBoundary();
    rollsOverDaily();
    reportsUnlimitedQuota();
    reportsLimitedQuota();
    reportsExhaustedQuota();
    fractionalWarningBoundary();
    clampsTheWarnThreshold();
    return WIFIMETER_REPORT();
}
