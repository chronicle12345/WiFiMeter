#pragma once

// 用量记录仓储：每日用量、小时明细，以及“没有采集到数据的区间”。
//
// 界面明确承诺“缺失记录不会伪装成零流量”，所以暂停、离线、计数器重置、身份不明这些
// 区间都要单独留痕，而不是让那几天的记录看起来是 0。

#include <chrono>
#include <cstddef>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "../core/byte_count.h"
#include "../core/local_time.h"
#include "../core/network_key.h"
#include "database.h"

namespace wifimeter::storage
{

struct DailyUsageRow
{
    std::string networkKey;
    std::string day;  // YYYY-MM-DD
    core::ByteCount rxBytes = 0;
    core::ByteCount txBytes = 0;
};

struct HourlyUsageRow
{
    std::string networkKey;
    std::string day;
    int hour = 0;
    core::ByteCount rxBytes = 0;
    core::ByteCount txBytes = 0;
};

struct AppUsageRow
{
    std::string networkKey;
    std::string day;
    std::string appId;  // 稳定的应用标识，不使用 PID
    std::string name;
    core::ByteCount rxBytes = 0;
    core::ByteCount txBytes = 0;
};

enum class CoverageReason
{
    paused,           // 用户暂停统计
    offline,          // 采集器不可用
    counterReset,     // 计数器回落，这段流量无法估算
    reattributed,     // 采样期间换了网络
    detached,         // 网卡不再关联
    identityUnknown,  // 拿不到可归属的网络身份
};

std::string_view coverageReasonName(CoverageReason reason);
std::optional<CoverageReason> coverageReasonFromName(std::string_view name);

struct CoverageGap
{
    std::string networkKey;  // 空表示与具体网络无关
    CoverageReason reason = CoverageReason::offline;
    std::string reasonDetail;
    core::TimePoint startedAt{};
    core::TimePoint endedAt{};
    std::chrono::seconds span{0};
    bool application = false;  // 应用采集空档独立于网卡采集覆盖
};

class UsageRepository
{
public:
    explicit UsageRepository(Database& database)
        : database_(database)
    {}

    // 把增量累加到对应日期与小时；同一日期/小时重复调用会累加而不是覆盖。
    Status add(const core::NetworkRef& network, const core::LocalStamp& stamp, core::ByteCount rx, core::ByteCount tx);

    // 区间查询，两端都包含。networkKey 为空表示全部网络。
    std::vector<DailyUsageRow> dailyRange(const std::string& networkKey, const std::string& fromDay, const std::string& toDay, Status& status) const;

    // 某一天的小时明细。
    std::vector<HourlyUsageRow> hourlyOfDay(const std::string& networkKey, const std::string& day, Status& status) const;

    // 删除 day 之前的用量记录，返回删除的行数。
    Status pruneBefore(const std::string& day, std::size_t& removedDaily, std::size_t& removedHourly);

    // 直接写入某天/某小时的绝对值，用于恢复备份（备份里已经是聚合后的数字）。
    Status setDaily(const std::string& networkKey, const std::string& day, core::ByteCount rx, core::ByteCount tx);
    Status setHourly(const std::string& networkKey, const std::string& day, int hour, core::ByteCount rx, core::ByteCount tx);

    // 应用流量独立存储，不参与网卡总量或额度账本的累加。
    Status addApp(const AppUsageRow& row);
    Status setApp(const AppUsageRow& row);
    std::vector<AppUsageRow> appRange(const std::string& networkKey, const std::string& fromDay, const std::string& toDay, Status& status) const;

    Status addGap(const CoverageGap& gap);
    std::vector<CoverageGap> gapsInRange(const std::string& fromIso, const std::string& toIso, Status& status, bool application = false) const;
    // 采集恢复时闭合所有未结束的空档（ended_at 为空）。
    Status closeOpenGaps(core::TimePoint endedAt, std::size_t& closed, bool application = false);

    // 清空用量记录与空档，并把账本归零；网络与偏好保留。
    Status clearUsage();

    // 删除某个网络的全部数据。
    Status removeNetwork(const std::string& networkKey);

private:
    Status writeApp(const AppUsageRow& row, bool accumulate);
    Database& database_;
};

}  // namespace wifimeter::storage
