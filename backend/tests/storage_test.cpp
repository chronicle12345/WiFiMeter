// 存储层测试：用量累加、区间查询、覆盖空档、额度账本滚动、保留期裁剪与备份。

#include <chrono>
#include <filesystem>
#include <memory>
#include <string>

#include "../core/usage_accumulator.h"
#include "../storage/store.h"
#include "test_support.h"

using namespace wifimeter::core;
using namespace wifimeter::storage;
using wifimeter::test::TempDirectory;
using wifimeter::test::utcTime;

namespace platform = wifimeter::platform;

namespace
{

NetworkRef networkOf(const std::string& key, const std::string& ssid)
{
    NetworkRef reference;
    reference.key = key;
    reference.ssid = ssid;
    return reference;
}

std::unique_ptr<Store> openStore(const TempDirectory& directory, Status& status)
{
    return Store::open(directory.file("meter.db"), status);
}

void accumulatesDailyAndHourlyUsage()
{
    wifimeter::test::useTimeZone("UTC");
    TempDirectory directory("store-usage");
    Status status;
    auto store = openStore(directory, status);
    WIFIMETER_CHECK(store != nullptr);
    if (!store)
        return;

    const NetworkRef home = networkOf("uuid-1", "Home");
    const LocalStamp morning = localStampOf(utcTime(2026, 9, 29, 9, 0, 0));
    const LocalStamp evening = localStampOf(utcTime(2026, 9, 29, 21, 0, 0));

    WIFIMETER_CHECK(store->usage().add(home, morning, 1000, 200).ok);
    WIFIMETER_CHECK(store->usage().add(home, morning, 500, 300).ok);  // 同一小时累加
    WIFIMETER_CHECK(store->usage().add(home, evening, 7000, 800).ok);

    const auto daily = store->usage().dailyRange("", "2026-09-01", "2026-09-30", status);
    WIFIMETER_CHECK(status.ok);
    WIFIMETER_CHECK_EQ(daily.size(), std::size_t{1});
    if (!daily.empty())
    {
        WIFIMETER_CHECK_EQ(daily[0].day, std::string("2026-09-29"));
        WIFIMETER_CHECK_EQ(daily[0].networkKey, std::string("uuid-1"));
        WIFIMETER_CHECK_EQ(daily[0].rxBytes, ByteCount{8500});
        WIFIMETER_CHECK_EQ(daily[0].txBytes, ByteCount{1300});
    }

    const auto hourly = store->usage().hourlyOfDay("uuid-1", "2026-09-29", status);
    WIFIMETER_CHECK(status.ok);
    WIFIMETER_CHECK_EQ(hourly.size(), std::size_t{2});
    if (hourly.size() == 2)
    {
        WIFIMETER_CHECK_EQ(hourly[0].hour, 9);
        WIFIMETER_CHECK_EQ(hourly[0].rxBytes, ByteCount{1500});
        WIFIMETER_CHECK_EQ(hourly[0].txBytes, ByteCount{500});
        WIFIMETER_CHECK_EQ(hourly[1].hour, 21);
        WIFIMETER_CHECK_EQ(hourly[1].rxBytes, ByteCount{7000});
    }

    // 小时明细之和必须等于当日总量，否则界面的今日图表会与总量对不上。
    ByteCount hourlyTotal = 0;
    for (const auto& row : hourly)
        hourlyTotal += row.rxBytes + row.txBytes;
    WIFIMETER_CHECK_EQ(hourlyTotal, daily[0].rxBytes + daily[0].txBytes);
}

void filtersByNetworkAndRange()
{
    wifimeter::test::useTimeZone("UTC");
    TempDirectory directory("store-filter");
    Status status;
    auto store = openStore(directory, status);
    if (!store)
        return;

    const LocalStamp day = localStampOf(utcTime(2026, 9, 29, 10, 0, 0));
    WIFIMETER_CHECK(store->usage().add(networkOf("uuid-1", "Home"), day, 100, 1).ok);
    WIFIMETER_CHECK(store->usage().add(networkOf("uuid-2", "Office"), day, 200, 2).ok);

    WIFIMETER_CHECK_EQ(store->usage().dailyRange("", "2026-09-01", "2026-09-30", status).size(), std::size_t{2});
    WIFIMETER_CHECK_EQ(store->usage().dailyRange("uuid-2", "2026-09-01", "2026-09-30", status).size(), std::size_t{1});
    WIFIMETER_CHECK_EQ(store->usage().dailyRange("", "2026-10-01", "2026-10-31", status).size(), std::size_t{0});
    WIFIMETER_CHECK_EQ(store->usage().dailyRange("", "2026-09-29", "2026-09-29", status).size(), std::size_t{2});
    WIFIMETER_CHECK_EQ(store->usage().dailyRange("", "2026-09-30", "2026-09-30", status).size(), std::size_t{0});
}

void recordsCoverageGaps()
{
    wifimeter::test::useTimeZone("UTC");
    TempDirectory directory("store-gaps");
    Status status;
    auto store = openStore(directory, status);
    if (!store)
        return;

    CoverageGap gap;
    gap.networkKey = "uuid-1";
    gap.reason = CoverageReason::counterReset;
    gap.startedAt = utcTime(2026, 9, 29, 10, 0, 0);
    gap.endedAt = utcTime(2026, 9, 29, 10, 0, 5);
    gap.span = std::chrono::seconds(5);
    WIFIMETER_CHECK(store->usage().addGap(gap).ok);

    // 未结束的空档（暂停或离线期间）先留痕，恢复时再闭合。
    CoverageGap open;
    open.networkKey = "";
    open.reason = CoverageReason::paused;
    open.startedAt = utcTime(2026, 9, 29, 11, 0, 0);
    WIFIMETER_CHECK(store->usage().addGap(open).ok);

    std::size_t closed = 0;
    WIFIMETER_CHECK(store->closeOpenGaps(utcTime(2026, 9, 29, 11, 30, 0), closed).ok);
    WIFIMETER_CHECK_EQ(closed, std::size_t{1});

    const auto gaps = store->usage().gapsInRange("2026-09-29T00:00:00Z", "2026-09-29T23:59:59Z", status);
    WIFIMETER_CHECK(status.ok);
    WIFIMETER_CHECK_EQ(gaps.size(), std::size_t{2});
    if (gaps.size() == 2)
    {
        WIFIMETER_CHECK(gaps[0].reason == CoverageReason::counterReset);
        WIFIMETER_CHECK_EQ(gaps[0].span.count(), 5);
        WIFIMETER_CHECK(gaps[1].reason == CoverageReason::paused);
        WIFIMETER_CHECK_EQ(gaps[1].span.count(), 1800);  // 时长由 SQLite 计算
    }

    WIFIMETER_CHECK_EQ(std::string(coverageReasonName(CoverageReason::reattributed)), std::string("reattributed"));
    WIFIMETER_CHECK(coverageReasonFromName("identity_unknown").value_or(CoverageReason::offline) == CoverageReason::identityUnknown);
    WIFIMETER_CHECK(!coverageReasonFromName("nonsense").has_value());
}

// 构造采样报告。用具名构造而不是花括号初始化，避免字段顺序变化时静默错位。
platform::SampleReport reportOf(platform::WifiSample sample)
{
    platform::SampleReport report;
    report.samples.push_back(std::move(sample));
    return report;
}

void appliesAccumulatorOutputAtomically()
{
    wifimeter::test::useTimeZone("UTC");
    TempDirectory directory("store-apply");
    Status status;
    auto store = openStore(directory, status);
    if (!store)
        return;

    const NetworkRef home = networkOf("uuid-1", "Home");
    const auto at = utcTime(2026, 9, 29, 10, 0, 0);

    auto sample = [](const NetworkRef& reference, ByteCount rx, ByteCount tx) {
        platform::WifiSample wifi;
        wifi.interfaceId = "wlan0";
        wifi.identity.profileUuid = reference.key;
        wifi.identity.ssid = reference.ssid;
        wifi.rxBytes = rx;
        wifi.txBytes = tx;
        return wifi;
    };

    UsageAccumulator accumulator;
    // 第一次只建立基线，不应写任何记录。
    const auto baseline = accumulator.accumulate(reportOf(sample(home, 1000, 1000)), at);
    ApplySummary summary;
    WIFIMETER_CHECK(store->applyUsage(baseline, at, summary).ok);
    WIFIMETER_CHECK_EQ(summary.recordedNetworks, std::size_t{0});
    WIFIMETER_CHECK_EQ(store->usage().dailyRange("", "2026-09-01", "2026-09-30", status).size(), std::size_t{0});
    WIFIMETER_CHECK_EQ(store->networks().all(status).size(), std::size_t{0});

    // 第二次产生增量：登记网络、写入每日与小时记录、更新账本。
    const auto second = accumulator.accumulate(reportOf(sample(home, 1600, 1400)), at + std::chrono::seconds(5));
    WIFIMETER_CHECK(store->applyUsage(second, at + std::chrono::seconds(5), summary).ok);
    WIFIMETER_CHECK_EQ(summary.recordedNetworks, std::size_t{1});

    const auto daily = store->usage().dailyRange("", "2026-09-01", "2026-09-30", status);
    WIFIMETER_CHECK_EQ(daily.size(), std::size_t{1});
    if (!daily.empty())
    {
        WIFIMETER_CHECK_EQ(daily[0].rxBytes, ByteCount{600});
        WIFIMETER_CHECK_EQ(daily[0].txBytes, ByteCount{400});
    }

    const auto networks = store->networks().all(status);
    WIFIMETER_CHECK_EQ(networks.size(), std::size_t{1});
    if (!networks.empty())
    {
        WIFIMETER_CHECK_EQ(networks[0].key, std::string("uuid-1"));
        WIFIMETER_CHECK_EQ(networks[0].ssid, std::string("Home"));
        WIFIMETER_CHECK(!networks[0].lastSeenAt.empty());
    }

    const auto ledger = store->networks().ledger("uuid-1", status);
    WIFIMETER_CHECK(ledger.has_value());
    if (ledger)
    {
        WIFIMETER_CHECK_EQ(ledger->periodKey, std::string("2026-09"));
        WIFIMETER_CHECK_EQ(ledger->usedBytes, ByteCount{1000});  // 600 + 400
    }

    // 计数器重置事件应当变成覆盖空档，而不是静默丢弃。
    const auto reset = accumulator.accumulate(reportOf(sample(home, 5, 5)), at + std::chrono::seconds(10));
    WIFIMETER_CHECK(store->applyUsage(reset, at + std::chrono::seconds(10), summary).ok);
    WIFIMETER_CHECK_EQ(summary.gapsRecorded, std::size_t{1});
    const auto gaps = store->usage().gapsInRange("2026-09-29T00:00:00Z", "2026-09-29T23:59:59Z", status);
    WIFIMETER_CHECK_EQ(gaps.size(), std::size_t{1});
    if (!gaps.empty())
        WIFIMETER_CHECK(gaps[0].reason == CoverageReason::counterReset);
}

void rollsTheQuotaLedgerAtThePeriodBoundary()
{
    wifimeter::test::useTimeZone("UTC");
    TempDirectory directory("store-ledger");
    Status status;
    auto store = openStore(directory, status);
    if (!store)
        return;

    const NetworkRef home = networkOf("uuid-1", "Home");
    WIFIMETER_CHECK(store->networks().saveLedger(QuotaLedgerRecord{"uuid-1", "2026-09", 5000}).ok);

    auto sample = [&](ByteCount rx, ByteCount tx) {
        platform::WifiSample wifi;
        wifi.interfaceId = "wlan0";
        wifi.identity.profileUuid = home.key;
        wifi.identity.ssid = home.ssid;
        wifi.rxBytes = rx;
        wifi.txBytes = tx;
        return wifi;
    };

    UsageAccumulator accumulator;
    const auto september = utcTime(2026, 9, 30, 23, 59, 50);
    accumulator.accumulate(reportOf(sample(1000, 1000)), september);
    const auto october = utcTime(2026, 10, 1, 0, 0, 0);
    const auto crossed = accumulator.accumulate(reportOf(sample(1200, 1100)), october);

    ApplySummary summary;
    WIFIMETER_CHECK(store->applyUsage(crossed, october, summary).ok);
    WIFIMETER_CHECK_EQ(summary.rolledPeriods.size(), std::size_t{1});

    const auto ledger = store->networks().ledger("uuid-1", status);
    WIFIMETER_CHECK(ledger.has_value());
    if (ledger)
    {
        WIFIMETER_CHECK_EQ(ledger->periodKey, std::string("2026-10"));
        WIFIMETER_CHECK_EQ(ledger->usedBytes, ByteCount{300});  // 200 + 100，跨周期归零后重记
    }
}

void prunesByRetention()
{
    wifimeter::test::useTimeZone("UTC");
    TempDirectory directory("store-retention");
    Status status;
    auto store = openStore(directory, status);
    if (!store)
        return;

    const NetworkRef home = networkOf("uuid-1", "Home");
    for (int day = 1; day <= 30; ++day)
    {
        const auto at = utcTime(2026, 9, day, 10, 0, 0);
        WIFIMETER_CHECK(store->usage().add(home, localStampOf(at), 100, 10).ok);
    }

    SettingsRecord settings = store->settings().load(status);
    settings.retentionDays = 30;
    WIFIMETER_CHECK(store->settings().save(settings).ok);

    std::size_t removedDaily = 0;
    std::size_t removedHourly = 0;
    WIFIMETER_CHECK(store->pruneByRetention(utcTime(2026, 9, 30, 12, 0, 0), removedDaily, removedHourly).ok);
    // 保留 30 天含当天：9 月 1 日到 30 日刚好 30 天，全部保留。
    WIFIMETER_CHECK_EQ(removedDaily, std::size_t{0});

    // 到 10 月 5 日再裁剪：cutoff = 10 月 5 日 - 29 天 = 9 月 6 日。
    WIFIMETER_CHECK(store->pruneByRetention(utcTime(2026, 10, 5, 12, 0, 0), removedDaily, removedHourly).ok);
    WIFIMETER_CHECK_EQ(removedDaily, std::size_t{5});  // 9 月 1 至 5 日
    WIFIMETER_CHECK_EQ(removedHourly, std::size_t{5});

    const auto remaining = store->usage().dailyRange("", "2026-01-01", "2026-12-31", status);
    WIFIMETER_CHECK_EQ(remaining.size(), std::size_t{25});
    if (!remaining.empty())
        WIFIMETER_CHECK_EQ(remaining.front().day, std::string("2026-09-06"));

    // 长期保留时不做任何删除。
    settings.retentionDays = 0;
    WIFIMETER_CHECK(store->settings().save(settings).ok);
    WIFIMETER_CHECK(store->pruneByRetention(utcTime(2027, 1, 1, 12, 0, 0), removedDaily, removedHourly).ok);
    WIFIMETER_CHECK_EQ(removedDaily, std::size_t{0});
}

void keepsUserSettingsWhenTheNetworkIsSeenAgain()
{
    wifimeter::test::useTimeZone("UTC");
    TempDirectory directory("store-observe");
    Status status;
    auto store = openStore(directory, status);
    if (!store)
        return;

    bool created = false;
    WIFIMETER_CHECK(store->networks().observe(networkOf("uuid-1", "Home"), "2026-09-29T10:00:00Z", created).ok);
    WIFIMETER_CHECK(created);

    WIFIMETER_CHECK(store->networks().updateUserSettings("uuid-1", "家里的 Wi-Fi", 120.0, 75, QuotaPeriod::day, true, true).ok);

    // 再次见到同一个网络：只刷新 ssid 与最近时间，用户设置必须保留。
    WIFIMETER_CHECK(store->networks().observe(networkOf("uuid-1", "Home-5G"), "2026-09-30T10:00:00Z", created).ok);
    WIFIMETER_CHECK(!created);

    const auto record = store->networks().find("uuid-1", status);
    WIFIMETER_CHECK(record.has_value());
    if (record)
    {
        WIFIMETER_CHECK_EQ(record->ssid, std::string("Home-5G"));
        WIFIMETER_CHECK_EQ(record->alias, std::string("家里的 Wi-Fi"));
        WIFIMETER_CHECK_EQ(record->capGb, 120.0);
        WIFIMETER_CHECK_EQ(record->warnPercent, 75);
        WIFIMETER_CHECK(record->quotaPeriod == QuotaPeriod::day);
        WIFIMETER_CHECK(record->notify);
        WIFIMETER_CHECK(record->autoDisconnect);
        WIFIMETER_CHECK_EQ(record->firstSeenAt, std::string("2026-09-29T10:00:00Z"));
        WIFIMETER_CHECK_EQ(record->lastSeenAt, std::string("2026-09-30T10:00:00Z"));
    }

    WIFIMETER_CHECK(!store->networks().updateUserSettings("missing", "", 0, 80, QuotaPeriod::month, false, false).ok);
}

void clearsUsageButKeepsNetworksAndPreferences()
{
    wifimeter::test::useTimeZone("UTC");
    TempDirectory directory("store-clear");
    Status status;
    auto store = openStore(directory, status);
    if (!store)
        return;

    const NetworkRef home = networkOf("uuid-1", "Home");
    const auto at = utcTime(2026, 9, 29, 10, 0, 0);
    WIFIMETER_CHECK(store->usage().add(home, localStampOf(at), 100, 10).ok);
    bool created = false;
    WIFIMETER_CHECK(store->networks().observe(home, "2026-09-29T10:00:00Z", created).ok);
    WIFIMETER_CHECK(store->networks().updateUserSettings("uuid-1", "家里", 10.0, 80, QuotaPeriod::month, true, false).ok);
    WIFIMETER_CHECK(store->networks().saveLedger(QuotaLedgerRecord{"uuid-1", "2026-09", 110}).ok);

    WIFIMETER_CHECK(store->clearUsage().ok);

    WIFIMETER_CHECK_EQ(store->usage().dailyRange("", "2026-01-01", "2026-12-31", status).size(), std::size_t{0});
    WIFIMETER_CHECK_EQ(store->usage().hourlyOfDay("", "2026-09-29", status).size(), std::size_t{0});
    const auto networks = store->networks().all(status);
    WIFIMETER_CHECK_EQ(networks.size(), std::size_t{1});
    if (!networks.empty())
        WIFIMETER_CHECK_EQ(networks[0].alias, std::string("家里"));
    const auto ledger = store->networks().ledger("uuid-1", status);
    WIFIMETER_CHECK(ledger.has_value());
    if (ledger)
        WIFIMETER_CHECK_EQ(ledger->usedBytes, ByteCount{0});
}

void persistsSettingsAcrossReopen()
{
    TempDirectory directory("store-settings");
    Status status;
    {
        auto store = openStore(directory, status);
        WIFIMETER_CHECK(store != nullptr);
        if (!store)
            return;
        SettingsRecord settings = store->settings().load(status);
        WIFIMETER_CHECK(status.ok);
        settings.unit = DisplayUnit::gib;
        settings.speedUnit = SpeedUnit::megabitsPerSecond;
        settings.intervalSeconds = 2;
        settings.retentionDays = 365;
        settings.notifications = false;
        WIFIMETER_CHECK(store->settings().save(settings).ok);
    }

    auto reopened = openStore(directory, status);
    WIFIMETER_CHECK(reopened != nullptr);
    if (!reopened)
        return;
    const SettingsRecord settings = reopened->settings().load(status);
    WIFIMETER_CHECK(settings.unit == DisplayUnit::gib);
    WIFIMETER_CHECK(settings.speedUnit == SpeedUnit::megabitsPerSecond);
    WIFIMETER_CHECK_EQ(settings.intervalSeconds, 2);
    WIFIMETER_CHECK_EQ(settings.retentionDays, 365);
    WIFIMETER_CHECK(!settings.notifications);

    // 非法取值回退到默认，坏数据不应传到界面。
    SettingsRecord broken;
    broken.intervalSeconds = 7;
    broken.retentionDays = 12;
    const SettingsRecord clean = SettingsRepository::sanitize(broken);
    WIFIMETER_CHECK_EQ(clean.intervalSeconds, 5);
    WIFIMETER_CHECK_EQ(clean.retentionDays, 90);
}

void survivesReopenWithData()
{
    wifimeter::test::useTimeZone("UTC");
    TempDirectory directory("store-reopen");
    Status status;
    {
        auto store = openStore(directory, status);
        if (!store)
            return;
        const auto at = utcTime(2026, 9, 29, 10, 0, 0);
        WIFIMETER_CHECK(store->usage().add(networkOf("uuid-1", "Home"), localStampOf(at), 500, 50).ok);
    }

    auto reopened = openStore(directory, status);
    WIFIMETER_CHECK(reopened != nullptr);
    if (!reopened)
        return;
    const auto daily = reopened->usage().dailyRange("", "2026-09-01", "2026-09-30", status);
    WIFIMETER_CHECK_EQ(daily.size(), std::size_t{1});
    if (!daily.empty())
        WIFIMETER_CHECK_EQ(daily[0].rxBytes, ByteCount{500});
}

}  // namespace

int main()
{
    accumulatesDailyAndHourlyUsage();
    filtersByNetworkAndRange();
    recordsCoverageGaps();
    appliesAccumulatorOutputAtomically();
    rollsTheQuotaLedgerAtThePeriodBoundary();
    prunesByRetention();
    keepsUserSettingsWhenTheNetworkIsSeenAgain();
    clearsUsageButKeepsNetworksAndPreferences();
    persistsSettingsAcrossReopen();
    survivesReopenWithData();
    return WIFIMETER_REPORT();
}
