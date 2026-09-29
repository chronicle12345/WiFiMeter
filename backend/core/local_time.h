#pragma once

// 本地时间分量。
//
// 用量记录按“本地日期”与“本地小时”归档（与快照 contract 一致），所以必须有一步
// 从时间点到本地日历的转换。GCC 11 的 libstdc++ 还没有 C++20 的时区数据库
// （__cpp_lib_chrono 只有 201611），因此这里用 POSIX 的 localtime_r 实现，
// Windows 上换成 localtime_s：这是唯一一处真实存在的平台差异，不做多余抽象。

#include <chrono>
#include <string>
#include <string_view>

namespace wifimeter::core
{

// 全项目统一的时间点类型。
using TimePoint = std::chrono::system_clock::time_point;

struct LocalStamp
{
    int year = 1970;
    int month = 1;  // 1..12
    int day = 1;    // 1..31
    int hour = 0;   // 0..23
};

// 转换为本地时间分量。线程安全，遵循进程的时区设置。
LocalStamp localStampOf(std::chrono::system_clock::time_point at);

// YYYY-MM-DD，快照中每日记录的日期键。
std::string dayKeyOf(const LocalStamp& stamp);

// YYYY-MM，月度额度周期键。
std::string monthKeyOf(const LocalStamp& stamp);

// YYYY-MM-DDTHH，小时明细的键，也便于日志阅读。
std::string hourKeyOf(const LocalStamp& stamp);

// 按本地日历平移天数（负数表示往前）。跨月、跨年与夏令时都交给 mktime 归一化，
// 基准取当天 12:00，避免夏令时切换当天的午夜歧义。
LocalStamp shiftLocalDays(const LocalStamp& stamp, int days);

// 解析 YYYY-MM-DD 为本地当天 12:00 的时间点；格式或日期不合法时返回 false。
// 取正午是为了避开夏令时切换当天的午夜歧义。
bool parseDayKey(std::string_view day, TimePoint& at);

// UTC 的 ISO 8601 秒级时间戳，例如 2026-09-29T17:12:30Z。
// 存储与协议中传递“时刻”统一用它，避免本地时区与夏令时带来的歧义。
std::string isoUtcOf(std::chrono::system_clock::time_point at);

// 解析 isoUtcOf 生成的格式；日期不存在（如 2026-02-30）时返回 false。
bool parseIsoUtc(std::string_view text, std::chrono::system_clock::time_point& at);

}  // namespace wifimeter::core
