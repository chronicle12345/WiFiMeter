#include "../platform/app_capture_cache.h"
#include "../core/app_usage_accumulator.h"
#include "test_support.h"

#include <algorithm>
#include <chrono>
#include <iostream>
#include <limits>

namespace platform = wifimeter::platform;
namespace core = wifimeter::core;

platform::SampleReport wifi()
{
    platform::SampleReport result;
    platform::WifiSample link;
    link.interfaceId = "wifi"; link.identity.profileUuid = "home"; link.identity.ssid = "Home";
    result.samples.push_back(link);
    return result;
}

core::ByteCount sum(const core::AppAccumulateResult& result)
{
    core::ByteCount total = 0;
    for (const auto& delta : result.deltas) total += delta.rxBytes + delta.txBytes;
    return total;
}

void retainsFinalBytesUntilSavedAndSeparatesLateBytes()
{
    platform::AppCaptureCache cache;
    cache.reset("one");
    const platform::AppCaptureIdentity process{42, 100, 0, "browser", "Browser"};
    core::AppUsageAccumulator accumulator;
    auto now = wifimeter::test::utcTime(2026,10,1,0,0,0);
    accumulator.accumulate(cache.snapshot(), wifi(), now);
    WIFIMETER_CHECK(cache.add("wifi", process, 100, 20));
    cache.exited(42, 100, 200);
    const auto final = cache.snapshot();
    WIFIMETER_CHECK_EQ(sum(accumulator.accumulate(final, wifi(), now + std::chrono::seconds(5))), core::ByteCount{120});
    WIFIMETER_CHECK_EQ(cache.pendingCount(), std::size_t{1});
    WIFIMETER_CHECK_EQ(cache.snapshot().samples.size(), std::size_t{1});
    // A save failure sends no acknowledgement. The complete final counters remain.
    WIFIMETER_CHECK_EQ(cache.snapshot().samples.at(0).rxBytes, std::uint64_t{100});
    WIFIMETER_CHECK(cache.add("wifi", {42,100,200,"browser","Browser"}, 7, 3));
    cache.acknowledge(final);
    accumulator.acknowledge(final);
    WIFIMETER_CHECK_EQ(cache.pendingCount(), std::size_t{0});
    WIFIMETER_CHECK_EQ(cache.mergedCount(), std::size_t{1});
    auto late = cache.snapshot();
    WIFIMETER_CHECK_EQ(sum(accumulator.accumulate(late, wifi(), now + std::chrono::seconds(10))), core::ByteCount{10});
    cache.acknowledge(final);
    WIFIMETER_CHECK_EQ(sum(accumulator.accumulate(cache.snapshot(), wifi(), now + std::chrono::seconds(15))), core::ByteCount{0});
    const auto old = cache.identityFor(42, 150);
    WIFIMETER_CHECK(old.has_value());
    if (old) WIFIMETER_CHECK(cache.add("wifi", *old, 11, 2));
    WIFIMETER_CHECK_EQ(sum(accumulator.accumulate(cache.snapshot(), wifi(), now + std::chrono::seconds(20))), core::ByteCount{13});
    WIFIMETER_CHECK(!cache.identityFor(42, 250).has_value());
    WIFIMETER_CHECK(cache.add("wifi", {42,300,0,"editor","Editor"}, 30, 4));
    WIFIMETER_CHECK_EQ(sum(accumulator.accumulate(cache.snapshot(), wifi(), now + std::chrono::seconds(25))), core::ByteCount{34});
    auto wrong = cache.snapshot(); wrong.generation = "old";
    cache.acknowledge(wrong);
    WIFIMETER_CHECK_EQ(cache.pendingCount(), std::size_t{1});
}

