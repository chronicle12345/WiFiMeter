#include "../storage/store.h"
#include "../storage/total_quota.h"
#include "test_support.h"

#include <limits>

using namespace wifimeter::core;
using namespace wifimeter::storage;
using wifimeter::test::TempDirectory;
using wifimeter::test::utcTime;

namespace
{

Status add(Store& store, TimePoint at, ByteCount rx, ByteCount tx = 0, const std::string& type = "wifi")
{
    AccumulateResult result;
    result.deltas.push_back({NetworkRef{type + "-network", type, type}, "adapter", rx, tx, at, std::chrono::seconds(5)});
    ApplySummary summary;
    return store.applyUsage(result, at, summary);
}

TotalQuotaView view(Store& store, TimePoint now)
{
    Status status;
    auto value = store.totalQuota().current(now, status);
    WIFIMETER_CHECK(status.ok);
    return value;
}

void wiredTypePropagatesThroughUsage()
{
    TempDirectory directory("total-wired-type");
    Status status;
    auto store = Store::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(store != nullptr);
    if (!store) return;
    const auto now = utcTime(2026, 10, 1);
    WIFIMETER_CHECK(add(*store, now, 90, 10).ok);

    // 首次采样走 observe 的 INSERT，类型必须来自 NetworkRef。
    WIFIMETER_CHECK(add(*store, now, 400, 100, "ethernet").ok);
    auto wired = store->networks().find("ethernet-network", status);
    WIFIMETER_CHECK(status.ok);
    WIFIMETER_CHECK(wired.has_value());
    if (!wired) return;
    WIFIMETER_CHECK_EQ(wired->type, std::string("ethernet"));
    WIFIMETER_CHECK_EQ(view(*store, now).ledger.usedBytes, ByteCount{100});

    // 模拟旧数据中的错误类型，下一次采样走 UPDATE 并修正，保留用户备注。
    wired->type = "wifi";
    wired->alias = "办公室有线";
    WIFIMETER_CHECK(store->networks().replace(*wired).ok);
    WIFIMETER_CHECK(add(*store, now, 15, 5, "ethernet").ok);
    wired = store->networks().find("ethernet-network", status);
    WIFIMETER_CHECK(status.ok);
    WIFIMETER_CHECK(wired.has_value());
    if (!wired) return;
    WIFIMETER_CHECK_EQ(wired->type, std::string("ethernet"));
    WIFIMETER_CHECK_EQ(wired->alias, std::string("办公室有线"));
    const auto snapshot = store->totalQuota().load(status);
    WIFIMETER_CHECK(status.ok);
    WIFIMETER_CHECK_EQ(snapshot.ledgers.size(), std::size_t{3});
    for (const auto& ledger : snapshot.ledgers)
        WIFIMETER_CHECK_EQ(ledger.usedBytes, ByteCount{100});

    // 有线仍正常写入历史，只从总 WiFi 额度中排除。
    const auto rows = store->usage().dailyRange("ethernet-network", "2026-10-01", "2026-10-01", status);
    WIFIMETER_CHECK(status.ok);
    WIFIMETER_CHECK_EQ(rows.size(), std::size_t{1});
    if (!rows.empty()) WIFIMETER_CHECK_EQ(rows.front().rxBytes + rows.front().txBytes, ByteCount{520});
}

void historyAndPeriods()
{
    TempDirectory directory("total-history");
    Status status;
    auto store = Store::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(store != nullptr);
    if (!store) return;
    const int version = store->database().schemaVersion();
    WIFIMETER_CHECK(store->totalQuota().ensureSchema().ok);
    WIFIMETER_CHECK_EQ(store->database().schemaVersion(), version);
    NetworkRecord wifi;
    wifi.key = "wifi-network";
    NetworkRecord wired;
    wired.key = "ethernet-network";
    wired.type = "ethernet";
    WIFIMETER_CHECK(store->networks().replace(wifi).ok);
    WIFIMETER_CHECK(store->networks().replace(wired).ok);
    WIFIMETER_CHECK(store->usage().setDaily(wifi.key, "2026-09-29", 100, 10).ok);
    WIFIMETER_CHECK(store->usage().setDaily(wifi.key, "2026-09-30", 200, 20).ok);
    WIFIMETER_CHECK(store->usage().setDaily(wired.key, "2026-09-30", 9000, 1000).ok);
    const auto before = utcTime(2026, 9, 30, 23, 59);
    TotalQuotaSettings settings;
    settings.period = QuotaPeriod::day;
    WIFIMETER_CHECK(store->totalQuota().save(settings, before).ok);
    WIFIMETER_CHECK_EQ(view(*store, before).ledger.usedBytes, ByteCount{220});
    WIFIMETER_CHECK(add(*store, before, 30, 3).ok);
    WIFIMETER_CHECK(add(*store, before, 8000, 0, "ethernet").ok);
    WIFIMETER_CHECK_EQ(view(*store, before).ledger.usedBytes, ByteCount{253});
    const auto after = utcTime(2026, 10, 1, 0, 1);
    WIFIMETER_CHECK(add(*store, after, 40, 4).ok);
    WIFIMETER_CHECK_EQ(view(*store, after).ledger.usedBytes, ByteCount{44});
    settings.period = QuotaPeriod::month;
    WIFIMETER_CHECK(store->totalQuota().save(settings, before).ok);
    WIFIMETER_CHECK_EQ(view(*store, before).ledger.usedBytes, ByteCount{363});
    WIFIMETER_CHECK_EQ(view(*store, after).ledger.usedBytes, ByteCount{44});
    settings.period = QuotaPeriod::all;
    WIFIMETER_CHECK(store->totalQuota().save(settings, after).ok);
    WIFIMETER_CHECK_EQ(view(*store, after).ledger.usedBytes, ByteCount{407});
    WIFIMETER_CHECK_EQ(view(*store, after).quota.periodKey, std::string("all"));
    // 晚到的上一周期增量不能覆盖下一周期账本。
    WIFIMETER_CHECK(add(*store, before, 5).ok);
    WIFIMETER_CHECK_EQ(view(*store, after).ledger.usedBytes, ByteCount{412});
    settings.period = QuotaPeriod::month;
    WIFIMETER_CHECK(store->totalQuota().save(settings, after).ok);
    WIFIMETER_CHECK_EQ(view(*store, after).ledger.usedBytes, ByteCount{44});
    WIFIMETER_CHECK_EQ(view(*store, before).ledger.usedBytes, ByteCount{368});
    auto preferences = store->settings().load(status);
    preferences.retentionDays = 1;
    WIFIMETER_CHECK(store->settings().save(preferences).ok);
    std::size_t daily = 0, hourly = 0;
    WIFIMETER_CHECK(store->pruneByRetention(utcTime(2026, 10, 3), daily, hourly).ok);
    WIFIMETER_CHECK(daily > 0);
    store.reset();
    store = Store::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(store != nullptr);
    if (!store) return;
    WIFIMETER_CHECK_EQ(view(*store, after).ledger.usedBytes, ByteCount{44});
    settings.period = QuotaPeriod::all;
    WIFIMETER_CHECK(store->totalQuota().save(settings, after).ok);
    WIFIMETER_CHECK_EQ(view(*store, after).ledger.usedBytes, ByteCount{412});
    WIFIMETER_CHECK_EQ(store->networks().all(status).size(), std::size_t{2});
}

void thresholdsAndRestore()
{
    TempDirectory directory("total-notify");
    Status status;
    auto store = Store::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(store != nullptr);
    if (!store) return;
    const auto now = utcTime(2026, 10, 1);
    TotalQuotaSettings settings;
    settings.capGb = 0.000001;  // 1000 字节
    settings.warnPercent = 80;
    settings.period = QuotaPeriod::all;
    settings.notify = true;
    WIFIMETER_CHECK(store->totalQuota().save(settings, now).ok);
    WIFIMETER_CHECK(add(*store, now, 799).ok);
    WIFIMETER_CHECK(!view(*store, now).warningPending);
    WIFIMETER_CHECK(add(*store, now, 1).ok);
    WIFIMETER_CHECK(view(*store, now).warningPending);
    WIFIMETER_CHECK(!view(*store, now).limitPending);
    bool marked = false;
    WIFIMETER_CHECK(store->totalQuota().markNotified(QuotaPeriod::all, "all", TotalQuotaNotification::warning, marked).ok);
    WIFIMETER_CHECK(marked);
    WIFIMETER_CHECK(store->totalQuota().markNotified(QuotaPeriod::all, "all", TotalQuotaNotification::warning, marked).ok);
    WIFIMETER_CHECK(!marked);
    WIFIMETER_CHECK(store->totalQuota().markNotified(QuotaPeriod::all, "all", TotalQuotaNotification::limit, marked).ok);
    WIFIMETER_CHECK(!marked);
    store.reset();
    store = Store::open(directory.file("meter.db"), status);
    if (!store) { WIFIMETER_CHECK(false); return; }
    WIFIMETER_CHECK(!view(*store, now).warningPending);
    WIFIMETER_CHECK(add(*store, utcTime(2027, 1, 1), 200).ok);
    WIFIMETER_CHECK(view(*store, now).limitPending);
    WIFIMETER_CHECK(store->totalQuota().markNotified(QuotaPeriod::all, "all", TotalQuotaNotification::limit, marked).ok);
    WIFIMETER_CHECK(marked);
    WIFIMETER_CHECK(store->totalQuota().save(settings, now).ok);
    WIFIMETER_CHECK(!view(*store, now).warningPending);
    WIFIMETER_CHECK(!view(*store, now).limitPending);
    auto backup = store->totalQuota().load(status);
    WIFIMETER_CHECK(status.ok);
    WIFIMETER_CHECK(store->clearUsage().ok);
    WIFIMETER_CHECK_EQ(view(*store, now).ledger.usedBytes, ByteCount{0});
    // 与调用者的恢复事务组合；普通结构保存全部账本和通知标志。
    {
        Transaction transaction(store->database());
        WIFIMETER_CHECK(store->totalQuota().save(backup).ok);
        WIFIMETER_CHECK(transaction.commit().ok);
    }
    WIFIMETER_CHECK_EQ(view(*store, now).ledger.usedBytes, ByteCount{1000});
    WIFIMETER_CHECK(!view(*store, now).limitPending);
    settings.capGb = 0.000002;
    WIFIMETER_CHECK(store->totalQuota().save(settings, now).ok);
    WIFIMETER_CHECK(!view(*store, now).warningPending);
    WIFIMETER_CHECK(add(*store, now, 600).ok);
    WIFIMETER_CHECK(view(*store, now).warningPending);
    settings.capGb = std::numeric_limits<double>::infinity();
    WIFIMETER_CHECK(!store->totalQuota().save(settings, now).ok);
    settings.capGb = -1;
    WIFIMETER_CHECK(!store->totalQuota().save(settings, now).ok);
    settings.capGb = 2;
    settings.warnPercent = 101;
    WIFIMETER_CHECK(!store->totalQuota().save(settings, now).ok);
    WIFIMETER_CHECK_EQ(view(*store, now).settings.capGb, 0.000002);
    backup.ledgers.front().periodKey = "not-a-period";
    WIFIMETER_CHECK(!store->totalQuota().save(backup).ok);
    WIFIMETER_CHECK_EQ(view(*store, now).ledger.usedBytes, ByteCount{1600});
}

void atomicUsageAndSettings()
{
    TempDirectory directory("total-atomic");
    Status status;
    auto store = Store::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(store != nullptr);
    if (!store) return;
    const auto now = utcTime(2026, 10, 1);
    WIFIMETER_CHECK(add(*store, now, 100).ok);
    // 用真实 SQLite 失败验证账本、历史和设置不会只提交一部分。
    WIFIMETER_CHECK(store->database().exec("CREATE TEMP TRIGGER reject_hour BEFORE UPDATE ON hourly_usage BEGIN SELECT RAISE(ABORT, 'test'); END;").ok);
    WIFIMETER_CHECK(!add(*store, now, 20).ok);
    WIFIMETER_CHECK_EQ(view(*store, now).ledger.usedBytes, ByteCount{100});
    auto rows = store->usage().dailyRange("", "2026-10-01", "2026-10-01", status);
    WIFIMETER_CHECK_EQ(rows.size(), std::size_t{1});
    if (!rows.empty()) WIFIMETER_CHECK_EQ(rows[0].rxBytes, ByteCount{100});
    WIFIMETER_CHECK(store->database().exec("DROP TRIGGER reject_hour;").ok);
    WIFIMETER_CHECK(store->database().exec("CREATE TEMP TRIGGER reject_settings BEFORE UPDATE ON total_quota_settings BEGIN SELECT RAISE(ABORT, 'test'); END;").ok);
    TotalQuotaSettings settings;
    settings.period = QuotaPeriod::all;
    settings.capGb = 10;
    WIFIMETER_CHECK(!store->totalQuota().save(settings, now).ok);
    WIFIMETER_CHECK_EQ(view(*store, now).settings.capGb, 0.0);
    WIFIMETER_CHECK(store->database().exec("DROP TRIGGER reject_settings;").ok);
    WIFIMETER_CHECK(!add(*store, now, std::numeric_limits<ByteCount>::max(), 1).ok);
    WIFIMETER_CHECK_EQ(view(*store, now).ledger.usedBytes, ByteCount{100});
    // 失败的外层 BEGIN 不能导致逐条自动提交。
    {
        Transaction outer(store->database());
        WIFIMETER_CHECK(!add(*store, now, 50).ok);
        WIFIMETER_CHECK_EQ(view(*store, now).ledger.usedBytes, ByteCount{100});
    }
}

void notificationCyclesAndRollback()
{
    TempDirectory directory("total-cycles");
    Status status;
    auto store = Store::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(store != nullptr);
    if (!store) return;
    const auto first = utcTime(2026, 9, 30, 23, 59);
    const auto next = utcTime(2026, 10, 1);
    TotalQuotaSettings settings;
    settings.period = QuotaPeriod::day;
    settings.capGb = 0.000001;
    settings.notify = true;
    WIFIMETER_CHECK(store->totalQuota().save(settings, first).ok);
    WIFIMETER_CHECK(add(*store, first, 1000).ok);
    WIFIMETER_CHECK(view(*store, first).warningPending);
    WIFIMETER_CHECK(view(*store, first).limitPending);
    bool marked = false;
    WIFIMETER_CHECK(store->totalQuota().markNotified(QuotaPeriod::day, "2026-09-30", TotalQuotaNotification::warning, marked).ok);
    WIFIMETER_CHECK(marked);
    WIFIMETER_CHECK(store->totalQuota().markNotified(QuotaPeriod::day, "2026-09-30", TotalQuotaNotification::limit, marked).ok);
    WIFIMETER_CHECK(marked);
    WIFIMETER_CHECK(store->database().exec("CREATE TEMP TRIGGER reject_policy BEFORE UPDATE ON total_quota_settings BEGIN SELECT RAISE(ABORT, 'test'); END;").ok);
    auto changed = settings;
    changed.capGb = 0.000002;
    WIFIMETER_CHECK(!store->totalQuota().save(changed, first).ok);
    WIFIMETER_CHECK(view(*store, first).ledger.warningNotified);
    WIFIMETER_CHECK(view(*store, first).ledger.limitNotified);
    WIFIMETER_CHECK_EQ(view(*store, first).settings.capGb, settings.capGb);
    WIFIMETER_CHECK(store->database().exec("DROP TRIGGER reject_policy;").ok);
    WIFIMETER_CHECK_EQ(view(*store, next).ledger.usedBytes, ByteCount{0});
    WIFIMETER_CHECK(!view(*store, next).ledger.warningNotified);
    WIFIMETER_CHECK(add(*store, next, 1000).ok);
    WIFIMETER_CHECK(view(*store, next).warningPending);
    WIFIMETER_CHECK(view(*store, next).limitPending);
    // 保存备份时失败，不能删除原来的账本或提交新设置。
    auto backup = store->totalQuota().load(status);
    WIFIMETER_CHECK(status.ok);
    backup.settings.capGb = 10;
    WIFIMETER_CHECK(store->database().exec("CREATE TEMP TRIGGER reject_restore BEFORE INSERT ON total_quota_ledgers BEGIN SELECT RAISE(ABORT, 'test'); END;").ok);
    WIFIMETER_CHECK(!store->totalQuota().save(backup).ok);
    WIFIMETER_CHECK_EQ(view(*store, next).settings.capGb, settings.capGb);
    WIFIMETER_CHECK_EQ(view(*store, first).ledger.usedBytes, ByteCount{1000});
    WIFIMETER_CHECK(view(*store, first).ledger.limitNotified);
}

void capBoundaries()
{
    TempDirectory directory("total-cap-range");
    Status status;
    auto store = Store::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(store != nullptr);
    if (!store) return;
    const auto now = utcTime(2026, 10, 1);
    TotalQuotaSettings settings;
    settings.capGb = 9000000000.0;
    WIFIMETER_CHECK(store->totalQuota().save(settings, now).ok);
    WIFIMETER_CHECK_EQ(view(*store, now).quota.capBytes, ByteCount{9000000000000000000ULL});
    WIFIMETER_CHECK(view(*store, now).quota.limited);
    auto snapshot = store->totalQuota().load(status);
    WIFIMETER_CHECK(status.ok);
    WIFIMETER_CHECK(store->totalQuota().save(snapshot).ok);
    store.reset();
    store = Store::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(store != nullptr);
    if (!store) return;
    WIFIMETER_CHECK_EQ(view(*store, now).settings.capGb, 9000000000.0);
    for (const double invalid : {9000000001.0, -1.0, std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()})
    {
        settings.capGb = invalid;
        WIFIMETER_CHECK(!store->totalQuota().save(settings, now).ok);
        snapshot.settings.capGb = invalid;
        WIFIMETER_CHECK(!store->totalQuota().save(snapshot).ok);
    }
    WIFIMETER_CHECK_EQ(view(*store, now).settings.capGb, 9000000000.0);
    for (const double positive : {1e-9, 1e-12, std::numeric_limits<double>::denorm_min()})
    {
        settings.capGb = positive;
        WIFIMETER_CHECK(store->totalQuota().save(settings, now).ok);
        WIFIMETER_CHECK_EQ(view(*store, now).quota.capBytes, ByteCount{1});
        WIFIMETER_CHECK(view(*store, now).quota.limited);
    }
    settings.capGb = 0;
    WIFIMETER_CHECK(store->totalQuota().save(settings, now).ok);
    WIFIMETER_CHECK(!view(*store, now).quota.limited);
    WIFIMETER_CHECK_EQ(view(*store, now).quota.capBytes, ByteCount{0});
}

void upgradesPreviousCapConstraint()
{
    TempDirectory directory("total-cap-upgrade");
    Status status;
    auto store = Store::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(store != nullptr);
    if (!store) return;
    const auto now = utcTime(2026, 10, 1);
    WIFIMETER_CHECK(add(*store, now, 123).ok);
    TotalQuotaSettings settings;
    settings.capGb = 100000;
    settings.notify = true;
    WIFIMETER_CHECK(store->totalQuota().save(settings, now).ok);
    const int version = store->database().schemaVersion();
    // 模拟上一版 helper 创建的设置表，账本保持原样。
    WIFIMETER_CHECK(store->database().exec(
        "ALTER TABLE total_quota_settings RENAME TO saved_settings;"
        "CREATE TABLE total_quota_settings(id INTEGER PRIMARY KEY CHECK(id=1), cap_gb REAL NOT NULL DEFAULT 0 CHECK(cap_gb BETWEEN 0 AND 100000),"
        "warn_percent INTEGER NOT NULL DEFAULT 80, period TEXT NOT NULL DEFAULT 'month', notify INTEGER NOT NULL DEFAULT 0, auto_disconnect INTEGER NOT NULL DEFAULT 0);"
        "INSERT INTO total_quota_settings SELECT * FROM saved_settings; DROP TABLE saved_settings;").ok);
    store.reset();
    store = Store::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(store != nullptr);
    if (!store) return;
    WIFIMETER_CHECK_EQ(store->database().schemaVersion(), version);
    WIFIMETER_CHECK_EQ(view(*store, now).settings.capGb, 100000.0);
    WIFIMETER_CHECK(view(*store, now).settings.notify);
    WIFIMETER_CHECK_EQ(view(*store, now).ledger.usedBytes, ByteCount{123});
    settings.capGb = 9000000000.0;
    WIFIMETER_CHECK(store->totalQuota().save(settings, now).ok);
    WIFIMETER_CHECK_EQ(view(*store, now).quota.capBytes, ByteCount{9000000000000000000ULL});
    WIFIMETER_CHECK(store->totalQuota().ensureSchema().ok);
}

void fractionalThresholdSurvivesRestartAndRestore()
{
    TempDirectory directory("fractional-quota");
    Status status;
    auto store = Store::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(store != nullptr);
    if (!store) return;
    const auto now = utcTime(2026, 10, 1);
    TotalQuotaSettings settings{0.000001, 85.5, QuotaPeriod::all, true, false};
    WIFIMETER_CHECK(store->totalQuota().save(settings, now).ok);
    WIFIMETER_CHECK(add(*store, now, 854).ok);
    WIFIMETER_CHECK(!view(*store, now).warningPending);
    bool marked = false;
    WIFIMETER_CHECK(store->totalQuota().markNotified(QuotaPeriod::all, "all", TotalQuotaNotification::warning, marked).ok);
    WIFIMETER_CHECK(!marked);
    WIFIMETER_CHECK(store->networks().updateUserSettings("wifi-network", "", settings.capGb, 85.5, QuotaPeriod::all, true, false).ok);
    auto backup = store->totalQuota().load(status);
    WIFIMETER_CHECK(status.ok);
    store.reset();
    store = Store::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(store != nullptr);
    if (!store) return;
    WIFIMETER_CHECK_EQ(view(*store, now).settings.warnPercent, 85.5);
    const auto network = store->networks().find("wifi-network", status);
    WIFIMETER_CHECK(network.has_value());
    if (network) WIFIMETER_CHECK_EQ(network->warnPercent, 85.5);
    WIFIMETER_CHECK(!view(*store, now).warningPending);
    WIFIMETER_CHECK(add(*store, now, 1).ok);
    WIFIMETER_CHECK(view(*store, now).warningPending);
    WIFIMETER_CHECK(store->totalQuota().save(backup).ok);
    WIFIMETER_CHECK_EQ(view(*store, now).settings.warnPercent, 85.5);
    WIFIMETER_CHECK(!view(*store, now).warningPending);
    for (const double invalid : {0.9, 100.1, std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()})
    {
        settings.warnPercent = invalid;
        WIFIMETER_CHECK(!store->totalQuota().save(settings, now).ok);
        WIFIMETER_CHECK(!store->networks().updateUserSettings("wifi-network", "", 1, invalid, QuotaPeriod::all, true, false).ok);
    }
}

void allCoreDoesNotRoll()
{
    QuotaSettings settings;
    settings.period = QuotaPeriod::all;
    QuotaLedger ledger;
    WIFIMETER_CHECK(addToLedger(ledger, settings, 10, utcTime(2025, 12, 31)));
    WIFIMETER_CHECK(!addToLedger(ledger, settings, 20, utcTime(2026, 1, 1)));
    WIFIMETER_CHECK_EQ(ledger.usedBytes, ByteCount{30});
    WIFIMETER_CHECK_EQ(ledger.periodKey, std::string("all"));
}

}  // namespace

int main()
{
    wifimeter::test::useTimeZone("UTC");
    fractionalThresholdSurvivesRestartAndRestore();
    allCoreDoesNotRoll();
    capBoundaries();
    upgradesPreviousCapConstraint();
    wiredTypePropagatesThroughUsage();
    historyAndPeriods();
    thresholdsAndRestore();
    atomicUsageAndSettings();
    notificationCyclesAndRollback();
    return WIFIMETER_REPORT();
}
