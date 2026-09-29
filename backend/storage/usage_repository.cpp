#include "usage_repository.h"

#include <sqlite3.h>

#include <array>

namespace wifimeter::storage
{
namespace
{

struct ReasonName
{
    CoverageReason reason;
    const char* name;
};

// 名字会写进数据库并被协议引用，因此保持稳定，不跟随界面文案变化。
constexpr std::array<ReasonName, 6> kReasonNames{{
    {CoverageReason::paused, "paused"},
    {CoverageReason::offline, "offline"},
    {CoverageReason::counterReset, "counter_reset"},
    {CoverageReason::reattributed, "reattributed"},
    {CoverageReason::detached, "detached"},
    {CoverageReason::identityUnknown, "identity_unknown"},
}};

}  // namespace

std::string_view coverageReasonName(CoverageReason reason)
{
    for (const ReasonName& entry : kReasonNames)
    {
        if (entry.reason == reason)
            return entry.name;
    }
    return "offline";
}

std::optional<CoverageReason> coverageReasonFromName(std::string_view name)
{
    for (const ReasonName& entry : kReasonNames)
    {
        if (entry.name == name)
            return entry.reason;
    }
    return std::nullopt;
}

Status UsageRepository::add(const core::NetworkRef& network, const core::LocalStamp& stamp, core::ByteCount rx, core::ByteCount tx)
{
    if (!network.valid())
        return Status::failure("网络身份无效，无法记录用量。");
    const auto storedRx = toStoredBytes(rx);
    const auto storedTx = toStoredBytes(tx);
    if (!storedRx || !storedTx)
        return Status::failure("用量超出可存储范围。");

    const std::string day = core::dayKeyOf(stamp);
    Status status;

    auto daily = database_.prepare(
        "INSERT INTO daily_usage(network_key, day, rx_bytes, tx_bytes) VALUES(?1, ?2, ?3, ?4) "
        "ON CONFLICT(network_key, day) DO UPDATE SET rx_bytes = rx_bytes + excluded.rx_bytes, tx_bytes = tx_bytes + excluded.tx_bytes;",
        status);
    if (!daily)
        return status;
    if (!daily->bind(1, network.key) || !daily->bind(2, day) || !daily->bind(3, *storedRx) || !daily->bind(4, *storedTx))
        return Status::failure(daily->error());
    if (const Status ran = daily->run(); !ran)
        return ran;

    auto hourly = database_.prepare(
        "INSERT INTO hourly_usage(network_key, day, hour, rx_bytes, tx_bytes) VALUES(?1, ?2, ?3, ?4, ?5) "
        "ON CONFLICT(network_key, day, hour) DO UPDATE SET rx_bytes = rx_bytes + excluded.rx_bytes, tx_bytes = tx_bytes + excluded.tx_bytes;",
        status);
    if (!hourly)
        return status;
    if (!hourly->bind(1, network.key) || !hourly->bind(2, day) || !hourly->bind(3, static_cast<std::int64_t>(stamp.hour)) || !hourly->bind(4, *storedRx) || !hourly->bind(5, *storedTx))
        return Status::failure(hourly->error());
    return hourly->run();
}

std::vector<DailyUsageRow> UsageRepository::dailyRange(const std::string& networkKey, const std::string& fromDay, const std::string& toDay, Status& status) const
{
    std::vector<DailyUsageRow> rows;
    auto statement = database_.prepare(
        "SELECT network_key, day, rx_bytes, tx_bytes FROM daily_usage "
        "WHERE day >= ?1 AND day <= ?2 AND (?3 = '' OR network_key = ?3) "
        "ORDER BY day ASC, network_key ASC;",
        status);
    if (!statement)
        return rows;
    if (!statement->bind(1, fromDay) || !statement->bind(2, toDay) || !statement->bind(3, networkKey))
    {
        status = Status::failure(statement->error());
        return rows;
    }

    while (statement->step())
    {
        DailyUsageRow row;
        row.networkKey = statement->columnText(0);
        row.day = statement->columnText(1);
        row.rxBytes = fromStoredBytes(statement->columnInt64(2));
        row.txBytes = fromStoredBytes(statement->columnInt64(3));
        rows.push_back(std::move(row));
    }
    if (statement->failed())
    {
        status = Status::failure(statement->error());
        return {};
    }
    status = Status::success();
    return rows;
}

std::vector<HourlyUsageRow> UsageRepository::hourlyOfDay(const std::string& networkKey, const std::string& day, Status& status) const
{
    std::vector<HourlyUsageRow> rows;
    auto statement = database_.prepare(
        "SELECT network_key, day, hour, rx_bytes, tx_bytes FROM hourly_usage "
        "WHERE day = ?1 AND (?2 = '' OR network_key = ?2) "
        "ORDER BY hour ASC, network_key ASC;",
        status);
    if (!statement)
        return rows;
    if (!statement->bind(1, day) || !statement->bind(2, networkKey))
    {
        status = Status::failure(statement->error());
        return rows;
    }

    while (statement->step())
    {
        HourlyUsageRow row;
        row.networkKey = statement->columnText(0);
        row.day = statement->columnText(1);
        row.hour = static_cast<int>(statement->columnInt64(2));
        row.rxBytes = fromStoredBytes(statement->columnInt64(3));
        row.txBytes = fromStoredBytes(statement->columnInt64(4));
        rows.push_back(std::move(row));
    }
    if (statement->failed())
    {
        status = Status::failure(statement->error());
        return {};
    }
    status = Status::success();
    return rows;
}

Status UsageRepository::setDaily(const std::string& networkKey, const std::string& day, core::ByteCount rx, core::ByteCount tx)
{
    const auto storedRx = toStoredBytes(rx);
    const auto storedTx = toStoredBytes(tx);
    if (!storedRx || !storedTx)
        return Status::failure("用量超出可存储范围。");

    Status status;
    auto statement = database_.prepare(
        "INSERT INTO daily_usage(network_key, day, rx_bytes, tx_bytes) VALUES(?1, ?2, ?3, ?4) "
        "ON CONFLICT(network_key, day) DO UPDATE SET rx_bytes = excluded.rx_bytes, tx_bytes = excluded.tx_bytes;",
        status);
    if (!statement)
        return status;
    if (!statement->bind(1, networkKey) || !statement->bind(2, day) || !statement->bind(3, *storedRx) || !statement->bind(4, *storedTx))
        return Status::failure(statement->error());
    return statement->run();
}

Status UsageRepository::setHourly(const std::string& networkKey, const std::string& day, int hour, core::ByteCount rx, core::ByteCount tx)
{
    if (hour < 0 || hour > 23)
        return Status::failure("小时必须在 0 到 23 之间。");
    const auto storedRx = toStoredBytes(rx);
    const auto storedTx = toStoredBytes(tx);
    if (!storedRx || !storedTx)
        return Status::failure("用量超出可存储范围。");

    Status status;
    auto statement = database_.prepare(
        "INSERT INTO hourly_usage(network_key, day, hour, rx_bytes, tx_bytes) VALUES(?1, ?2, ?3, ?4, ?5) "
        "ON CONFLICT(network_key, day, hour) DO UPDATE SET rx_bytes = excluded.rx_bytes, tx_bytes = excluded.tx_bytes;",
        status);
    if (!statement)
        return status;
    if (!statement->bind(1, networkKey) || !statement->bind(2, day) || !statement->bind(3, static_cast<std::int64_t>(hour)) || !statement->bind(4, *storedRx) || !statement->bind(5, *storedTx))
        return Status::failure(statement->error());
    return statement->run();
}

Status UsageRepository::pruneBefore(const std::string& day, std::size_t& removedDaily, std::size_t& removedHourly)
{
    removedDaily = 0;
    removedHourly = 0;
    Status status;

    // 两张表必须一起裁剪：只删每日记录会让小时明细与总量对不上。
    auto daily = database_.prepare("DELETE FROM daily_usage WHERE day < ?1;", status);
    if (!daily)
        return status;
    if (!daily->bind(1, day))
        return Status::failure(daily->error());
    if (const Status ran = daily->run(); !ran)
        return ran;
    removedDaily = static_cast<std::size_t>(sqlite3_changes(database_.handle()));

    auto hourly = database_.prepare("DELETE FROM hourly_usage WHERE day < ?1;", status);
    if (!hourly)
        return status;
    if (!hourly->bind(1, day))
        return Status::failure(hourly->error());
    if (const Status ran = hourly->run(); !ran)
        return ran;
    removedHourly = static_cast<std::size_t>(sqlite3_changes(database_.handle()));

    return Status::success();
}

Status UsageRepository::addGap(const CoverageGap& gap)
{
    Status status;
    auto statement = database_.prepare("INSERT INTO coverage_gaps(network_key, reason, reason_detail, started_at, ended_at, span_seconds) VALUES(?1, ?2, ?3, ?4, ?5, ?6);", status);
    if (!statement)
        return status;
    const auto span = gap.span.count();
    if (!statement->bind(1, gap.networkKey) || !statement->bind(2, std::string(coverageReasonName(gap.reason))) || !statement->bind(3, gap.reasonDetail) || !statement->bind(4, core::isoUtcOf(gap.startedAt)) || !statement->bind(5, gap.span.count() > 0 ? core::isoUtcOf(gap.endedAt) : std::string()) ||
        !statement->bind(6, static_cast<std::int64_t>(span)))
        return Status::failure(statement->error());
    return statement->run();
}

std::vector<CoverageGap> UsageRepository::gapsInRange(const std::string& fromIso, const std::string& toIso, Status& status) const
{
    std::vector<CoverageGap> gaps;
    auto statement = database_.prepare(
        "SELECT network_key, reason, reason_detail, started_at, ended_at, span_seconds FROM coverage_gaps "
        "WHERE started_at >= ?1 AND started_at <= ?2 ORDER BY started_at ASC;",
        status);
    if (!statement)
        return gaps;
    if (!statement->bind(1, fromIso) || !statement->bind(2, toIso))
    {
        status = Status::failure(statement->error());
        return gaps;
    }

    while (statement->step())
    {
        CoverageGap gap;
        gap.networkKey = statement->columnText(0);
        const auto reason = coverageReasonFromName(statement->columnText(1));
        gap.reason = reason.value_or(CoverageReason::offline);
        gap.reasonDetail = statement->columnText(2);
        core::parseIsoUtc(statement->columnText(3), gap.startedAt);
        core::parseIsoUtc(statement->columnText(4), gap.endedAt);
        gap.span = std::chrono::seconds(statement->columnInt64(5));
        gaps.push_back(std::move(gap));
    }
    if (statement->failed())
    {
        status = Status::failure(statement->error());
        return {};
    }
    status = Status::success();
    return gaps;
}

Status UsageRepository::closeOpenGaps(core::TimePoint endedAt, std::size_t& closed)
{
    closed = 0;
    Status status;
    const std::string end = core::isoUtcOf(endedAt);
    // 时长交给 SQLite 计算，避免把每一行取回来再算。
    auto statement = database_.prepare(
        "UPDATE coverage_gaps SET ended_at = ?1, "
        "span_seconds = MAX(0, CAST(strftime('%s', ?1) AS INTEGER) - CAST(strftime('%s', started_at) AS INTEGER)) "
        "WHERE ended_at = '';",
        status);
    if (!statement)
        return status;
    if (!statement->bind(1, end))
        return Status::failure(statement->error());
    if (const Status ran = statement->run(); !ran)
        return ran;
    closed = static_cast<std::size_t>(sqlite3_changes(database_.handle()));
    return Status::success();
}

Status UsageRepository::clearUsage()
{
    return database_.exec(
        "DELETE FROM daily_usage;"
        "DELETE FROM hourly_usage;"
        "DELETE FROM coverage_gaps;"
        "UPDATE quota_ledgers SET used_bytes = 0;");
}

Status UsageRepository::removeNetwork(const std::string& networkKey)
{
    Status status;
    // 一条 SQL 字符串里放多条语句时 prepare 只会编译第一条，因此逐条准备。
    for (const char* sql : {"DELETE FROM daily_usage WHERE network_key = ?1;", "DELETE FROM hourly_usage WHERE network_key = ?1;", "DELETE FROM coverage_gaps WHERE network_key = ?1;"})
    {
        auto statement = database_.prepare(sql, status);
        if (!statement)
            return status;
        if (!statement->bind(1, networkKey))
            return Status::failure(statement->error());
        if (const Status ran = statement->run(); !ran)
            return ran;
    }
    return Status::success();
}

}  // namespace wifimeter::storage