void shortProcessChurnKeepsOnlyBoundedIdentityAndApplicationState()
{
    constexpr std::size_t processes = 512;
    platform::AppCaptureCache cache(65536, 64);
    cache.reset("churn");
    std::size_t peakSamples = 0;
    const auto started = std::chrono::steady_clock::now();
    for (std::size_t index = 0; index < processes; ++index)
    {
        const auto pid = static_cast<std::uint32_t>(index % 128 + 1);
        const auto created = static_cast<std::uint64_t>(index * 10 + 1);
        WIFIMETER_CHECK(cache.add("wifi", {pid,created,0,"browser","Browser"}, 10, 1));
        cache.exited(pid, created, created + 5);
        peakSamples = std::max(peakSamples, cache.pendingCount() + cache.mergedCount());
        cache.acknowledge(cache.snapshot());
        peakSamples = std::max(peakSamples, cache.pendingCount() + cache.mergedCount());
        if (cache.pendingCount() > 1) break;
    }
    WIFIMETER_CHECK_EQ(cache.pendingCount(), std::size_t{0});
    WIFIMETER_CHECK_EQ(cache.mergedCount(), std::size_t{1});
    WIFIMETER_CHECK(cache.identityCount() <= 64);
    WIFIMETER_CHECK(peakSamples <= 2);
    WIFIMETER_CHECK(!cache.identityFor(1,2).has_value());
    WIFIMETER_CHECK(cache.addUnknown("wifi", 8, 2));
    std::uint64_t unknown = 0;
    for (const auto& sample : cache.snapshot().samples) if (sample.appId == "unknown") unknown += sample.rxBytes + sample.txBytes;
    WIFIMETER_CHECK_EQ(unknown, std::uint64_t{10});
    std::cout << "churn processes=" << processes << " peak_samples=" << peakSamples << " retained_identities=" << cache.identityCount()
        << " elapsed_ms=" << std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-started).count() << '\n';
}

void doesNotEvictUnacknowledgedSamplesAtTheLimit()
{
    platform::AppCaptureCache cache(2,2);
    cache.reset("limited");
    WIFIMETER_CHECK(cache.add("wifi", {1,10,0,"one","One"}, 1, 0));
    WIFIMETER_CHECK(cache.add("wifi", {2,20,0,"two","Two"}, 2, 0));
    WIFIMETER_CHECK(!cache.add("wifi", {3,30,0,"three","Three"}, 3, 0));
    WIFIMETER_CHECK_EQ(cache.pendingCount(), std::size_t{2});
}

void exactAcknowledgementsAtCapacityRemainIdempotent()
{
    platform::AppCaptureCache cache(1,2);
    cache.reset("exact");
    const platform::AppCaptureIdentity process{42,100,0,"browser","Browser"};
    WIFIMETER_CHECK(cache.add("wifi",process,100,20));
    cache.exited(42,100,200);
    const auto saved = cache.snapshot();
    WIFIMETER_CHECK(cache.add("wifi",{42,100,200,"browser","Browser"},7,3));
    auto invalid = saved;
    invalid.samples.at(0).rxBytes = 108;
    cache.acknowledge(invalid);
    invalid = saved; invalid.samples.at(0).txBytes = 24;
    cache.acknowledge(invalid);
    invalid = saved; invalid.samples.at(0).active = true;
    cache.acknowledge(invalid);
    invalid = saved; invalid.samples.at(0).interfaceId = "other";
    cache.acknowledge(invalid);
    invalid = saved; invalid.generation = "previous";
    cache.acknowledge(invalid);
    WIFIMETER_CHECK_EQ(cache.pendingCount(),std::size_t{1});
    WIFIMETER_CHECK_EQ(cache.mergedCount(),std::size_t{0});
    WIFIMETER_CHECK_EQ(cache.snapshot().samples.at(0).rxBytes,std::uint64_t{107});
    WIFIMETER_CHECK_EQ(cache.snapshot().samples.at(0).txBytes,std::uint64_t{23});
    const auto published = cache.snapshot();
    WIFIMETER_CHECK(cache.add("wifi",{42,100,200,"browser","Browser"},7,3));
    cache.acknowledge(published);
    WIFIMETER_CHECK_EQ(cache.pendingCount(),std::size_t{0});
    WIFIMETER_CHECK_EQ(cache.mergedCount(),std::size_t{1});
    const auto residual = cache.snapshot();
    WIFIMETER_CHECK_EQ(residual.samples.at(0).rxBytes,std::uint64_t{7});
    WIFIMETER_CHECK_EQ(residual.samples.at(0).txBytes,std::uint64_t{3});
    cache.acknowledge(saved);
    cache.acknowledge(residual);
    WIFIMETER_CHECK_EQ(cache.snapshot().samples.at(0).rxBytes,std::uint64_t{7});
    WIFIMETER_CHECK_EQ(cache.snapshot().samples.at(0).txBytes,std::uint64_t{3});
    const auto retired = cache.identityFor(42,150);
    WIFIMETER_CHECK(retired.has_value());
    if (retired) WIFIMETER_CHECK(cache.add("wifi",*retired,5,2));
    WIFIMETER_CHECK_EQ(cache.pendingCount(),std::size_t{0});
    WIFIMETER_CHECK_EQ(cache.snapshot().samples.at(0).rxBytes,std::uint64_t{12});
    WIFIMETER_CHECK_EQ(cache.snapshot().samples.at(0).txBytes,std::uint64_t{5});
}

