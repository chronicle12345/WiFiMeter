// 用量累计测试：累计计数到归属增量，重点是基线何时该失效。

#include "../core/usage_accumulator.h"

#include <string>
#include <vector>

#include "test_support.h"

using namespace wifimeter::core;
using wifimeter::test::utcTime;

namespace platform = wifimeter::platform;

namespace
{

platform::WifiSample makeSample(const std::string& interfaceId, const std::string& uuid, const std::string& ssid, ByteCount rx, ByteCount tx)
{
    platform::WifiSample sample;
    sample.interfaceId = interfaceId;
    if (!uuid.empty())
        sample.identity.profileUuid = uuid;
    sample.identity.profileName = "Profile";
    if (!ssid.empty())
        sample.identity.ssid = ssid;
    sample.rxBytes = rx;
    sample.txBytes = tx;
    return sample;
}

platform::SampleReport reportOf(const std::vector<platform::WifiSample>& samples, bool complete = true)
{
    platform::SampleReport report;
    report.samples = samples;
    if (!complete)
        report.failures.push_back({platform::FailureKind::commandFailed, {}, "boom"});
    return report;
}

bool hasEvent(const AccumulateResult& result, CounterEventKind kind, const std::string& interfaceId)
{
    for (const CounterEvent& event : result.events)
    {
        if (event.kind == kind && (interfaceId.empty() || event.interfaceId == interfaceId))
            return true;
    }
    return false;
}

void firstSampleOnlyEstablishesABaseline()
{
    UsageAccumulator accumulator;
    const auto result = accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 1000, 2000)}), utcTime(2026, 9, 29, 10, 0, 0));

    WIFIMETER_CHECK(result.deltas.empty());
    WIFIMETER_CHECK_EQ(result.events.size(), std::size_t{1});
    WIFIMETER_CHECK(hasEvent(result, CounterEventKind::baseline, "wlan0"));
    WIFIMETER_CHECK_EQ(accumulator.trackedInterfaces(), std::size_t{1});
}

void secondSampleYieldsTheDifference()
{
    UsageAccumulator accumulator;
    accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 1000, 2000)}), utcTime(2026, 9, 29, 10, 0, 0));
    const auto result = accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 1500, 2600)}), utcTime(2026, 9, 29, 10, 0, 5));

    WIFIMETER_CHECK_EQ(result.deltas.size(), std::size_t{1});
    WIFIMETER_CHECK(result.events.empty());
    if (!result.deltas.empty())
    {
        WIFIMETER_CHECK_EQ(result.deltas[0].rxBytes, ByteCount{500});
        WIFIMETER_CHECK_EQ(result.deltas[0].txBytes, ByteCount{600});
        WIFIMETER_CHECK_EQ(result.deltas[0].network.key, std::string("uuid-1"));
        WIFIMETER_CHECK_EQ(result.deltas[0].network.ssid, std::string("Home"));
        WIFIMETER_CHECK_EQ(result.deltas[0].span.count(), 5);
        WIFIMETER_CHECK(result.deltas[0].at == utcTime(2026, 9, 29, 10, 0, 5));
    }
}

void idleIntervalStillReportsAZeroDelta()
{
    UsageAccumulator accumulator;
    accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 1000, 2000)}), utcTime(2026, 9, 29, 10, 0, 0));
    const auto result = accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 1000, 2000)}), utcTime(2026, 9, 29, 10, 0, 5));

    // 零增量也要上报，上层据此推进“最后采样时间”。
    WIFIMETER_CHECK_EQ(result.deltas.size(), std::size_t{1});
    WIFIMETER_CHECK_EQ(result.deltas[0].rxBytes, ByteCount{0});
    WIFIMETER_CHECK(result.events.empty());
}

void counterResetIsNotCounted()
{
    UsageAccumulator accumulator;
    accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 100000, 200000)}), utcTime(2026, 9, 29, 10, 0, 0));
    const auto reset = accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 10, 20)}), utcTime(2026, 9, 29, 10, 0, 5));

    WIFIMETER_CHECK(reset.deltas.empty());
    WIFIMETER_CHECK(hasEvent(reset, CounterEventKind::counterReset, "wlan0"));

    // 新基线生效后照常累计。
    const auto next = accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 40, 60)}), utcTime(2026, 9, 29, 10, 0, 10));
    WIFIMETER_CHECK_EQ(next.deltas.size(), std::size_t{1});
    WIFIMETER_CHECK_EQ(next.deltas[0].rxBytes, ByteCount{30});
    WIFIMETER_CHECK_EQ(next.deltas[0].txBytes, ByteCount{40});
}

