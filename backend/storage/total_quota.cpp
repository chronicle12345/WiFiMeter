#include "total_quota.h"
#include "quota_schema.h"
#include "../support/quota_thresholds.h"
#include <algorithm>

#include <sqlite3.h>

#include <cmath>
#include <limits>
#include <set>
#include <utility>

namespace wifimeter::storage
{
namespace
{

const char* periodName(core::QuotaPeriod period)
{
    switch (period)
    {
        case core::QuotaPeriod::day: return "day";
        case core::QuotaPeriod::month: return "month";
        case core::QuotaPeriod::all: return "all";
    }
    return "";
}

core::QuotaPeriod parsePeriod(const std::string& period)
{
    if (period == "all") return core::QuotaPeriod::all;
    return period == "day" ? core::QuotaPeriod::day : core::QuotaPeriod::month;
}

Status validate(const TotalQuotaSettings& settings)
{
    auto thresholds = settings.warnPercents;
    if (!core::normalizeWarnPercents(thresholds, settings.warnPercent)) return Status::failure("Invalid warning thresholds.");
    if (!std::isfinite(settings.capGb) || settings.capGb < 0 || settings.capGb > 9000000000.0 || !std::isfinite(settings.warnPercent) || settings.warnPercent < 1 || settings.warnPercent > 100 || *periodName(settings.period) == '\0')
        return Status::failure("总 WiFi 额度设置无效。上限为 0..9000000000 GB，预警为 1..100，周期为 day/month/all。");
    return Status::success();
}

bool validKey(core::QuotaPeriod period, const std::string& key)
{
    core::TimePoint at;
    if (period == core::QuotaPeriod::all) return key == "all";
    if (period == core::QuotaPeriod::day) return core::parseDayKey(key, at);
    return period == core::QuotaPeriod::month && key.size() == 7 && core::parseDayKey(key + "-01", at);
}

bool addChecked(core::ByteCount& used, core::ByteCount delta)
{
    const auto maximum = static_cast<core::ByteCount>(std::numeric_limits<std::int64_t>::max());
    if (used > maximum || delta > maximum - used) return false;
    used += delta;
    return true;
}

// SQLite SAVEPOINT 兼容外部的恢复事务，失败时只回滚本次仓储操作。
class QuotaTransaction
{
public:
    explicit QuotaTransaction(Database& database) : database_(database), active_(database.exec("SAVEPOINT total_quota_operation;").ok) {}
    ~QuotaTransaction()
    {
        if (active_)
        {
            database_.exec("ROLLBACK TO total_quota_operation;");
            database_.exec("RELEASE total_quota_operation;");
        }
    }
    bool active() const { return active_; }
    Status commit()
    {
        if (!active_) return Status::failure("总额度事务未启动。");
        const Status status = database_.exec("RELEASE total_quota_operation;");
        if (status) active_ = false;
        return status;
    }
private:
    Database& database_;
    bool active_;
};

TotalQuotaLedger ledgerRow(const Statement& statement)
{
    return {parsePeriod(statement.columnText(0)), statement.columnText(1), fromStoredBytes(statement.columnInt64(2)), statement.columnInt64(3) != 0, statement.columnInt64(4) != 0, support::storedThresholds(statement.columnText(5))};
}

core::QuotaSettings coreSettings(const TotalQuotaSettings& settings)
{
    return {settings.capGb, settings.warnPercent, settings.period, settings.warnPercents};
}

}  // namespace

Status TotalQuotaRepository::ensureSchema()
{
    QuotaTransaction transaction(database_);
    if (!transaction.active()) return Status::failure(database_.lastError());
    // 兼容本模块早期建表的 100000 GB 约束，设置与账本在同一事务中保留。
    bool previousCapConstraint = false;
    {
        Status status;
        auto table = database_.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='total_quota_settings';", status);
        if (!table) return status;
        if (table->step()) previousCapConstraint = table->columnText(0).find("cap_gb BETWEEN 0 AND 100000)") != std::string::npos;
        if (table->failed()) return Status::failure(table->error());
    }
    if (previousCapConstraint)
    {
        const Status renamed = database_.exec("ALTER TABLE total_quota_settings RENAME TO total_quota_settings_previous;");
        if (!renamed) return renamed;
    }
    const Status schema = database_.exec(R"SQL(
CREATE TABLE IF NOT EXISTS total_quota_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    cap_gb REAL NOT NULL DEFAULT 0 CHECK(cap_gb BETWEEN 0 AND 9000000000),
    warn_percent INTEGER NOT NULL DEFAULT 80 CHECK(warn_percent BETWEEN 1 AND 100),
    period TEXT NOT NULL DEFAULT 'month' CHECK(period IN ('day', 'month', 'all')),
    notify INTEGER NOT NULL DEFAULT 0 CHECK(notify IN (0, 1)),
    auto_disconnect INTEGER NOT NULL DEFAULT 0 CHECK(auto_disconnect IN (0, 1))
);
INSERT OR IGNORE INTO total_quota_settings(id) VALUES(1);
CREATE TABLE IF NOT EXISTS total_quota_ledgers (
    period TEXT NOT NULL CHECK(period IN ('day', 'month', 'all')),
    period_key TEXT NOT NULL,
    used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(used_bytes) = 'integer' AND used_bytes >= 0),
    warning_notified INTEGER NOT NULL DEFAULT 0 CHECK(warning_notified IN (0, 1)),
    limit_notified INTEGER NOT NULL DEFAULT 0 CHECK(limit_notified IN (0, 1)),
    PRIMARY KEY(period, period_key)
) WITHOUT ROWID;
)SQL");
    if (!schema) return schema;
    if (previousCapConstraint)
    {
        const Status copied = database_.exec(
            "DELETE FROM total_quota_settings;"
            "INSERT INTO total_quota_settings(id,cap_gb,warn_percent,period,notify,auto_disconnect) "
            "SELECT id,cap_gb,warn_percent,period,notify,auto_disconnect FROM total_quota_settings_previous;"
            "DROP TABLE total_quota_settings_previous;");
        if (!copied) return copied;
    }
    if (auto status = ensureQuotaColumn(database_, "total_quota_settings", "warn_percents"); !status) return status;
    if (auto status = ensureQuotaColumn(database_, "total_quota_ledgers", "notified_warn_percents"); !status) return status;
    // Upgrade the old single notification flag without replaying that warning.
    if (auto status = database_.exec("UPDATE total_quota_ledgers SET notified_warn_percents='[' || (SELECT warn_percent FROM total_quota_settings WHERE id=1) || ']' WHERE warning_notified=1 AND notified_warn_percents='[]';"); !status) return status;
    return transaction.commit();
}

