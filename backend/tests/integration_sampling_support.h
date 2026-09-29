#pragma once

// 平台层与业务规则的接缝测试（与具体系统无关）。
//
// 同一份采样序列在两个平台上都要走通：平台层给累计计数与身份，core 负责差值、
// 归属与失效判断。因此这里不包含任何平台头文件，只要求调用方提供：
//
//   * 一个已经配置好的 NetworkPlatform（真实实现 + 假数据源）；
//   * 一个能改“当前网络”和“当前计数”的驱动。
//
// Linux 侧由假的 nmcli / proc/net/dev / sysfs 驱动，Windows 侧由假的 SystemApi 驱动，
// 断言完全相同——两端的差别只有网络键的来源（配置 UUID vs SSID 散列）。

#include <map>
#include <string>
#include <utility>

#include "../core/network_key.h"
#include "../core/quota.h"
#include "../core/usage_accumulator.h"
#include "../platform/network_platform.h"
#include "test_support.h"

namespace wifimeter::test
{

// 驱动接口：把“改环境”与“采样”留给平台相关的部分。
template <typename Platform>
struct SamplingDriver
{
    std::string homeKey;     // “Home” 在这套平台数据里的网络键
    std::string officeKey;   // “Office” 在这套平台数据里的网络键

    virtual ~SamplingDriver() = default;

    // 切换当前关联的网络与它的身份。
    virtual void switchNetwork(const std::string& key, const std::string& ssid) = 0;

    // 设置网卡的累计收发字节数。
    virtual void setCounters(core::ByteCount rx, core::ByteCount tx) = 0;

    // 采样一次。
    virtual platform::SampleReport sample() = 0;
};

// 采样序列 → 用量累计 → 额度账本 → 额度状态。
// Linux 与 Windows 用同一份断言，键由驱动给出。
template <typename Platform>
void runSamplingIntegration(SamplingDriver<Platform>& driver)
{
    // 类型在 wifimeter::core 下，这里用限定名以免与平台类型混淆。
    core::UsageAccumulator accumulator;
    std::map<std::string, core::QuotaLedger> ledgers;

    core::QuotaSettings settings;
    settings.period = core::QuotaPeriod::month;
    settings.capGb = 1.0;

    const auto sampleAt = [&](core::ByteCount rx, core::ByteCount tx, int second) {
        driver.setCounters(rx, tx);
        const auto report = accumulator.accumulate(driver.sample(), utcTime(2026, 9, 29, 10, 0, second));
        for (const core::UsageDelta& delta : report.deltas)
            core::addToLedger(ledgers[delta.network.key], settings, delta.rxBytes + delta.txBytes, delta.at);
        return report;
    };

    // 第一次采样只建立基线：没有增量，也就还没有账本条目。
    const auto baseline = sampleAt(1000, 2000, 0);
    WIFIMETER_CHECK(baseline.deltas.empty());
    WIFIMETER_CHECK(ledgers.empty());

    // 正常累计：两次差值都进入 Home 的账本。
    sampleAt(1500, 2600, 5);
    sampleAt(2000, 3000, 10);
    WIFIMETER_CHECK_EQ(ledgers[driver.homeKey].usedBytes, core::ByteCount{1100 + 900});
    WIFIMETER_CHECK_EQ(ledgers[driver.homeKey].periodKey, std::string("2026-09"));

    // 计数回落（网卡重载、驱动重置）：这段流量无法估算，不进入账本。
    const auto reset = sampleAt(10, 20, 15);
    WIFIMETER_CHECK(reset.deltas.empty());
    WIFIMETER_CHECK_EQ(ledgers[driver.homeKey].usedBytes, core::ByteCount{2000});

    // 重建基线后继续累计。
    sampleAt(60, 100, 20);
    WIFIMETER_CHECK_EQ(ledgers[driver.homeKey].usedBytes, core::ByteCount{2000 + 50 + 80});

    // 换网络：切换瞬间的流量不计入任何一边，之后归到新网络。
    driver.switchNetwork(driver.officeKey, "Office");
    const auto switched = sampleAt(100, 150, 25);
    WIFIMETER_CHECK(switched.deltas.empty());
    WIFIMETER_CHECK_EQ(ledgers[driver.homeKey].usedBytes, core::ByteCount{2130});

    sampleAt(140, 200, 30);
    WIFIMETER_CHECK_EQ(ledgers[driver.officeKey].usedBytes, core::ByteCount{40 + 50});
    WIFIMETER_CHECK_EQ(ledgers.size(), std::size_t{2});

    // 账本可以直接喂给额度状态。
    const core::QuotaState home = core::quotaStateOf(settings, ledgers[driver.homeKey].usedBytes, utcTime(2026, 9, 29, 10, 0, 30));
    WIFIMETER_CHECK(home.limited);
    WIFIMETER_CHECK(!home.reachedWarn(80));
    WIFIMETER_CHECK_EQ(home.remainingBytes(), core::ByteCount{1000000000ULL - 2130});
}

// 跨周期滚动：账本在新周期归零重记。
template <typename Platform>
void runLedgerRollover(SamplingDriver<Platform>& driver)
{
    useTimeZone("UTC");

    core::UsageAccumulator accumulator;
    core::QuotaLedger ledger;

    core::QuotaSettings settings;
    settings.period = core::QuotaPeriod::month;

    driver.setCounters(1000, 1000);
    accumulator.accumulate(driver.sample(), utcTime(2026, 9, 30, 23, 59, 50));

    driver.setCounters(1400, 1400);
    for (const core::UsageDelta& delta : accumulator.accumulate(driver.sample(), utcTime(2026, 10, 1, 0, 0, 0)).deltas)
        core::addToLedger(ledger, settings, delta.rxBytes + delta.txBytes, delta.at);

    // 跨月后账本归零重记，跨月那一次增量算进新月份。
    WIFIMETER_CHECK_EQ(ledger.periodKey, std::string("2026-10"));
    WIFIMETER_CHECK_EQ(ledger.usedBytes, core::ByteCount{800});
}

}  // namespace wifimeter::test