void identityChangeIsNotCounted()
{
    UsageAccumulator accumulator;
    accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 1000, 2000)}), utcTime(2026, 9, 29, 10, 0, 0));
    const auto switched = accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-2", "Office", 9000, 9000)}), utcTime(2026, 9, 29, 10, 0, 5));

    WIFIMETER_CHECK(switched.deltas.empty());
    WIFIMETER_CHECK(hasEvent(switched, CounterEventKind::reattributed, "wlan0"));

    const auto next = accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-2", "Office", 9500, 9100)}), utcTime(2026, 9, 29, 10, 0, 10));
    WIFIMETER_CHECK_EQ(next.deltas.size(), std::size_t{1});
    WIFIMETER_CHECK_EQ(next.deltas[0].network.key, std::string("uuid-2"));
    WIFIMETER_CHECK_EQ(next.deltas[0].rxBytes, ByteCount{500});
}

void ssidChangeUnderTheSameProfileIsNotCounted()
{
    UsageAccumulator accumulator;
    // 同一份配置匹配到不同 SSID 时同样属于换了网络，不能把中间的流量算给新网络。
    accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 1000, 2000)}), utcTime(2026, 9, 29, 10, 0, 0));
    const auto switched = accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Office", 9000, 9000)}), utcTime(2026, 9, 29, 10, 0, 5));

    WIFIMETER_CHECK(switched.deltas.empty());
    WIFIMETER_CHECK(hasEvent(switched, CounterEventKind::reattributed, "wlan0"));
}

void toleratesClockStepsBackwards()
{
    UsageAccumulator accumulator;
    accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 1000, 2000)}), utcTime(2026, 9, 29, 10, 0, 10));
    // 时钟被回拨后区间长度不能是负数。
    const auto result = accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 1500, 2000)}), utcTime(2026, 9, 29, 10, 0, 0));

    WIFIMETER_CHECK_EQ(result.deltas.size(), std::size_t{1});
    WIFIMETER_CHECK_EQ(result.deltas[0].rxBytes, ByteCount{500});
    WIFIMETER_CHECK_EQ(result.deltas[0].span.count(), 0);
}

void completeReportWithoutTheInterfaceDropsTheBaseline()
{
    UsageAccumulator accumulator;
    accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 1000, 2000)}), utcTime(2026, 9, 29, 10, 0, 0));
    // 报告完整却没有 wlan0：它确实不再关联，未关联期间的流量不可归属。
    const auto detached = accumulator.accumulate(reportOf({}), utcTime(2026, 9, 29, 10, 0, 5));
    WIFIMETER_CHECK(hasEvent(detached, CounterEventKind::detached, "wlan0"));
    WIFIMETER_CHECK_EQ(accumulator.trackedInterfaces(), std::size_t{0});

    // 重新关联后从新基线开始，不把中间断开期间的流量算进来。
    const auto resumed = accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 500000, 600000)}), utcTime(2026, 9, 29, 10, 5, 0));
    WIFIMETER_CHECK(resumed.deltas.empty());
    WIFIMETER_CHECK(hasEvent(resumed, CounterEventKind::baseline, "wlan0"));
}

void incompleteReportKeepsTheBaseline()
{
    UsageAccumulator accumulator;
    accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 1000, 2000)}), utcTime(2026, 9, 29, 10, 0, 0));
    // 报告不完整说明情况未知：保留基线，恢复后照常计算差值。
    const auto unknown = accumulator.accumulate(reportOf({}, false), utcTime(2026, 9, 29, 10, 0, 5));
    WIFIMETER_CHECK(!hasEvent(unknown, CounterEventKind::detached, "wlan0"));
    WIFIMETER_CHECK_EQ(accumulator.trackedInterfaces(), std::size_t{1});

    const auto resumed = accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 1500, 2000)}), utcTime(2026, 9, 29, 10, 0, 30));
    WIFIMETER_CHECK_EQ(resumed.deltas.size(), std::size_t{1});
    WIFIMETER_CHECK_EQ(resumed.deltas[0].rxBytes, ByteCount{500});
    WIFIMETER_CHECK_EQ(resumed.deltas[0].span.count(), 30);
}