void multipleInterfacesShareIdentityAndPreserveEachResidual()
{
    platform::AppCaptureCache cache(2,1);
    cache.reset("interfaces");
    const platform::AppCaptureIdentity process{42,100,0,"browser","Browser"};
    WIFIMETER_CHECK(cache.add("wifi-a",process,100,20));
    WIFIMETER_CHECK(cache.add("wifi-b",process,200,30));
    cache.exited(42,100,200);
    const auto saved = cache.snapshot();
    WIFIMETER_CHECK(cache.add("wifi-a",{42,100,200,"browser","Browser"},5,1));
    WIFIMETER_CHECK(cache.add("wifi-b",{42,100,200,"browser","Browser"},7,2));
    auto firstInterface = saved;
    firstInterface.samples.resize(1);
    cache.acknowledge(firstInterface);
    WIFIMETER_CHECK_EQ(cache.pendingCount(),std::size_t{1});
    WIFIMETER_CHECK_EQ(cache.identityCount(),std::size_t{1});
    const auto retired = cache.identityFor(42,150);
    WIFIMETER_CHECK(retired.has_value());
    if (retired) WIFIMETER_CHECK(cache.add("wifi-b",*retired,9,3));
    cache.acknowledge(saved);
    cache.acknowledge(saved);
    WIFIMETER_CHECK_EQ(cache.pendingCount(),std::size_t{0});
    WIFIMETER_CHECK_EQ(cache.mergedCount(),std::size_t{2});
    WIFIMETER_CHECK_EQ(cache.identityCount(),std::size_t{1});
    for (const auto& sample : cache.snapshot().samples)
    {
        WIFIMETER_CHECK(sample.instanceId.rfind("retired:",0) == 0);
        if (sample.interfaceId == "wifi-a")
        {
            WIFIMETER_CHECK_EQ(sample.rxBytes,std::uint64_t{5});
            WIFIMETER_CHECK_EQ(sample.txBytes,std::uint64_t{1});
        }
        else
        {
            WIFIMETER_CHECK_EQ(sample.interfaceId,std::string{"wifi-b"});
            WIFIMETER_CHECK_EQ(sample.rxBytes,std::uint64_t{16});
            WIFIMETER_CHECK_EQ(sample.txBytes,std::uint64_t{5});
        }
    }

}

void reusedPidMatchesItsCreationAndExitInterval()
{
    platform::AppCaptureCache cache(8,2);
    cache.reset("pid-reuse");
    WIFIMETER_CHECK(cache.add("wifi",{42,100,0,"browser","Browser"},100,20));
    cache.exited(42,100,200);
    cache.acknowledge(cache.snapshot());
    WIFIMETER_CHECK(cache.add("wifi",{42,300,0,"editor","Editor"},10,2));
    const auto old = cache.identityFor(42,150), current = cache.identityFor(42,350);
    WIFIMETER_CHECK(old.has_value());
    WIFIMETER_CHECK(current.has_value());
    if (old) WIFIMETER_CHECK_EQ(old->appId,std::string{"browser"});
    if (current) WIFIMETER_CHECK_EQ(current->appId,std::string{"editor"});
    WIFIMETER_CHECK(!cache.identityFor(42,99).has_value());
    WIFIMETER_CHECK(!cache.identityFor(42,250).has_value());
    if (old) WIFIMETER_CHECK(cache.add("wifi",*old,7,3));
    if (current) WIFIMETER_CHECK(cache.add("wifi",*current,5,1));
    WIFIMETER_CHECK_EQ(cache.pendingCount(),std::size_t{1});
    WIFIMETER_CHECK_EQ(cache.mergedCount(),std::size_t{1});
    cache.exited(42,300,400);
    cache.acknowledge(cache.snapshot());
    WIFIMETER_CHECK_EQ(cache.identityCount(),std::size_t{2});
    WIFIMETER_CHECK(!cache.identityFor(42,450).has_value());
    WIFIMETER_CHECK(cache.add("wifi",{43,500,0,"other","Other"},1,0));
    cache.exited(43,500,600);
    cache.acknowledge(cache.snapshot());
    WIFIMETER_CHECK(!cache.identityFor(42,150).has_value());
    WIFIMETER_CHECK(cache.identityFor(42,350).has_value());
    WIFIMETER_CHECK(cache.addUnknown("wifi",8,2));
    for (const auto& sample : cache.snapshot().samples)
    {
        if (sample.appId == "browser") WIFIMETER_CHECK_EQ(sample.rxBytes,std::uint64_t{7});
        if (sample.appId == "unknown") WIFIMETER_CHECK_EQ(sample.rxBytes,std::uint64_t{8});
    }
}

