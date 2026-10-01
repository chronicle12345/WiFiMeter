#pragma once

// 采样与断开的编排（实现见 sampling.cpp）。
//
// 采样正确性的关键是“这次计数属于哪个网络”，因此时序必须是：
//
//   1. 读一次链路状态，得到身份；
//   2. 只对已关联的网卡读累计计数（没有已关联网卡时不读，也不算失败）；
//   3. 再读一次链路状态，两次身份一致才产出样本，否则丢弃并上报 inconsistent。
//
// 这段时序与系统无关，Linux 与 Windows 只是数据来源不同，因此放在这里共用：
// 任何一侧改了时序，另一侧的测试会一起失败，不会悄悄分叉。

#include <string>
#include <string_view>
#include <vector>

#include "counter_source.h"
#include "network_platform.h"

namespace wifimeter::platform
{

// 链路状态与计数读取的结果。失败与数据分开返回：单张网卡失败不影响其他网卡。
struct LinkReadResult
{
    std::vector<WifiLink> links;
    std::vector<Failure> failures;
};

struct CounterReadResult
{
    std::vector<CounterReading> counters;
    std::vector<Failure> failures;
};

// 采集数据源。实现者只负责“取数据”，时序由 sampleFrom 决定。
class LinkSource
{
public:
    virtual ~LinkSource() = default;

    LinkSource(const LinkSource&) = delete;
    LinkSource& operator=(const LinkSource&) = delete;

    // 所有无线网卡的当前状态（含未关联的）。
    virtual LinkReadResult readLinks() = 0;

    // 所有网卡的累计字节数。
    virtual CounterReadResult readCounters() = 0;

    // 请求断开指定网卡；不做守卫（判定与复核由编排层负责）。
    virtual DisconnectOutcome requestDisconnect(const std::string& interfaceId, std::string& detail) = 0;

protected:
    LinkSource() = default;
};

// 已关联时返回网络名，未关联或身份缺失时返回空字符串。
std::string ssidOfLink(const std::vector<WifiLink>& links, const std::string& interfaceId);

// 读取无线网卡状态。
LinkReport linksFrom(LinkSource& source);

// 按上面的时序采样一次。
SampleReport sampleFrom(LinkSource& source);

// 断开的判定（纯函数）：只有当前关联的正是期望网络时才允许断开。
DisconnectOutcome decideDisconnect(std::string_view currentSsid, std::string_view expectedSsid);

// 断开的执行 + 复核。onAccepted 返回 true 表示系统接受了断开请求；
// recheck 由平台提供，因为“断开是否生效”的判定方式不同
// （Linux 直接重查，Windows 需要轮询等状态变化）。
template <typename Recheck>
DisconnectReport disconnectFrom(LinkSource& source, const std::string& interfaceId, const std::string& expectedSsid, Recheck recheck)
{
    DisconnectReport report;

    const LinkReadResult before = source.readLinks();
    if (before.links.empty() && !before.failures.empty())
    {
        // 读不到状态就不能断言“没有关联”。当成“无需断开”会让调用方以为设备本来就没连，
        // 而真实原因可能是查询失败，因此如实上报失败。
        report.outcome = before.failures.front().kind == FailureKind::unavailable ? DisconnectOutcome::unavailable : DisconnectOutcome::commandFailed;
        report.detail = before.failures.front().detail;
        return report;
    }

    const std::string current = ssidOfLink(before.links, interfaceId);
    const DisconnectOutcome decision = decideDisconnect(current, expectedSsid);
    if (decision != DisconnectOutcome::disconnected)
    {
        report.outcome = decision;
        return report;
    }

    std::string detail;
    report.outcome = source.requestDisconnect(interfaceId, detail);
    report.detail = detail;
    if (report.outcome != DisconnectOutcome::disconnected)
        return report;

    // 命令成功但随即被自动重连时不能报告成功。
    if (!recheck(interfaceId, expectedSsid))
        report.outcome = DisconnectOutcome::stillAssociated;
    return report;
}

}  // namespace wifimeter::platform