TotalQuotaSettings TotalQuotaRepository::readSettings(Status& status) const
{
    TotalQuotaSettings settings;
    auto statement = database_.prepare("SELECT cap_gb, warn_percent, period, notify, auto_disconnect, warn_percents FROM total_quota_settings WHERE id = 1;", status);
    if (!statement) return settings;
    if (!statement->step())
    {
        status = Status::failure(statement->failed() ? statement->error() : "总额度设置不存在。");
        return settings;
    }
    settings = {statement->columnDouble(0), statement->columnDouble(1), parsePeriod(statement->columnText(2)), statement->columnInt64(3) != 0, statement->columnInt64(4) != 0};
    settings.warnPercents = support::storedThresholds(statement->columnText(5));
    core::normalizeWarnPercents(settings.warnPercents, settings.warnPercent);
    settings.warnPercent = settings.warnPercents.front();
    status = validate(settings);
    return settings;
}

Status TotalQuotaRepository::writeSettings(const TotalQuotaSettings& input)
{
    auto settings = input;
    if (!core::normalizeWarnPercents(settings.warnPercents, settings.warnPercent)) return Status::failure("Invalid warning thresholds.");
    settings.warnPercent = settings.warnPercents.front();
    Status status;
    auto statement = database_.prepare("UPDATE total_quota_settings SET cap_gb=?1, warn_percent=?2, period=?3, notify=?4, auto_disconnect=?5, warn_percents=?6 WHERE id=1;", status);
    if (!statement) return status;
    if (!statement->bind(1, settings.capGb) || !statement->bind(2, settings.warnPercent) || !statement->bind(3, std::string(periodName(settings.period))) || !statement->bind(4, static_cast<std::int64_t>(settings.notify)) || !statement->bind(5, static_cast<std::int64_t>(settings.autoDisconnect)) || !statement->bind(6, support::thresholdArray(settings.warnPercents).dump()))
        return Status::failure(statement->error());
    return statement->run();
}

