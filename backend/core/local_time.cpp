#include "local_time.h"

#include <cstdio>
#include <ctime>

namespace wifimeter::core
{
namespace
{

std::tm toLocalTime(std::time_t value)
{
    std::tm result{};
#if defined(_WIN32)
    localtime_s(&result, &value);
#else
    localtime_r(&value, &result);
#endif
    return result;
}

}  // namespace

LocalStamp localStampOf(std::chrono::system_clock::time_point at)
{
    const std::tm time = toLocalTime(std::chrono::system_clock::to_time_t(at));
    LocalStamp stamp;
    stamp.year = time.tm_year + 1900;
    stamp.month = time.tm_mon + 1;
    stamp.day = time.tm_mday;
    stamp.hour = time.tm_hour;
    return stamp;
}

// 键一律用 snprintf 手工拼：strftime 的部分转换会跟随 locale（某些语言使用非 ASCII
// 数字），而日期键必须稳定为 ASCII 数字，它还要参与字符串比较与排序。
std::string dayKeyOf(const LocalStamp& stamp)
{
    char buffer[16] = {};
    std::snprintf(buffer, sizeof(buffer), "%04d-%02d-%02d", stamp.year, stamp.month, stamp.day);
    return buffer;
}

std::string monthKeyOf(const LocalStamp& stamp)
{
    char buffer[16] = {};
    std::snprintf(buffer, sizeof(buffer), "%04d-%02d", stamp.year, stamp.month);
    return buffer;
}

std::string hourKeyOf(const LocalStamp& stamp)
{
    char buffer[16] = {};
    std::snprintf(buffer, sizeof(buffer), "%04d-%02d-%02dT%02d", stamp.year, stamp.month, stamp.day, stamp.hour);
    return buffer;
}

LocalStamp shiftLocalDays(const LocalStamp& stamp, int days)
{
    std::tm time{};
    time.tm_year = stamp.year - 1900;
    time.tm_mon = stamp.month - 1;
    time.tm_mday = stamp.day + days;
    time.tm_hour = 12;  // 取正午，避开夏令时切换当天的午夜歧义
    time.tm_isdst = -1;
    const std::time_t seconds = std::mktime(&time);  // 归一化月份、年份与夏令时
    if (seconds == static_cast<std::time_t>(-1))
        return stamp;
    return localStampOf(std::chrono::system_clock::from_time_t(seconds));
}

bool parseDayKey(std::string_view day, TimePoint& at)
{
    if (day.size() != 10 || day[4] != '-' || day[7] != '-')
        return false;
    int year = 0;
    int month = 0;
    int dayOfMonth = 0;
    const std::string copy(day);
    if (std::sscanf(copy.c_str(), "%4d-%2d-%2d", &year, &month, &dayOfMonth) != 3)
        return false;
    if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31)
        return false;

    std::tm time{};
    time.tm_year = year - 1900;
    time.tm_mon = month - 1;
    time.tm_mday = dayOfMonth;
    time.tm_hour = 12;
    time.tm_isdst = -1;
    const std::time_t seconds = std::mktime(&time);
    if (seconds == static_cast<std::time_t>(-1))
        return false;

    const TimePoint parsed = std::chrono::system_clock::from_time_t(seconds);
    // mktime 会把 2 月 30 日这类不存在的日期顺延，回读比对才能拒绝它们。
    if (dayKeyOf(localStampOf(parsed)) != day)
        return false;
    at = parsed;
    return true;
}

std::string isoUtcOf(std::chrono::system_clock::time_point at)
{
    const std::time_t seconds = std::chrono::system_clock::to_time_t(at);
    std::tm time{};
#if defined(_WIN32)
    gmtime_s(&time, &seconds);
#else
    gmtime_r(&seconds, &time);
#endif
    char buffer[32] = {};
    std::snprintf(buffer, sizeof(buffer), "%04d-%02d-%02dT%02d:%02d:%02dZ", time.tm_year + 1900, time.tm_mon + 1, time.tm_mday, time.tm_hour, time.tm_min, time.tm_sec);
    return buffer;
}

bool parseIsoUtc(std::string_view text, std::chrono::system_clock::time_point& at)
{
    int year = 0;
    int month = 0;
    int day = 0;
    int hour = 0;
    int minute = 0;
    int second = 0;
    // 格式固定为 20 个字符，先按长度与结尾筛选，避免 sscanf 接受尾部垃圾。
    if (text.size() != 20 || text[4] != '-' || text[7] != '-' || text[10] != 'T' || text[13] != ':' || text[16] != ':' || text[19] != 'Z')
        return false;
    const std::string copy(text);
    if (std::sscanf(copy.c_str(), "%4d-%2d-%2dT%2d:%2d:%2dZ", &year, &month, &day, &hour, &minute, &second) != 6)
        return false;
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60)
        return false;

    std::tm time{};
    time.tm_year = year - 1900;
    time.tm_mon = month - 1;
    time.tm_mday = day;
    time.tm_hour = hour;
    time.tm_min = minute;
    time.tm_sec = second;
#if defined(_WIN32)
    const std::time_t seconds = ::_mkgmtime(&time);
#else
    const std::time_t seconds = timegm(&time);
#endif
    const auto parsed = std::chrono::system_clock::from_time_t(seconds);

    // timegm 会把 2 月 30 日这类不存在的日期顺延，回读比对才能拒绝它们。
    if (isoUtcOf(parsed) != text)
        return false;
    at = parsed;
    return true;
}

}  // namespace wifimeter::core
