#include "network_repository.h"

#include <sqlite3.h>

namespace wifimeter::storage
{
namespace
{

const char* kPeriodName(core::QuotaPeriod period)
{
    return period == core::QuotaPeriod::day ? "day" : "month";
}

core::QuotaPeriod parsePeriod(const std::string& name)
{
    return name == "day" ? core::QuotaPeriod::day : core::QuotaPeriod::month;
}

NetworkRecord readRow(const Statement& statement)
{
    NetworkRecord record;
    record.key = statement.columnText(0);
    record.ssid = statement.columnText(1);
    record.alias = statement.columnText(2);
    record.type = statement.columnText(3);
    record.capGb = statement.columnDouble(4);
    record.warnPercent = static_cast<int>(statement.columnInt64(5));
    record.quotaPeriod = parsePeriod(statement.columnText(6));
    record.notify = statement.columnInt64(7) != 0;
    record.autoDisconnect = statement.columnInt64(8) != 0;
    record.firstSeenAt = statement.columnText(9);
    record.lastSeenAt = statement.columnText(10);
    return record;
}

const char* kSelectColumns = "SELECT key, ssid, alias, type, cap_gb, warn_percent, quota_period, notify, auto_disconnect, first_seen_at, last_seen_at FROM networks";

}  // namespace

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
            "VALUES(?1, ?2, '', 'wifi', 0, 80, 'month', 0, 0, ?3, ?3);",
            status);
        if (!insert)
            return status;
        if (!insert->bind(1, network.key) || !insert->bind(2, network.ssid) || !insert->bind(3, seenAtIso))
            return Status::failure(insert->error());
        if (const Status ran = insert->run(); !ran)
            return ran;
        created = true;
        return Status::success();
    }

    // 已存在时只刷新 ssid 与最近出现时间：备注、额度与首次出现时间属于用户数据。
    auto update = database_.prepare("UPDATE networks SET ssid = ?2, last_seen_at = ?3 WHERE key = ?1;", status);
    if (!update)
        return status;
    if (!update->bind(1, network.key) || !update->bind(2, network.ssid) || !update->bind(3, seenAtIso))
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

Status NetworkRepository::updateUserSettings(const std::string& key, const std::string& alias, double capGb, int warnPercent, core::QuotaPeriod period, bool notify, bool autoDisconnect)
{
    Status status;
    auto statement = database_.prepare("UPDATE networks SET alias = ?2, cap_gb = ?3, warn_percent = ?4, quota_period = ?5, notify = ?6, auto_disconnect = ?7 WHERE key = ?1;", status);
    if (!statement)
        return status;
    if (!statement->bind(1, key) || !statement->bind(2, alias) || !statement->bind(3, capGb) || !statement->bind(4, static_cast<std::int64_t>(warnPercent)) || !statement->bind(5, std::string(kPeriodName(period))) || !statement->bind(6, static_cast<std::int64_t>(notify ? 1 : 0)) ||
        !statement->bind(7, static_cast<std::int64_t>(autoDisconnect ? 1 : 0)))
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

Status NetworkRepository::replace(const NetworkRecord& record)
{
    Status status;
    auto statement = database_.prepare(
        "INSERT INTO networks(key, ssid, alias, type, cap_gb, warn_percent, quota_period, notify, auto_disconnect, first_seen_at, last_seen_at) "
        "VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) "
        "ON CONFLICT(key) DO UPDATE SET ssid = excluded.ssid, alias = excluded.alias, type = excluded.type, cap_gb = excluded.cap_gb, "
        "warn_percent = excluded.warn_percent, quota_period = excluded.quota_period, notify = excluded.notify, "
        "auto_disconnect = excluded.auto_disconnect, first_seen_at = excluded.first_seen_at, last_seen_at = excluded.last_seen_at;",
        status);
    if (!statement)
        return status;
    if (!statement->bind(1, record.key) || !statement->bind(2, record.ssid) || !statement->bind(3, record.alias) || !statement->bind(4, record.type) || !statement->bind(5, record.capGb) || !statement->bind(6, static_cast<std::int64_t>(record.warnPercent)) ||
        !statement->bind(7, std::string(kPeriodName(record.quotaPeriod))) || !statement->bind(8, static_cast<std::int64_t>(record.notify ? 1 : 0)) || !statement->bind(9, static_cast<std::int64_t>(record.autoDisconnect ? 1 : 0)) || !statement->bind(10, record.firstSeenAt) ||
        !statement->bind(11, record.lastSeenAt))
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
    auto statement = database_.prepare("SELECT network_key, period_key, used_bytes FROM quota_ledgers WHERE network_key = ?1;", status);
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
    status = Status::success();
    return record;
}

std::vector<QuotaLedgerRecord> NetworkRepository::allLedgers(Status& status) const
{
    std::vector<QuotaLedgerRecord> records;
    auto statement = database_.prepare("SELECT network_key, period_key, used_bytes FROM quota_ledgers ORDER BY network_key ASC;", status);
    if (!statement)
        return records;
    while (statement->step())
    {
        QuotaLedgerRecord record;
        record.networkKey = statement->columnText(0);
        record.periodKey = statement->columnText(1);
        record.usedBytes = fromStoredBytes(statement->columnInt64(2));
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

Status NetworkRepository::saveLedger(const QuotaLedgerRecord& record)
{
    const auto used = toStoredBytes(record.usedBytes);
    if (!used)
        return Status::failure("额度用量超出可存储范围。");

    Status status;
    auto statement = database_.prepare(
        "INSERT INTO quota_ledgers(network_key, period_key, used_bytes) VALUES(?1, ?2, ?3) "
        "ON CONFLICT(network_key) DO UPDATE SET period_key = excluded.period_key, used_bytes = excluded.used_bytes;",
        status);
    if (!statement)
        return status;
    if (!statement->bind(1, record.networkKey) || !statement->bind(2, record.periodKey) || !statement->bind(3, *used))
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
