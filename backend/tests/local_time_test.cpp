// 本地日历测试。时区固定为 UTC 与 Asia/Shanghai，断言与运行机器的设置无关。

#include "../core/local_time.h"

#include <string>

#include "test_support.h"

using namespace wifimeter::core;
using wifimeter::test::utcTime;

namespace
{

void formatsKeysInUtc()
{
    wifimeter::test::useTimeZone("UTC");
    const auto at = utcTime(2026, 9, 29, 17, 12, 30);
    const LocalStamp stamp = localStampOf(at);
    WIFIMETER_CHECK_EQ(stamp.year, 2026);
    WIFIMETER_CHECK_EQ(stamp.month, 9);
    WIFIMETER_CHECK_EQ(stamp.day, 29);
    WIFIMETER_CHECK_EQ(stamp.hour, 17);
    WIFIMETER_CHECK_EQ(dayKeyOf(stamp), std::string("2026-09-29"));
    WIFIMETER_CHECK_EQ(monthKeyOf(stamp), std::string("2026-09"));
    WIFIMETER_CHECK_EQ(hourKeyOf(stamp), std::string("2026-09-29T17"));
}

void shiftsWithTheLocalTimeZone()
{
    // 同一时刻在上海是次日凌晨：日期键必须跟着本地时区走，否则跨日额度与记录会错位。
    wifimeter::test::useTimeZone("Asia/Shanghai");
    const auto at = utcTime(2026, 9, 29, 17, 12, 30);
    const LocalStamp stamp = localStampOf(at);
    WIFIMETER_CHECK_EQ(stamp.day, 30);
    WIFIMETER_CHECK_EQ(stamp.hour, 1);
    WIFIMETER_CHECK_EQ(dayKeyOf(stamp), std::string("2026-09-30"));
    WIFIMETER_CHECK_EQ(hourKeyOf(stamp), std::string("2026-09-30T01"));
}

void padsSingleDigitComponents()
{
    wifimeter::test::useTimeZone("UTC");
    const LocalStamp stamp = localStampOf(utcTime(2026, 1, 2, 3, 4, 5));
    // 键必须定长，才能直接用于字符串比较与排序。
    WIFIMETER_CHECK_EQ(dayKeyOf(stamp), std::string("2026-01-02"));
    WIFIMETER_CHECK_EQ(monthKeyOf(stamp), std::string("2026-01"));
    WIFIMETER_CHECK_EQ(hourKeyOf(stamp), std::string("2026-01-02T03"));
}

void handlesLeapDay()
{
    wifimeter::test::useTimeZone("UTC");
    WIFIMETER_CHECK_EQ(dayKeyOf(localStampOf(utcTime(2028, 2, 29, 23, 59, 59))), std::string("2028-02-29"));
    WIFIMETER_CHECK_EQ(dayKeyOf(localStampOf(utcTime(2027, 3, 1, 0, 0, 0))), std::string("2027-03-01"));
}

void shiftsLocalDays()
{
    wifimeter::test::useTimeZone("UTC");
    const LocalStamp base = localStampOf(utcTime(2026, 9, 29, 10, 0, 0));
    WIFIMETER_CHECK_EQ(dayKeyOf(shiftLocalDays(base, -1)), std::string("2026-09-28"));
    WIFIMETER_CHECK_EQ(dayKeyOf(shiftLocalDays(base, 0)), std::string("2026-09-29"));
    WIFIMETER_CHECK_EQ(dayKeyOf(shiftLocalDays(base, 5)), std::string("2026-10-04"));

    // 跨月、跨年与闰年都由 mktime 归一化。
    WIFIMETER_CHECK_EQ(dayKeyOf(shiftLocalDays(localStampOf(utcTime(2026, 3, 1, 10, 0, 0)), -1)), std::string("2026-02-28"));
    WIFIMETER_CHECK_EQ(dayKeyOf(shiftLocalDays(localStampOf(utcTime(2028, 3, 1, 10, 0, 0)), -1)), std::string("2028-02-29"));
    WIFIMETER_CHECK_EQ(dayKeyOf(shiftLocalDays(localStampOf(utcTime(2026, 1, 1, 10, 0, 0)), -1)), std::string("2025-12-31"));

    // 保留期含当天：往前 29 天正好是 30 天窗口。
    WIFIMETER_CHECK_EQ(dayKeyOf(shiftLocalDays(localStampOf(utcTime(2026, 10, 5, 12, 0, 0)), -29)), std::string("2026-09-06"));
}

void writesAndParsesIsoTimestamps()
{
    const auto at = utcTime(2026, 9, 29, 17, 12, 30);
    const std::string text = isoUtcOf(at);
    WIFIMETER_CHECK_EQ(text, std::string("2026-09-29T17:12:30Z"));

    std::chrono::system_clock::time_point parsed{};
    WIFIMETER_CHECK(parseIsoUtc(text, parsed));
    WIFIMETER_CHECK(parsed == at);

    // ISO 时间戳与本地时区无关：同一时刻在任何时区都写成同一个字符串。
    wifimeter::test::useTimeZone("Asia/Shanghai");
    WIFIMETER_CHECK_EQ(isoUtcOf(at), text);
    WIFIMETER_CHECK(parseIsoUtc(text, parsed));
    WIFIMETER_CHECK(parsed == at);
    wifimeter::test::useTimeZone("UTC");
}

void rejectsMalformedIsoTimestamps()
{
    std::chrono::system_clock::time_point parsed{};
    WIFIMETER_CHECK(!parseIsoUtc("", parsed));
    WIFIMETER_CHECK(!parseIsoUtc("2026-09-29T17:12:30", parsed));    // 缺少 Z
    WIFIMETER_CHECK(!parseIsoUtc("2026-09-29 17:12:30Z", parsed));   // 分隔符不对
    WIFIMETER_CHECK(!parseIsoUtc("2026-09-29T17:12:30Z ", parsed));  // 尾部多余
    WIFIMETER_CHECK(!parseIsoUtc("2026-13-01T00:00:00Z", parsed));   // 月份越界
    WIFIMETER_CHECK(!parseIsoUtc("2026-02-30T00:00:00Z", parsed));   // 不存在的日期
    WIFIMETER_CHECK(!parseIsoUtc("2026-09-29T25:00:00Z", parsed));   // 小时越界
    WIFIMETER_CHECK(!parseIsoUtc("abcd-ef-ghTij:kl:mnZ", parsed));
}

}  // namespace

int main()
{
    formatsKeysInUtc();
    shiftsWithTheLocalTimeZone();
    padsSingleDigitComponents();
    handlesLeapDay();
    shiftsLocalDays();
    writesAndParsesIsoTimestamps();
    rejectsMalformedIsoTimestamps();
    return WIFIMETER_REPORT();
}
