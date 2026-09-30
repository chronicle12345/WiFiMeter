#include <limits>

#include "../storage/store.h"
#include "test_support.h"

using namespace wifimeter::storage;
using wifimeter::test::TempDirectory;
using wifimeter::test::utcTime;
namespace core = wifimeter::core;

int main()
{
    wifimeter::test::useTimeZone("UTC");
    TempDirectory directory("app-usage");
    Status status;
    auto store = Store::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK(store != nullptr);
    if (!store)
        return WIFIMETER_REPORT();
    bool created = false;
    WIFIMETER_CHECK(store->networks().observe({"home", "Home"}, "2026-09-30T10:00:00Z", created).ok);
    WIFIMETER_CHECK(store->networks().observe({"office", "Office"}, "2026-09-30T10:00:00Z", created).ok);
    const core::ByteCount large = 9007199254740993ULL;
    WIFIMETER_CHECK(store->usage().addApp({"home", "2026-09-30", "/opt/browser", "浏览器", large, 1}).ok);
    WIFIMETER_CHECK(store->usage().addApp({"home", "2026-09-30", "/opt/browser", "浏览器", 2, 3}).ok);
    WIFIMETER_CHECK(store->usage().addApp({"office", "2026-09-30", "/opt/browser", "浏览器", 99, 88}).ok);
    WIFIMETER_CHECK(store->usage().addApp({"home", "2026-09-29", "/opt/browser", "浏览器", 100, 200}).ok);
    auto rows = store->usage().appRange("home", "2026-09-30", "2026-09-30", status);
    WIFIMETER_CHECK(status.ok);
    WIFIMETER_CHECK_EQ(rows.size(), std::size_t{1});
    if (!rows.empty())
    {
        WIFIMETER_CHECK_EQ(rows[0].rxBytes, large + 2);
        WIFIMETER_CHECK_EQ(rows[0].txBytes, core::ByteCount{4});
        WIFIMETER_CHECK_EQ(rows[0].name, std::string("浏览器"));
    }
    WIFIMETER_CHECK(store->usage().dailyRange("", "2026-09-01", "2026-09-30", status).empty());
    WIFIMETER_CHECK(store->networks().allLedgers(status).empty());
    WIFIMETER_CHECK(store->usage().appRange("home", "2026-10-01", "2026-10-01", status).empty());
    WIFIMETER_CHECK_EQ(store->usage().appRange("", "2026-09-29", "2026-09-30", status).size(), std::size_t{3});

    // 无法归属、无效日期与超出 SQLite 范围的流量不能混入历史。
    WIFIMETER_CHECK(!store->usage().addApp({"missing", "2026-09-30", "browser", "浏览器", 1, 0}).ok);
    WIFIMETER_CHECK(!store->usage().addApp({"home", "2026-02-30", "browser", "浏览器", 1, 0}).ok);
    WIFIMETER_CHECK(!store->usage().addApp({"home", "2026-09-30", "", "浏览器", 1, 0}).ok);
    WIFIMETER_CHECK(!store->usage().addApp({"home", "2026-09-30", "browser", "", 1, 0}).ok);
    WIFIMETER_CHECK(!store->usage().addApp({"home", "2026-09-30", "browser", "浏览器", 18446744073709551615ULL, 0}).ok);
    const auto maximum = static_cast<core::ByteCount>(std::numeric_limits<std::int64_t>::max());
    WIFIMETER_CHECK(store->usage().setApp({"home", "2026-09-30", "maximum", "测试", maximum, 0}).ok);
    WIFIMETER_CHECK(!store->usage().addApp({"home", "2026-09-30", "maximum", "测试", 1, 0}).ok);
    rows = store->usage().appRange("home", "2026-09-30", "2026-09-30", status);
    WIFIMETER_CHECK_EQ(rows.back().rxBytes, maximum);

    WIFIMETER_CHECK(store->backupTo(directory.file("backup.db")).ok);
    store.reset();
    store = Store::open(directory.file("meter.db"), status);
    WIFIMETER_CHECK_EQ(store->usage().appRange("", "2026-09-01", "2026-09-30", status).size(), std::size_t{4});
    auto backup = Store::open(directory.file("backup.db"), status);
    WIFIMETER_CHECK_EQ(backup->usage().appRange("", "2026-09-01", "2026-09-30", status).size(), std::size_t{4});

    auto settings = store->settings().load(status);
    settings.retentionDays = 30;
    WIFIMETER_CHECK(store->settings().save(settings).ok);
    std::size_t daily = 0, hourly = 0;
    WIFIMETER_CHECK(store->usage().addApp({"home", "2026-08-31", "old", "旧应用", 1, 0}).ok);
    WIFIMETER_CHECK(store->pruneByRetention(utcTime(2026, 9, 30, 12, 0, 0), daily, hourly).ok);
    WIFIMETER_CHECK_EQ(store->usage().appRange("", "2026-01-01", "2026-09-30", status).size(), std::size_t{4});
    WIFIMETER_CHECK(store->usage().removeNetwork("office").ok);
    WIFIMETER_CHECK(store->usage().appRange("office", "2026-01-01", "2026-09-30", status).empty());
    WIFIMETER_CHECK(store->clearUsage().ok);
    WIFIMETER_CHECK(store->usage().appRange("", "2026-01-01", "2026-09-30", status).empty());
    WIFIMETER_CHECK_EQ(store->networks().all(status).size(), std::size_t{2});
    return WIFIMETER_REPORT();
}
