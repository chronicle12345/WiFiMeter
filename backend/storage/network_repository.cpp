#include "network_repository.h"
#include "quota_schema.h"
#include "../support/quota_thresholds.h"

#include <sqlite3.h>
#include <cmath>

namespace wifimeter::storage
{
namespace
{

const char* kPeriodName(core::QuotaPeriod period)
{
    return period == core::QuotaPeriod::all ? "all" : period == core::QuotaPeriod::day ? "day" : "month";
}

core::QuotaPeriod parsePeriod(const std::string& name)
{
    return name == "all" ? core::QuotaPeriod::all : name == "day" ? core::QuotaPeriod::day : core::QuotaPeriod::month;
}

NetworkRecord readRow(const Statement& statement)
{
    NetworkRecord record;
    record.key = statement.columnText(0);
    record.ssid = statement.columnText(1);
    record.alias = statement.columnText(2);
    record.type = statement.columnText(3);
    record.capGb = statement.columnDouble(4);
    record.warnPercent = statement.columnDouble(5);
    record.quotaPeriod = parsePeriod(statement.columnText(6));
    record.notify = statement.columnInt64(7) != 0;
    record.autoDisconnect = statement.columnInt64(8) != 0;
    record.firstSeenAt = statement.columnText(9);
    record.lastSeenAt = statement.columnText(10);
    record.warnPercents = support::storedThresholds(statement.columnText(11));
    core::normalizeWarnPercents(record.warnPercents, record.warnPercent);
    record.warnPercent = record.warnPercents.front();
    return record;
}

const char* kSelectColumns = "SELECT key, ssid, alias, type, cap_gb, warn_percent, quota_period, notify, auto_disconnect, first_seen_at, last_seen_at, warn_percents FROM networks";

}  // namespace

Status NetworkRepository::ensureSchema()
{
    if (auto status = ensureQuotaColumn(database_, "networks", "warn_percents"); !status) return status;
    return ensureQuotaColumn(database_, "quota_ledgers", "notified_warn_percents");
}

Status NetworkRepository::observe(const core::NetworkRef& network, const std::string& seenAtIso, bool& created)
{
    created = false;
    if (!network.valid())
        return Status::failure("网络身份无效，无法登记。");

    Status status;
    auto existing = database_.prepare("SELECT 1 FROM networks WHERE key = ?1;", status);
    if (!existing)
        return status;
    if (!existing->bind(1, network.key))
        return Status::failure(existing->error());
    const bool known = existing->step();
    if (existing->failed())
        return Status::failure(existing->error());

    if (!known)
    {
        auto insert = database_.prepare(
            "INSERT INTO networks(key, ssid, alias, type, cap_gb, warn_percent, quota_period, notify, auto_disconnect, first_seen_at, last_seen_at) "
            "VALUES(?1, ?2, '', ?4, 0, 80, 'month', 0, 0, ?3, ?3);",
            status);
        if (!insert)
            return status;
        if (!insert->bind(1, network.key) || !insert->bind(2, network.ssid) || !insert->bind(3, seenAtIso) || !insert->bind(4, network.type))
            return Status::failure(insert->error());
        if (const Status ran = insert->run(); !ran)
            return ran;
        created = true;
        return Status::success();
    }

    // 已存在时只刷新 ssid 与最近出现时间：备注、额度与首次出现时间属于用户数据。
    auto update = database_.prepare("UPDATE networks SET ssid = ?2, last_seen_at = ?3, type = ?4 WHERE key = ?1;", status);
    if (!update)
        return status;
    if (!update->bind(1, network.key) || !update->bind(2, network.ssid) || !update->bind(3, seenAtIso) || !update->bind(4, network.type))
        return Status::failure(update->error());
    return update->run();
}

std::vector<NetworkRecord> NetworkRepository::all(Status& status) const
{
    std::vector<NetworkRecord> records;
    auto statement = database_.prepare(std::string(kSelectColumns) + " ORDER BY last_seen_at DESC, key ASC;", status);
    if (!statement)
        return records;
    while (statement->step())
        records.push_back(readRow(*statement));
    if (statement->failed())
    {
        status = Status::failure(statement->error());
        return {};
    }
    status = Status::success();
    return records;
}

std::optional<NetworkRecord> NetworkRepository::find(const std::string& key, Status& status) const
{
    auto statement = database_.prepare(std::string(kSelectColumns) + " WHERE key = ?1;", status);
    if (!statement)
        return std::nullopt;
    if (!statement->bind(1, key))
    {
        status = Status::failure(statement->error());
        return std::nullopt;
    }
    if (!statement->step())
    {
        if (statement->failed())
        {
            status = Status::failure(statement->error());
            return std::nullopt;
        }
        status = Status::success();
        return std::nullopt;
    }
    status = Status::success();
    return readRow(*statement);
}

Status NetworkRepository::updateUserSettings(const std::string& key, const std::string& alias, double capGb, double warnPercent, core::QuotaPeriod period, bool notify, bool autoDisconnect, const std::vector<double>& warnPercents)
{
    auto thresholds = warnPercents;
    if (!core::normalizeWarnPercents(thresholds, warnPercent)) return Status::failure("Invalid warning thresholds.");
    warnPercent = thresholds.front();
    if (!std::isfinite(capGb) || capGb < 0 || capGb > 9000000000.0 || (capGb > 0 && capGb < 1e-9)) return Status::failure("Invalid quota size.");
    if (!std::isfinite(warnPercent) || warnPercent < 1 || warnPercent > 100) return Status::failure("Invalid warning threshold.");
    Status status;
    auto statement = database_.prepare("UPDATE networks SET alias = ?2, cap_gb = ?3, warn_percent = ?4, quota_period = ?5, notify = ?6, auto_disconnect = ?7, warn_percents = ?8 WHERE key = ?1;", status);
    if (!statement)
        return status;
    if (!statement->bind(1, key) || !statement->bind(2, alias) || !statement->bind(3, capGb) || !statement->bind(4, warnPercent) || !statement->bind(5, std::string(kPeriodName(period))) || !statement->bind(6, static_cast<std::int64_t>(notify ? 1 : 0)) ||
        !statement->bind(7, static_cast<std::int64_t>(autoDisconnect ? 1 : 0)) || !statement->bind(8, support::thresholdArray(thresholds).dump()))
        return Status::failure(statement->error());
    if (const Status ran = statement->run(); !ran)
        return ran;
    if (sqlite3_changes(database_.handle()) == 0)
        return Status::failure("网络不存在：" + key);
    return Status::success();
}

Status NetworkRepository::remove(const std::string& key)
{
    Status status;
    // 一条 SQL 字符串里的多条语句只有第一条会被 prepare 编译，因此逐条执行。
    auto statement = database_.prepare("DELETE FROM networks WHERE key = ?1;", status);
    if (!statement)
        return status;
    if (!statement->bind(1, key))
        return Status::failure(statement->error());
    if (const Status ran = statement->run(); !ran)
        return ran;

    auto ledger = database_.prepare("DELETE FROM quota_ledgers WHERE network_key = ?1;", status);
    if (!ledger)
        return status;
    if (!ledger->bind(1, key))
        return Status::failure(ledger->error());
    return ledger->run();
}

Status NetworkRepository::replace(const NetworkRecord& input)
{
    auto record = input;
    if (!core::normalizeWarnPercents(record.warnPercents, record.warnPercent)) return Status::failure("Invalid warning thresholds.");
    record.warnPercent = record.warnPercents.front();
    if (!std::isfinite(record.capGb) || record.capGb < 0 || record.capGb > 9000000000.0 || (record.capGb > 0 && record.capGb < 1e-9)) return Status::failure("Invalid quota size.");
    if (!std::isfinite(record.warnPercent) || record.warnPercent < 1 || record.warnPercent > 100) return Status::failure("Invalid warning threshold.");
    Status status;
    auto statement = database_.prepare(
        "INSERT INTO networks(key, ssid, alias, type, cap_gb, warn_percent, quota_period, notify, auto_disconnect, first_seen_at, last_seen_at, warn_percents) "
        "VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) "
        "ON CONFLICT(key) DO UPDATE SET ssid = excluded.ssid, alias = excluded.alias, type = excluded.type, cap_gb = excluded.cap_gb, "
        "warn_percent = excluded.warn_percent, warn_percents = excluded.warn_percents, quota_period = excluded.quota_period, notify = excluded.notify, "
        "auto_disconnect = excluded.auto_disconnect, first_seen_at = excluded.first_seen_at, last_seen_at = excluded.last_seen_at;",
        status);
    if (!statement)
        return status;
    if (!statement->bind(1, record.key) || !statement->bind(2, record.ssid) || !statement->bind(3, record.alias) || !statement->bind(4, record.type) || !statement->bind(5, record.capGb) || !statement->bind(6, record.warnPercent) ||
        !statement->bind(7, std::string(kPeriodName(record.quotaPeriod))) || !statement->bind(8, static_cast<std::int64_t>(record.notify ? 1 : 0)) || !statement->bind(9, static_cast<std::int64_t>(record.autoDisconnect ? 1 : 0)) || !statement->bind(10, record.firstSeenAt) ||
        !statement->bind(11, record.lastSeenAt) || !statement->bind(12, support::thresholdArray(record.warnPercents).dump()))
        return Status::failure(statement->error());
    return statement->run();
}

Status NetworkRepository::removeAll()
{
    Status status;
    auto statement = database_.prepare("DELETE FROM networks;", status);
    if (!statement)
        return status;
    if (const Status ran = statement->run(); !ran)
        return ran;
    auto ledgers = database_.prepare("DELETE FROM quota_ledgers;", status);
    if (!ledgers)
        return status;
    return ledgers->run();
}

std::optional<QuotaLedgerRecord> NetworkRepository::ledger(const std::string& key, Status& status) const
{
    auto statement = database_.prepare("SELECT network_key, period_key, used_bytes, notified_warn_percents FROM quota_ledgers WHERE network_key = ?1;", status);
    if (!statement)
        return std::nullopt;
    if (!statement->bind(1, key))
    {
        status = Status::failure(statement->error());
        return std::nullopt;
    }
    if (!statement->step())
    {
        if (statement->failed())
        {
            status = Status::failure(statement->error());
            return std::nullopt;
        }
        status = Status::success();
        return std::nullopt;
    }
    QuotaLedgerRecord record;
    record.networkKey = statement->columnText(0);
    record.periodKey = statement->columnText(1);
    record.usedBytes = fromStoredBytes(statement->columnInt64(2));
    record.notifiedWarnPercents = support::storedThresholds(statement->columnText(3));
    status = Status::success();
    return record;
}

std::vector<QuotaLedgerRecord> NetworkRepository::allLedgers(Status& status) const
{
    std::vector<QuotaLedgerRecord> records;
    auto statement = database_.prepare("SELECT network_key, period_key, used_bytes, notified_warn_percents FROM quota_ledgers ORDER BY network_key ASC;", status);
    if (!statement)
        return records;
    while (statement->step())
    {
        QuotaLedgerRecord record;
        record.networkKey = statement->columnText(0);
        record.periodKey = statement->columnText(1);
        record.usedBytes = fromStoredBytes(statement->columnInt64(2));
        record.notifiedWarnPercents = support::storedThresholds(statement->columnText(3));
        records.push_back(std::move(record));
    }
    if (statement->failed())
    {
        status = Status::failure(statement->error());
        return {};
    }
    status = Status::success();
    return records;
}

Status NetworkRepository::saveLedger(const QuotaLedgerRecord& input)
{
    auto record = input;
    if (!record.notifiedWarnPercents.empty() && !core::normalizeWarnPercents(record.notifiedWarnPercents))
        return Status::failure("Invalid warning notification state.");
    const auto used = toStoredBytes(record.usedBytes);
    if (!used)
        return Status::failure("额度用量超出可存储范围。");

    Status status;
    auto statement = database_.prepare(
        "INSERT INTO quota_ledgers(network_key, period_key, used_bytes, notified_warn_percents) VALUES(?1, ?2, ?3, ?4) "
        "ON CONFLICT(network_key) DO UPDATE SET period_key = excluded.period_key, used_bytes = excluded.used_bytes, notified_warn_percents = excluded.notified_warn_percents;",
        status);
    if (!statement)
        return status;
    if (!statement->bind(1, record.networkKey) || !statement->bind(2, record.periodKey) || !statement->bind(3, *used) || !statement->bind(4, support::thresholdArray(record.notifiedWarnPercents).dump()))
        return Status::failure(statement->error());
    return statement->run();
}

Status NetworkRepository::clearLedger(const std::string& key)
{
    Status status;
    auto statement = database_.prepare("DELETE FROM quota_ledgers WHERE network_key = ?1;", status);
    if (!statement)
        return status;
    if (!statement->bind(1, key))
        return Status::failure(statement->error());
    return statement->run();
}

}  // namespace wifimeter::storage