void failedResidualMergePreservesTheOriginalCounters()
{
    platform::AppCaptureCache cache(2,2);
    cache.reset("merge-overflow");
    WIFIMETER_CHECK(cache.add("wifi",{1,10,0,"browser","Browser"},1,0));
    cache.exited(1,10,20);
    cache.acknowledge(cache.snapshot());
    const auto first = cache.identityFor(1,15);
    WIFIMETER_CHECK(first.has_value());
    if (first) WIFIMETER_CHECK(cache.add("wifi",*first,(std::numeric_limits<std::uint64_t>::max)(),0));
    WIFIMETER_CHECK(cache.add("wifi",{2,30,0,"browser","Browser"},1,0));
    cache.exited(2,30,40);
    const auto saved = cache.snapshot();
    WIFIMETER_CHECK(cache.add("wifi",{2,30,40,"browser","Browser"},1,0));
    cache.acknowledge(saved);
    WIFIMETER_CHECK_EQ(cache.pendingCount(),std::size_t{1});
    WIFIMETER_CHECK_EQ(cache.mergedCount(),std::size_t{1});
    for (const auto& sample : cache.snapshot().samples)
    {
        if (sample.instanceId == "2:30") WIFIMETER_CHECK_EQ(sample.rxBytes,std::uint64_t{2});
        else WIFIMETER_CHECK_EQ(sample.rxBytes,(std::numeric_limits<std::uint64_t>::max)());
    }
}

void queuedAcknowledgementsKeepTheBaselineUntilTheHelperOmitsTheInstance()
{
    platform::AppCaptureCache cache;
    cache.reset("queued");
    core::AppUsageAccumulator accumulator;
    const auto at = wifimeter::test::utcTime(2026,10,1);
    accumulator.accumulate(cache.snapshot(),wifi(),at);
    WIFIMETER_CHECK(cache.add("wifi",{42,100,0,"browser","Browser"},100,20));
    cache.exited(42,100,200);
    auto report = cache.snapshot();
    WIFIMETER_CHECK_EQ(sum(accumulator.accumulate(report,wifi(),at+std::chrono::seconds(5))),core::ByteCount{120});
    accumulator.acknowledge(report);
    // The source can return another snapshot before its queued command arrives.
    WIFIMETER_CHECK_EQ(sum(accumulator.accumulate(cache.snapshot(),wifi(),at+std::chrono::seconds(10))),core::ByteCount{0});
    WIFIMETER_CHECK(cache.add("wifi",{42,100,200,"browser","Browser"},7,3));
    report = cache.snapshot();
    WIFIMETER_CHECK_EQ(sum(accumulator.accumulate(report,wifi(),at+std::chrono::seconds(15))),core::ByteCount{10});
    accumulator.acknowledge(report);
    cache.acknowledge(report);
    WIFIMETER_CHECK_EQ(sum(accumulator.accumulate(cache.snapshot(),wifi(),at+std::chrono::seconds(20))),core::ByteCount{0});
    const auto retired = cache.identityFor(42,150);
    WIFIMETER_CHECK(retired.has_value());
    if (retired) WIFIMETER_CHECK(cache.add("wifi",*retired,5,1));
    WIFIMETER_CHECK_EQ(sum(accumulator.accumulate(cache.snapshot(),wifi(),at+std::chrono::seconds(25))),core::ByteCount{6});
    // A helper without the capability flag must keep the original contract.
    platform::AppTrafficReport old{platform::AppCollectorState::running,"old",{},
        {{"wifi","browser","Browser","42:100",42,0,0,true}}};
    old.samples[0].source = "WindowsEtw";
    accumulator.clear();
    accumulator.accumulate(old,wifi(),at);
    old.samples[0].active = false; old.samples[0].rxBytes = 10;
    WIFIMETER_CHECK_EQ(sum(accumulator.accumulate(old,wifi(),at+std::chrono::seconds(5))),core::ByteCount{10});
    accumulator.acknowledge(old);
    old.samples[0].rxBytes = 15;
    WIFIMETER_CHECK_EQ(sum(accumulator.accumulate(old,wifi(),at+std::chrono::seconds(10))),core::ByteCount{5});
}