std::optional<TotalQuotaLedger> TotalQuotaRepository::readLedger(core::QuotaPeriod period, const std::string& key, Status& status) const
{
    auto statement = database_.prepare("SELECT period, period_key, used_bytes, warning_notified, limit_notified, notified_warn_percents FROM total_quota_ledgers WHERE period=?1 AND period_key=?2;", status);
    if (!statement) return std::nullopt;
    if (!statement->bind(1, std::string(periodName(period))) || !statement->bind(2, key))
    {
        status = Status::failure(statement->error());
        return std::nullopt;
    }
    if (statement->step()) return ledgerRow(*statement);
    status = statement->failed() ? Status::failure(statement->error()) : Status::success();
    return std::nullopt;
}

Status TotalQuotaRepository::writeLedger(const TotalQuotaLedger& input)
{
    auto ledger = input;
    if (!ledger.notifiedWarnPercents.empty() && !core::normalizeWarnPercents(ledger.notifiedWarnPercents))
        return Status::failure("Invalid warning notification state.");
    const auto used = toStoredBytes(ledger.usedBytes);
    if (!used) return Status::failure("总额度用量超出可存储范围。");
    Status status;
    auto statement = database_.prepare(
        "INSERT INTO total_quota_ledgers(period,period_key,used_bytes,warning_notified,limit_notified,notified_warn_percents) VALUES(?1,?2,?3,?4,?5,?6) "
        "ON CONFLICT(period,period_key) DO UPDATE SET used_bytes=excluded.used_bytes, warning_notified=excluded.warning_notified, limit_notified=excluded.limit_notified, notified_warn_percents=excluded.notified_warn_percents;", status);
    if (!statement) return status;
    if (!statement->bind(1, std::string(periodName(ledger.period))) || !statement->bind(2, ledger.periodKey) || !statement->bind(3, *used) || !statement->bind(4, static_cast<std::int64_t>(ledger.warningNotified)) || !statement->bind(5, static_cast<std::int64_t>(ledger.limitNotified)) || !statement->bind(6, support::thresholdArray(ledger.notifiedWarnPercents).dump()))
        return Status::failure(statement->error());
    return statement->run();
}

Status TotalQuotaRepository::ensurePeriods(core::TimePoint now)
{
    for (const auto period : {core::QuotaPeriod::day, core::QuotaPeriod::month, core::QuotaPeriod::all})
    {
        Status status;
        const std::string key = core::periodKeyFor(period, now);
        const auto existing = readLedger(period, key, status);
        if (!status) return status;
        if (existing) continue;
        // 只在首次建立该周期账本时读取历史；缺失网络元数据沿用旧数据的 WiFi 默认值。
        const std::string from = period == core::QuotaPeriod::all ? "" : period == core::QuotaPeriod::day ? key : key + "-01";
        const std::string to = period == core::QuotaPeriod::all ? "" : period == core::QuotaPeriod::day ? key : key + "-31";
        auto history = database_.prepare(
            "SELECT SUM(d.rx_bytes), SUM(d.tx_bytes) FROM daily_usage d LEFT JOIN networks n ON n.key=d.network_key "
            "WHERE COALESCE(n.type,'wifi') <> 'ethernet' AND (?1='' OR d.day>=?1) AND (?2='' OR d.day<=?2);", status);
        if (!history) return status;
        if (!history->bind(1, from) || !history->bind(2, to)) return Status::failure(history->error());
        if (!history->step()) return Status::failure(history->error());
        const auto rx = history->columnInt64(0), tx = history->columnInt64(1);
        if (rx < 0 || tx < 0) return Status::failure("历史用量包含负值。");
        core::ByteCount used = static_cast<core::ByteCount>(rx);
        if (!addChecked(used, static_cast<core::ByteCount>(tx))) return Status::failure("历史总用量超出可存储范围。");
        if (const Status saved = writeLedger({period, key, used, false, false}); !saved) return saved;
    }
    return Status::success();
}

