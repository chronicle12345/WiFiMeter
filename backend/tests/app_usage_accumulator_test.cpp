#include "../core/app_usage_accumulator.h"
#include "test_support.h"

namespace core = wifimeter::core;
namespace platform = wifimeter::platform;
using wifimeter::test::utcTime;

platform::SampleReport wifi(const std::string& id = "home", const std::string& name = "Home")
{
    platform::SampleReport report;
    platform::WifiSample sample;
    sample.interfaceId = "wlan0";
    sample.identity.profileUuid = id;
    sample.identity.ssid = name;
    report.samples.push_back(sample);
    return report;
}

int main()
{
    const auto now = utcTime(2026, 9, 30, 10, 0, 0);
    core::AppUsageAccumulator accumulator;
    platform::AppTrafficReport apps{platform::AppCollectorState::running, "one", {},
        {{"wlan0", "browser", "浏览器", "42:100", 42, 100, 10, true}}};
    WIFIMETER_CHECK(accumulator.accumulate(apps, wifi(), now).deltas.empty());
    apps.samples[0].rxBytes = 600;
    apps.samples[0].txBytes = 110;
    auto result = accumulator.accumulate(apps, wifi(), now + std::chrono::seconds(5));
    WIFIMETER_CHECK_EQ(result.deltas.size(), std::size_t{1});
    if (!result.deltas.empty())
    {
        WIFIMETER_CHECK_EQ(result.deltas[0].rxBytes, core::ByteCount{500});
        WIFIMETER_CHECK_EQ(result.deltas[0].txBytes, core::ByteCount{100});
        WIFIMETER_CHECK_EQ(result.deltas[0].network.key, std::string("home"));
        WIFIMETER_CHECK_EQ(result.deltas[0].span.count(), std::int64_t{5});
    }
    WIFIMETER_CHECK(accumulator.accumulate(apps, wifi(), now + std::chrono::seconds(10)).deltas.empty());
    // 同一个应用的新进程和同一 PID 的新实例都从本 generation 的零计数开始。
    apps.samples.push_back({"wlan0", "browser", "浏览器", "42:200", 42, 70, 20, true});
    result = accumulator.accumulate(apps, wifi(), now + std::chrono::seconds(15));
    WIFIMETER_CHECK_EQ(result.deltas.size(), std::size_t{1});
    if (!result.deltas.empty())
        WIFIMETER_CHECK_EQ(result.deltas[0].rxBytes, core::ByteCount{70});

    apps.samples[0].rxBytes = 900;
    apps.samples[1].rxBytes = 100;
    result = accumulator.accumulate(apps, wifi("office", "Office"), now + std::chrono::seconds(20));
    WIFIMETER_CHECK(result.deltas.empty());
    WIFIMETER_CHECK_EQ(result.gaps.size(), std::size_t{1});
    if (!result.gaps.empty())
        WIFIMETER_CHECK(result.gaps[0].kind == core::AppGapKind::reattributed);
    apps.samples[0].rxBytes = 1000;
    result = accumulator.accumulate(apps, wifi("office", "Office"), now + std::chrono::seconds(25));
    WIFIMETER_CHECK_EQ(result.deltas.size(), std::size_t{1});
    if (!result.deltas.empty())
        WIFIMETER_CHECK_EQ(result.deltas[0].rxBytes, core::ByteCount{100});

    // 身份未知期间的增量既不能落到旧网络，也不能在恢复后补到新网络。
    apps.samples[0].rxBytes = 2000;
    result = accumulator.accumulate(apps, {}, now + std::chrono::seconds(30));
    WIFIMETER_CHECK(result.deltas.empty());
    WIFIMETER_CHECK_EQ(result.gaps.size(), std::size_t{1});
    apps.samples[0].rxBytes = 3000;
    WIFIMETER_CHECK(accumulator.accumulate(apps, wifi(), now + std::chrono::seconds(35)).deltas.empty());
    apps.samples[0].rxBytes = 3100;
    result = accumulator.accumulate(apps, wifi(), now + std::chrono::seconds(40));
    WIFIMETER_CHECK_EQ(result.deltas[0].rxBytes, core::ByteCount{100});
    apps.samples[0].rxBytes = 1;
    result = accumulator.accumulate(apps, wifi(), now + std::chrono::seconds(45));
    WIFIMETER_CHECK(result.deltas.empty());
    WIFIMETER_CHECK(result.gaps[0].kind == core::AppGapKind::counterReset);

    apps.generation = "two";
    result = accumulator.accumulate(apps, wifi(), now + std::chrono::seconds(50));
    WIFIMETER_CHECK(result.deltas.empty());
    WIFIMETER_CHECK(result.gaps[0].kind == core::AppGapKind::sourceRestart);
    apps.state = platform::AppCollectorState::permission;
    WIFIMETER_CHECK(accumulator.accumulate(apps, wifi(), now + std::chrono::seconds(55)).deltas.empty());
    apps.state = platform::AppCollectorState::running;
    apps.samples[0].rxBytes = 999;
    WIFIMETER_CHECK(accumulator.accumulate(apps, wifi(), now + std::chrono::seconds(60)).deltas.empty());
    accumulator.clear();
    WIFIMETER_CHECK(accumulator.accumulate(apps, wifi(), now + std::chrono::seconds(65)).deltas.empty());
    return WIFIMETER_REPORT();
}