void retiringOneInterfaceCannotRecreateItsOldCounterAfterIdentityEviction()
{
    platform::AppCaptureCache cache(3,1);
    cache.reset("partial-retirement");
    const platform::AppCaptureIdentity process{42,100,0,"browser","Browser"};
    WIFIMETER_CHECK(cache.add("wifi-a",process,100,20));
    WIFIMETER_CHECK(cache.add("wifi-b",process,200,30));
    cache.exited(42,100,200);
    auto saved = cache.snapshot(); saved.samples.resize(1);
    cache.acknowledge(saved);
    WIFIMETER_CHECK(cache.add("wifi-a",{43,300,0,"editor","Editor"},10,1));
    cache.exited(43,300,400);
    auto other = cache.snapshot();
    other.samples.erase(std::remove_if(other.samples.begin(),other.samples.end(),[](const auto& sample) {
        return sample.instanceId != "43:300";
    }),other.samples.end());
    cache.acknowledge(other);
    WIFIMETER_CHECK_EQ(cache.identityCount(),std::size_t{1});
    const auto old = cache.identityFor(42,150);
    WIFIMETER_CHECK(old.has_value());
    if (old) WIFIMETER_CHECK(cache.add("wifi-a",*old,7,3));
    WIFIMETER_CHECK_EQ(cache.pendingCount(),std::size_t{1});
    WIFIMETER_CHECK_EQ(cache.mergedCount(),std::size_t{2});
    for (const auto& sample : cache.snapshot().samples)
        if (sample.interfaceId == "wifi-a" && sample.appId == "browser")
        {
            WIFIMETER_CHECK(sample.instanceId.rfind("retired:",0) == 0);
            WIFIMETER_CHECK_EQ(sample.rxBytes,std::uint64_t{7});
            WIFIMETER_CHECK_EQ(sample.txBytes,std::uint64_t{3});
        }
}

void publishedRawSnapshotCannotBeRecountedThroughResidual()
{
    // The host can consume a cached report while a newer helper read is already
    // in flight. Older acknowledgements must not retire that published counter.
    for (const bool swapDirections : {false,true})
    {
        platform::AppCaptureCache cache;
        cache.reset("published-before-save");
        core::AppUsageAccumulator accumulator;
        const auto at = wifimeter::test::utcTime(2026,10,3);
        accumulator.accumulate(cache.snapshot(),wifi(),at);
        const platform::AppCaptureIdentity process{42,100,0,"browser","Browser"};
        const platform::AppCaptureIdentity exited{42,100,200,"browser","Browser"};
        WIFIMETER_CHECK(cache.add("wifi",process,swapDirections ? 20 : 100,swapDirections ? 100 : 20));
        cache.exited(42,100,200);
        const auto first = cache.snapshot();
        WIFIMETER_CHECK(cache.add("wifi",exited,swapDirections ? 0 : 30,swapDirections ? 30 : 0));
        const auto intermediate = cache.snapshot();
        WIFIMETER_CHECK(cache.add("wifi",exited,swapDirections ? 20 : 0,swapDirections ? 0 : 20));
        const auto latestPublished = cache.snapshot();

        core::ByteCount savedRx = 0, savedTx = 0;
        const auto save = [&](const platform::AppTrafficReport& report, int seconds) {
            for (const auto& delta : accumulator.accumulate(report,wifi(),at+std::chrono::seconds(seconds)).deltas)
            {
                savedRx += delta.rxBytes;
                savedTx += delta.txBytes;
            }
            accumulator.acknowledge(report);
            cache.acknowledge(report);
        };
        save(first,5);
        WIFIMETER_CHECK_EQ(cache.pendingCount(),std::size_t{1});
        WIFIMETER_CHECK_EQ(cache.mergedCount(),std::size_t{0});
        // One direction now matches the latest report, but the other has a
        // published increment that the database has not committed yet.
        save(intermediate,10);
        WIFIMETER_CHECK_EQ(cache.pendingCount(),std::size_t{1});
        WIFIMETER_CHECK_EQ(cache.mergedCount(),std::size_t{0});

        // These bytes arrived after the latest published report. Its valid ACK
        // must migrate exactly this residual, without copying earlier deltas.
        WIFIMETER_CHECK(cache.add("wifi",exited,swapDirections ? 3 : 7,swapDirections ? 7 : 3));
        save(latestPublished,15);
        WIFIMETER_CHECK_EQ(cache.pendingCount(),std::size_t{0});
        WIFIMETER_CHECK_EQ(cache.mergedCount(),std::size_t{1});
        const auto residual = cache.snapshot();
        WIFIMETER_CHECK_EQ(residual.samples.size(),std::size_t{1});
        if (!residual.samples.empty())
        {
            WIFIMETER_CHECK(residual.samples[0].instanceId.rfind("retired:",0) == 0);
            WIFIMETER_CHECK_EQ(residual.samples[0].rxBytes,std::uint64_t(swapDirections ? 3 : 7));
            WIFIMETER_CHECK_EQ(residual.samples[0].txBytes,std::uint64_t(swapDirections ? 7 : 3));
        }
        save(residual,20);
        WIFIMETER_CHECK_EQ(savedRx,core::ByteCount(swapDirections ? 43 : 137));
        WIFIMETER_CHECK_EQ(savedTx,core::ByteCount(swapDirections ? 137 : 43));
        WIFIMETER_CHECK_EQ(savedRx+savedTx,core::ByteCount{180});
        cache.acknowledge(first);
        cache.acknowledge(intermediate);
        cache.acknowledge(latestPublished);
        WIFIMETER_CHECK_EQ(sum(accumulator.accumulate(cache.snapshot(),wifi(),at+std::chrono::seconds(25))),core::ByteCount{0});
    }
}