Status TotalQuotaRepository::addUsage(const core::UsageDelta& delta)
{
    if (sqlite3_get_autocommit(database_.handle())) return Status::failure("总额度增量必须加入用量事务。");
    if (const Status initialized = ensurePeriods(delta.at); !initialized) return initialized;
    if (delta.network.type == "ethernet") return Status::success();
    core::ByteCount increment = delta.rxBytes;
    if (!addChecked(increment, delta.txBytes)) return Status::failure("用量增量超出可存储范围。");
    for (const auto period : {core::QuotaPeriod::day, core::QuotaPeriod::month, core::QuotaPeriod::all})
    {
        Status status;
        auto ledger = readLedger(period, core::periodKeyFor(period, delta.at), status);
        if (!status) return status;
        if (!ledger) return Status::failure("总额度账本不存在。");
        if (!addChecked(ledger->usedBytes, increment)) return Status::failure("总额度用量超出可存储范围。");
        if (const Status saved = writeLedger(*ledger); !saved) return saved;
    }
    return Status::success();
}

TotalQuotaView TotalQuotaRepository::current(core::TimePoint now, Status& status)
{
    TotalQuotaView result;
    QuotaTransaction transaction(database_);
    if (!transaction.active()) { status = Status::failure(database_.lastError()); return result; }
    result.settings = readSettings(status);
    if (!status) return result;
    status = ensurePeriods(now);
    if (!status) return result;
    const auto ledger = readLedger(result.settings.period, core::periodKeyFor(result.settings.period, now), status);
    if (!status || !ledger) return result;
    result.ledger = *ledger;
    result.quota = core::quotaStateOf(coreSettings(result.settings), ledger->usedBytes, now);
    result.warningPending = result.settings.notify && std::any_of(result.settings.warnPercents.begin(), result.settings.warnPercents.end(), [&](double threshold) {
        return result.quota.reachedWarn(threshold) && std::find(ledger->notifiedWarnPercents.begin(), ledger->notifiedWarnPercents.end(), threshold) == ledger->notifiedWarnPercents.end();
    });
    result.limitPending = (result.settings.notify || result.settings.autoDisconnect) && !ledger->limitNotified && result.quota.reachedLimit();
    status = transaction.commit();
    return result;
}

TotalQuotaSnapshot TotalQuotaRepository::load(Status& status) const
{
    TotalQuotaSnapshot snapshot;
    QuotaTransaction transaction(database_);
    if (!transaction.active()) { status = Status::failure(database_.lastError()); return snapshot; }
    snapshot.settings = readSettings(status);
    if (!status) return snapshot;
    auto statement = database_.prepare("SELECT period, period_key, used_bytes, warning_notified, limit_notified, notified_warn_percents FROM total_quota_ledgers ORDER BY period, period_key;", status);
    if (!statement) return snapshot;
    while (statement->step()) snapshot.ledgers.push_back(ledgerRow(*statement));
    if (statement->failed()) { status = Status::failure(statement->error()); return {}; }
    status = transaction.commit();
    return snapshot;
}

Status TotalQuotaRepository::save(const TotalQuotaSettings& settings, core::TimePoint now)
{
    if (const Status valid = validate(settings); !valid) return valid;
    QuotaTransaction transaction(database_);
    if (!transaction.active()) return Status::failure(database_.lastError());
    Status status;
    const auto old = readSettings(status);
    if (!status) return status;
    if (const Status initialized = ensurePeriods(now); !initialized) return initialized;
    if (old.capGb != settings.capGb)
    {
        if (const Status reset = database_.exec("UPDATE total_quota_ledgers SET warning_notified=0, limit_notified=0, notified_warn_percents='[]';"); !reset) return reset;
    }
    if (const Status saved = writeSettings(settings); !saved) return saved;
    return transaction.commit();
}