void staleBaselinesExpire()
{
    UsageAccumulator accumulator(UsageAccumulator::Options{std::chrono::seconds(60)});
    accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 1000, 2000)}), utcTime(2026, 9, 29, 10, 0, 0));

    const auto young = accumulator.accumulate(reportOf({}, false), utcTime(2026, 9, 29, 10, 0, 59));
    WIFIMETER_CHECK(!hasEvent(young, CounterEventKind::detached, "wlan0"));

    const auto expired = accumulator.accumulate(reportOf({}, false), utcTime(2026, 9, 29, 10, 2, 0));
    WIFIMETER_CHECK(hasEvent(expired, CounterEventKind::detached, "wlan0"));
    WIFIMETER_CHECK_EQ(accumulator.trackedInterfaces(), std::size_t{0});
}

void tracksInterfacesIndependently()
{
    UsageAccumulator accumulator;
    accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 100, 100), makeSample("wlan1", "uuid-2", "Office", 200, 200)}), utcTime(2026, 9, 29, 10, 0, 0));
    const auto result = accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 150, 130), makeSample("wlan1", "uuid-2", "Office", 260, 240)}), utcTime(2026, 9, 29, 10, 0, 5));

    WIFIMETER_CHECK_EQ(result.deltas.size(), std::size_t{2});
    if (result.deltas.size() == 2)
    {
        WIFIMETER_CHECK_EQ(result.deltas[0].network.key, std::string("uuid-1"));
        WIFIMETER_CHECK_EQ(result.deltas[0].rxBytes, ByteCount{50});
        WIFIMETER_CHECK_EQ(result.deltas[0].txBytes, ByteCount{30});
        WIFIMETER_CHECK_EQ(result.deltas[1].network.key, std::string("uuid-2"));
        WIFIMETER_CHECK_EQ(result.deltas[1].rxBytes, ByteCount{60});
        WIFIMETER_CHECK_EQ(result.deltas[1].txBytes, ByteCount{40});
    }
}

void countsEachInterfaceOncePerReport()
{
    UsageAccumulator accumulator;
    accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 100, 100)}), utcTime(2026, 9, 29, 10, 0, 0));
    // 同一网卡出现两次时只计一次，避免重复计入。
    const auto result = accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 200, 200), makeSample("wlan0", "uuid-1", "Home", 300, 300)}), utcTime(2026, 9, 29, 10, 0, 5));

    WIFIMETER_CHECK_EQ(result.deltas.size(), std::size_t{1});
    WIFIMETER_CHECK_EQ(result.deltas[0].rxBytes, ByteCount{100});
}

void ignoresSamplesWithoutIdentity()
{
    UsageAccumulator accumulator;
    const auto result = accumulator.accumulate(reportOf({makeSample("wlan0", "", "", 100, 100)}), utcTime(2026, 9, 29, 10, 0, 0));

    WIFIMETER_CHECK(result.deltas.empty());
    WIFIMETER_CHECK(result.events.empty());
    WIFIMETER_CHECK_EQ(accumulator.trackedInterfaces(), std::size_t{0});
}

void clearForgetsEverything()
{
    UsageAccumulator accumulator;
    accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 100, 100)}), utcTime(2026, 9, 29, 10, 0, 0));
    accumulator.clear();
    WIFIMETER_CHECK_EQ(accumulator.trackedInterfaces(), std::size_t{0});

    const auto result = accumulator.accumulate(reportOf({makeSample("wlan0", "uuid-1", "Home", 500, 500)}), utcTime(2026, 9, 29, 10, 0, 5));
    WIFIMETER_CHECK(result.deltas.empty());
    WIFIMETER_CHECK(hasEvent(result, CounterEventKind::baseline, "wlan0"));
}

}  // namespace

int main()
{
    firstSampleOnlyEstablishesABaseline();
    secondSampleYieldsTheDifference();
    idleIntervalStillReportsAZeroDelta();
    counterResetIsNotCounted();
    identityChangeIsNotCounted();
    ssidChangeUnderTheSameProfileIsNotCounted();
    toleratesClockStepsBackwards();
    completeReportWithoutTheInterfaceDropsTheBaseline();
    incompleteReportKeepsTheBaseline();
    staleBaselinesExpire();
    tracksInterfacesIndependently();
    countsEachInterfaceOncePerReport();
    ignoresSamplesWithoutIdentity();
    clearForgetsEverything();
    return WIFIMETER_REPORT();
}