void retiringOneLargeBatchUsesBoundedState()
{
    constexpr std::size_t processes = 20000;
    platform::AppCaptureCache cache;
    cache.reset("batch");
    const auto began = std::chrono::steady_clock::now();
    for (std::size_t index = 0; index < processes; ++index)
        WIFIMETER_CHECK(cache.add("wifi",{static_cast<std::uint32_t>(index+1),index+100,0,"browser","Browser"},10,1));
    for (std::size_t index = 0; index < processes; ++index)
        cache.exited(static_cast<std::uint32_t>(index+1),index+100,index+101);
    const auto report = cache.snapshot();
    WIFIMETER_CHECK_EQ(report.samples.size(),processes);
    std::uint64_t rx = 0,tx = 0;
    for (const auto& sample : report.samples) { rx += sample.rxBytes; tx += sample.txBytes; WIFIMETER_CHECK(!sample.active); }
    WIFIMETER_CHECK_EQ(rx,std::uint64_t{200000});
    WIFIMETER_CHECK_EQ(tx,std::uint64_t{20000});
    cache.acknowledge(report);
    WIFIMETER_CHECK_EQ(cache.pendingCount(),std::size_t{0});
    WIFIMETER_CHECK_EQ(cache.mergedCount(),std::size_t{1});
    WIFIMETER_CHECK(cache.identityCount() <= 4096);
    std::cout << "batch processes=" << processes << " retained_samples=" << cache.snapshot().samples.size()
        << " retained_identities=" << cache.identityCount() << " elapsed_ms="
        << std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-began).count() << '\n';
}

int main()
{
    retainsFinalBytesUntilSavedAndSeparatesLateBytes();
    shortProcessChurnKeepsOnlyBoundedIdentityAndApplicationState();
    doesNotEvictUnacknowledgedSamplesAtTheLimit();
    exactAcknowledgementsAtCapacityRemainIdempotent();
    multipleInterfacesShareIdentityAndPreserveEachResidual();
    reusedPidMatchesItsCreationAndExitInterval();
    failedResidualMergePreservesTheOriginalCounters();
    queuedAcknowledgementsKeepTheBaselineUntilTheHelperOmitsTheInstance();
    retiringOneInterfaceCannotRecreateItsOldCounterAfterIdentityEviction();
    publishedRawSnapshotCannotBeRecountedThroughResidual();
    retiringOneLargeBatchUsesBoundedState();
    return WIFIMETER_REPORT();
}