Status TotalQuotaRepository::save(const TotalQuotaSnapshot& snapshot)
{
    if (const Status valid = validate(snapshot.settings); !valid) return valid;
    std::set<std::pair<core::QuotaPeriod, std::string>> keys;
    for (const auto& ledger : snapshot.ledgers)
    {
        if (!validKey(ledger.period, ledger.periodKey) || !toStoredBytes(ledger.usedBytes) || !keys.emplace(ledger.period, ledger.periodKey).second)
            return Status::failure("备份中的总额度账本无效或周期重复。");
    }
    QuotaTransaction transaction(database_);
    if (!transaction.active()) return Status::failure(database_.lastError());
    if (const Status saved = writeSettings(snapshot.settings); !saved) return saved;
    if (const Status cleared = database_.exec("DELETE FROM total_quota_ledgers;"); !cleared) return cleared;
    for (auto ledger : snapshot.ledgers) {
        if (ledger.warningNotified && ledger.notifiedWarnPercents.empty()) {
            auto thresholds = snapshot.settings.warnPercents;
            core::normalizeWarnPercents(thresholds, snapshot.settings.warnPercent);
            ledger.notifiedWarnPercents = {thresholds.front()};
        }
        if (const Status saved = writeLedger(ledger); !saved) return saved;
    }
    return transaction.commit();
}

Status TotalQuotaRepository::markNotified(core::QuotaPeriod period, const std::string& periodKey, TotalQuotaNotification notification, bool& marked, double threshold)
{
    marked = false;
    if (!validKey(period, periodKey) || (notification != TotalQuotaNotification::warning && notification != TotalQuotaNotification::limit))
        return Status::failure("总额度通知周期或类型无效。");
    QuotaTransaction transaction(database_);
    if (!transaction.active()) return Status::failure(database_.lastError());
    Status status;
    const auto settings = readSettings(status);
    if (!status) return status;
    const auto ledger = readLedger(period, periodKey, status);
    if (!status) return status;
    if (!ledger || settings.period != period) return transaction.commit();
    const auto quota = core::quotaStateOf(coreSettings(settings), ledger->usedBytes, core::TimePoint{});
    const bool warning = notification == TotalQuotaNotification::warning;
    if (warning)
    {
        auto updated = *ledger;
        const auto candidates = threshold == 0 ? settings.warnPercents : std::vector<double>{threshold};
        bool changed = false;
        for (double candidate : candidates)
        {
            if (!settings.notify || !quota.reachedWarn(candidate) || std::find(settings.warnPercents.begin(), settings.warnPercents.end(), candidate) == settings.warnPercents.end()) continue;
            if (std::find(updated.notifiedWarnPercents.begin(), updated.notifiedWarnPercents.end(), candidate) != updated.notifiedWarnPercents.end()) continue;
            updated.notifiedWarnPercents.push_back(candidate);
            changed = true;
            if (threshold == 0) break;
        }
        if (changed) {
            core::normalizeWarnPercents(updated.notifiedWarnPercents);
            updated.warningNotified = true;
            if (auto saved = writeLedger(updated); !saved) return saved;
        }
        status = transaction.commit();
        if (status) marked = changed;
        return status;
    }
    const bool eligible = (settings.notify || settings.autoDisconnect) && quota.reachedLimit();
    if (!eligible) return transaction.commit();
    const std::string flag = "limit_notified";
    auto statement = database_.prepare("UPDATE total_quota_ledgers SET " + flag + "=1 WHERE period=?1 AND period_key=?2 AND " + flag + "=0;", status);
    if (!statement) return status;
    if (!statement->bind(1, std::string(periodName(period))) || !statement->bind(2, periodKey)) return Status::failure(statement->error());
    if (const Status ran = statement->run(); !ran) return ran;
    const bool changed = sqlite3_changes(database_.handle()) != 0;
    status = transaction.commit();
    if (status) marked = changed;
    return status;
}

Status TotalQuotaRepository::clearUsage()
{
    return database_.exec("UPDATE total_quota_ledgers SET used_bytes=0, warning_notified=0, limit_notified=0, notified_warn_percents='[]';");
}

}  // namespace wifimeter::storage
