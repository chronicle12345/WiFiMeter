// Windows 采样编排测试：用假的 SystemApi 驱动真实的 WindowsNetworkPlatform。
//
// 覆盖的判断逻辑与 Linux 侧一致：未关联的网卡不产生样本、采样期间换网络要丢弃样本、
// 计数缺失算失败、断开需要判定—执行—复核三步，以及断开异步生效时的等待与超时。
//
// 这里不调用任何 Windows API，因此在 Linux 开发机上就能跑完整的采样与断开流程。

#include "../platform/windows/windows_network_platform.h"
#include "../platform/fake_source.h"

#include <chrono>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "test_support.h"

using namespace wifimeter::platform;
using namespace wifimeter::platform::windows;

namespace
{

WlanStatus connectedStatus(const std::string& interfaceId, const std::string& ssid, const std::string& profile, int signal = 70)
{
    WlanStatus status;
    status.interfaceId = interfaceId;
    status.adapterAlias = "Intel(R) Wi-Fi 6 AX201 160MHz";
    status.connected = true;
    status.mode = ConnectionMode::profile;
    status.profileName = profile;
    status.ssid = ssid;
    status.signalPercent = signal;
    return status;
}

WlanStatus disconnectedStatus(const std::string& interfaceId)
{
    WlanStatus status;
    status.interfaceId = interfaceId;
    status.adapterAlias = "Intel(R) Wi-Fi 6 AX201 160MHz";
    status.connected = false;
    status.mode = ConnectionMode::discoverySecure;
    return status;
}

InterfaceCounters counters(const std::string& interfaceId, std::uint64_t rx, std::uint64_t tx)
{
    InterfaceCounters value;
    value.interfaceId = interfaceId;
    value.rxBytes = rx;
    value.txBytes = tx;
    return value;
}

bool hasFailure(const std::vector<Failure>& failures, FailureKind kind, const std::string& interfaceId)
{
    return std::any_of(failures.begin(), failures.end(), [kind, &interfaceId](const Failure& failure) { return failure.kind == kind && failure.interfaceId == interfaceId; });
}

bool hasGlobalFailure(const std::vector<Failure>& failures, FailureKind kind)
{
    return hasFailure(failures, kind, "");
}

// 可编程的假系统：每一轮 wlanStatuses() 依次返回给定的状态序列，用完后重复最后一组。
class FakeSystem final : public SystemApi
{
public:
    std::vector<std::vector<WlanStatus>> statusRounds;
    std::vector<InterfaceCounters> countersValue;
    std::optional<Failure> statusesFailure;
    // 逐网卡失败：与状态一起返回，用于覆盖“某张网卡查不动、其他照常”的情况。
    std::vector<Failure> perAdapterFailures;
    std::optional<Failure> countersFailure;
    DisconnectCommand disconnectResult;

    std::vector<std::vector<WifiLink>> ethernetRounds;
    std::vector<std::vector<RawInterfaceRow>> ethernetRowRounds;
    int ethernetCalls = 0;

    QueryResult<std::vector<WifiLink>> ethernetLinks() override
    {
        const auto index = ethernetCalls++;
        if (!ethernetRowRounds.empty())
            return QueryResult<std::vector<WifiLink>>::success(ethernetLinksFromRows(ethernetRowRounds[std::min<std::size_t>(index, ethernetRowRounds.size() - 1)]));
        return QueryResult<std::vector<WifiLink>>::success(ethernetRounds.empty() ? std::vector<WifiLink>{} : ethernetRounds[std::min<std::size_t>(index, ethernetRounds.size() - 1)]);
    }

    int statusCalls = 0;
    int counterCalls = 0;
    std::vector<std::string> disconnectedInterfaces;

    QueryResult<std::vector<WlanStatus>> wlanStatuses() override
    {
        ++statusCalls;
        if (statusesFailure)
            return QueryResult<std::vector<WlanStatus>>::failed(statusesFailure->kind, statusesFailure->detail, statusesFailure->interfaceId);
        const std::size_t index = statusRounds.empty() ? 0 : std::min<std::size_t>(static_cast<std::size_t>(statusCalls - 1), statusRounds.size() - 1);
        QueryResult<std::vector<WlanStatus>> result = statusRounds.empty()
            ? QueryResult<std::vector<WlanStatus>>::success({})
            : QueryResult<std::vector<WlanStatus>>::success(statusRounds[index]);
        for (const Failure& failure : perAdapterFailures)
            result.failures.push_back(failure);
        return result;
    }

    QueryResult<std::vector<InterfaceCounters>> interfaceCounters() override
    {
        ++counterCalls;
        if (countersFailure)
            return QueryResult<std::vector<InterfaceCounters>>::failed(countersFailure->kind, countersFailure->detail, countersFailure->interfaceId);
        return QueryResult<std::vector<InterfaceCounters>>::success(countersValue);
    }

    DisconnectCommand requestDisconnect(const std::string& interfaceId) override
    {
        disconnectedInterfaces.push_back(interfaceId);
        return disconnectResult;
    }

};

// 记录等待次数、不真的睡眠：断开复核的轮询在测试里必须瞬时完成。
struct FakeWait
{
    int calls = 0;
    std::chrono::milliseconds total{0};

    std::function<void(std::chrono::milliseconds)> function()
    {
        return [this](std::chrono::milliseconds duration) {
            ++calls;
            total += duration;
        };
    }
};

std::unique_ptr<WindowsNetworkPlatform> makePlatform(FakeSystem& system, FakeWait& wait)
{
    WindowsNetworkPlatform::Options options;
    options.system = &system;
    options.disconnectTimeout = std::chrono::seconds(2);
    options.disconnectPollInterval = std::chrono::milliseconds(100);
    options.wait = wait.function();
    return std::make_unique<WindowsNetworkPlatform>(options);
}

void samplesEthernetAlongsideWifi()
{
    FakeSystem system;
    system.statusRounds = {{connectedStatus("WLAN", "Home", "Home")}};
    WifiLink wired;
    wired.interfaceId = "Ethernet";
    wired.identity.type = "ethernet";
    wired.identity.profileUuid = "ethernet_00112233-4455-6677-8899-aabbccddeeff";
    wired.identity.ssid = "Ethernet:00112233-4455-6677-8899-aabbccddeeff";
    system.ethernetRounds = {{wired}};
    system.countersValue = {counters("WLAN", 100, 200), counters("Ethernet", 300, 400)};
    FakeWait wait;
    auto platform = makePlatform(system, wait);
    const auto report = platform->sampleWifi();
    WIFIMETER_CHECK_EQ(report.samples.size(), std::size_t(2));
}

RawInterfaceRow physicalEthernet()
{
    RawInterfaceRow row;
    row.alias = u"Ethernet";
    row.description = u"Intel Ethernet I219";
    row.index = 5;
    row.type = 6;
    row.guid = "{00112233-4455-6677-8899-AABBCCDDEEFF}";
    row.hardware = true;
    row.up = true;
    return row;
}

void excludesVirtualEthernetAndKeepsStableIdentity()
{
    auto wired = physicalEthernet();
    std::vector<RawInterfaceRow> rows{wired};
    for (const auto& name : {u"vEthernet (WSL)", u"Virtual Adapter", u"VMware", u"Hyper-V"})
    {
        auto row = wired;
        row.alias = name;
        row.guid = "11112233-4455-6677-8899-aabbccddeeff";
        rows.push_back(row);
    }
    auto software = wired;
    software.hardware = false;
    software.guid = "22112233-4455-6677-8899-aabbccddeeff";
    rows.push_back(software);
    auto wireless = wired;
    wireless.type = 71;
    rows.push_back(wireless);
    rows.push_back(wired); // 相同 GUID 重复枚举只保留一次。
    auto missingId = wired;
    missingId.guid.clear();
    rows.push_back(missingId);
    const auto links = ethernetLinksFromRows(rows);
    WIFIMETER_CHECK_EQ(links.size(), std::size_t(1));
    if (links.empty()) return;
    WIFIMETER_CHECK_EQ(links[0].identity.type, std::string("ethernet"));
    WIFIMETER_CHECK_EQ(links[0].identity.ssid.value_or(""), std::string("Ethernet:00112233-4455-6677-8899-aabbccddeeff"));
    WIFIMETER_CHECK(!links[0].signalPercent && !links[0].frequencyMhz);
    wired.alias = u"Office cable";
    wired.index = 90;
    wired.guid = "00112233-4455-6677-8899-aabbccddeeff";
    const auto renamed = ethernetLinksFromRows({wired});
    WIFIMETER_CHECK(renamed[0].identity.profileUuid == links[0].identity.profileUuid);
    WIFIMETER_CHECK(renamed[0].identity.ssid == links[0].identity.ssid);
    WIFIMETER_CHECK_EQ(renamed[0].identity.profileName, std::string("Office cable"));
    auto virtualDescription = wired;
    virtualDescription.description = u"Microsoft Hyper-V Network Adapter";
    WIFIMETER_CHECK(ethernetLinksFromRows({virtualDescription}).empty());
}

void samplesEthernetWithoutWlanAndRefusesDisconnect()
{
    FakeSystem system;
    system.statusesFailure = Failure{FailureKind::unavailable, {}, "WLAN disabled"};
    system.ethernetRowRounds = {{physicalEthernet()}};
    system.countersValue = {counters("Ethernet", 300, 400)};
    FakeWait wait;
    auto platform = makePlatform(system, wait);
    const auto report = platform->sampleWifi();
    WIFIMETER_CHECK_EQ(report.samples.size(), std::size_t(1));
    if (report.samples.empty()) return;
    WIFIMETER_CHECK_EQ(report.samples[0].identity.type, std::string("ethernet"));
    WIFIMETER_CHECK_EQ(report.samples[0].rxBytes, std::uint64_t(300));
    WIFIMETER_CHECK_EQ(report.samples[0].txBytes, std::uint64_t(400));
    WIFIMETER_CHECK_EQ(system.ethernetCalls, 2);
    const auto refused = platform->disconnectIfAssociated("Ethernet", *report.samples[0].identity.ssid);
    WIFIMETER_CHECK(refused.outcome == DisconnectOutcome::notAssociated);
    WIFIMETER_CHECK(system.disconnectedInterfaces.empty());
    WIFIMETER_CHECK(platform->wirelessLinks().links.empty());
}

void discardsEthernetWhenItDisappearsOrDisconnects()
{
    for (bool disappears : {false, true})
    {
        FakeSystem system;
        auto down = physicalEthernet();
        down.up = false;
        system.ethernetRowRounds = {{physicalEthernet()}, disappears ? std::vector<RawInterfaceRow>{} : std::vector<RawInterfaceRow>{down}};
        system.countersValue = {counters("Ethernet", 300, 400)};
        FakeWait wait;
        auto platform = makePlatform(system, wait);
        const auto report = platform->sampleWifi();
        WIFIMETER_CHECK(report.samples.empty());
        WIFIMETER_CHECK(hasFailure(report.failures, FailureKind::inconsistent, "Ethernet"));
        const auto idle = platform->sampleWifi();
        WIFIMETER_CHECK(idle.samples.empty());
        WIFIMETER_CHECK(idle.complete());
        WIFIMETER_CHECK_EQ(system.counterCalls, 1);
    }
    FakeSystem system;
    system.ethernetRowRounds = {{physicalEthernet()}};
    FakeWait wait;
    auto platform = makePlatform(system, wait);
    const auto missing = platform->sampleWifi();
    WIFIMETER_CHECK(missing.samples.empty());
    WIFIMETER_CHECK(hasFailure(missing.failures, FailureKind::countersMissing, "Ethernet"));
}

void fakeAdapterDataPreservesEthernetType()
{
    const auto parsed = fake::parseAdapters(R"({"adapters":[
        {"name":"cable","type":"ethernet","stableId":"00112233-4455-6677-8899-aabbccddeeff","connected":true},
        {"name":"WLAN","ssid":"Home","connected":true},
        {"name":"missing-id","type":"ethernet","connected":true}]})");
    WIFIMETER_CHECK(parsed.has_value());
    if (!parsed) return;
    const auto links = fake::linksFromAdapters(*parsed);
    WIFIMETER_CHECK_EQ(links.size(), std::size_t(3));
    WIFIMETER_CHECK_EQ(links[0].identity.type, std::string("ethernet"));
    WIFIMETER_CHECK(links[0].identity.associated());
    WIFIMETER_CHECK(ssidOfLink(links, "cable").empty());
    WIFIMETER_CHECK_EQ(links[1].identity.type, std::string("wifi"));
    WIFIMETER_CHECK_EQ(ssidOfLink(links, "WLAN"), std::string("Home"));
    WIFIMETER_CHECK(!links[2].identity.associated());
}

void reportsLinksWithIdentity()
{
    FakeSystem system;
    system.statusRounds = {{connectedStatus("WLAN", "Home 5G", "Home Profile", 88), disconnectedStatus("WLAN 2")}};
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const LinkReport report = platform->wirelessLinks();
    WIFIMETER_CHECK_EQ(report.links.size(), std::size_t(2));
    WIFIMETER_CHECK_EQ(report.links[0].interfaceId, std::string("WLAN"));
    WIFIMETER_CHECK_EQ(report.links[0].adapterAlias, std::string("Intel(R) Wi-Fi 6 AX201 160MHz"));
    WIFIMETER_CHECK_EQ(report.links[0].identity.ssid.value_or(""), std::string("Home 5G"));
    WIFIMETER_CHECK_EQ(report.links[0].identity.profileName, std::string("Home Profile"));
    WIFIMETER_CHECK_EQ(report.links[0].signalPercent.value_or(-1), 88);
    // Windows 不报告信道，频段保持未知而不是猜测。
    WIFIMETER_CHECK(report.links[0].band == Band::unknown);
    WIFIMETER_CHECK_EQ(std::string(bandLabel(report.links[0].band)), std::string(""));
    // 未关联网卡照样列出，身份为空。
    WIFIMETER_CHECK(!report.links[1].identity.associated());
    WIFIMETER_CHECK(report.complete());
}

void reportsGlobalFailureWhenWlanUnavailable()
{
    FakeSystem system;
    system.statusesFailure = Failure{FailureKind::unavailable, {}, "WlanOpenHandle 失败，错误码 1062"};
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const LinkReport links = platform->wirelessLinks();
    WIFIMETER_CHECK(links.links.empty());
    WIFIMETER_CHECK(hasGlobalFailure(links.failures, FailureKind::unavailable));

    const SampleReport samples = platform->sampleWifi();
    WIFIMETER_CHECK(samples.samples.empty());
    WIFIMETER_CHECK(hasGlobalFailure(samples.failures, FailureKind::unavailable));
    // 取不到状态时不应该再去读计数。
    WIFIMETER_CHECK_EQ(system.counterCalls, 0);

    const DisconnectReport disconnected = platform->disconnectIfAssociated("WLAN", "Home 5G");
    WIFIMETER_CHECK(disconnected.outcome == DisconnectOutcome::unavailable);
    WIFIMETER_CHECK(system.disconnectedInterfaces.empty());
}

void samplesAssociatedInterfacesWithCounters()
{
    FakeSystem system;
    system.statusRounds = {{connectedStatus("WLAN", "Home 5G", "Home Profile")}};
    system.countersValue = {counters("WLAN", 1000, 2000), counters("Ethernet", 10, 20)};
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const SampleReport report = platform->sampleWifi();
    WIFIMETER_CHECK_EQ(report.samples.size(), std::size_t(1));
    WIFIMETER_CHECK_EQ(report.samples[0].interfaceId, std::string("WLAN"));
    WIFIMETER_CHECK_EQ(report.samples[0].rxBytes, std::uint64_t(1000));
    WIFIMETER_CHECK_EQ(report.samples[0].txBytes, std::uint64_t(2000));
    WIFIMETER_CHECK_EQ(report.samples[0].identity.ssid.value_or(""), std::string("Home 5G"));
    WIFIMETER_CHECK(report.complete());
    // 采样会读两次状态，但只读一次计数。
    WIFIMETER_CHECK_EQ(system.statusCalls, 2);
    WIFIMETER_CHECK_EQ(system.counterCalls, 1);
}

void skipsWhenNothingAssociated()
{
    FakeSystem system;
    system.statusRounds = {{disconnectedStatus("WLAN")}};
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const SampleReport report = platform->sampleWifi();
    WIFIMETER_CHECK(report.samples.empty());
    // 未关联不是失败：报告仍然是完整的。
    WIFIMETER_CHECK(report.complete());
    WIFIMETER_CHECK_EQ(report.links.size(), std::size_t(1));
    // 没有已关联网卡就不必读计数。
    WIFIMETER_CHECK_EQ(system.counterCalls, 0);
    WIFIMETER_CHECK_EQ(system.statusCalls, 1);
}

void discardsSampleWhenNetworkChanged()
{
    FakeSystem system;
    // 采样前后身份不同：第二次读状态时已经切到了别的网络。
    system.statusRounds = {{connectedStatus("WLAN", "Home 5G", "Home Profile")}, {connectedStatus("WLAN", "Office", "Office Profile")}};
    system.countersValue = {counters("WLAN", 1000, 2000)};
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const SampleReport report = platform->sampleWifi();
    WIFIMETER_CHECK(report.samples.empty());
    WIFIMETER_CHECK(hasFailure(report.failures, FailureKind::inconsistent, "WLAN"));
    // 采样结束时带回的是当前（新）网络的状态，便于上层立刻反映切换。
    WIFIMETER_CHECK_EQ(report.links.size(), std::size_t(1));
    WIFIMETER_CHECK_EQ(report.links[0].identity.ssid.value_or(""), std::string("Office"));
}

void discardsSampleWhenProfileChanged()
{
    FakeSystem system;
    // SSID 相同但配置名不同（用户重建了配置）：身份变了，样本同样不可靠。
    system.statusRounds = {{connectedStatus("WLAN", "Home 5G", "Home Profile")}, {connectedStatus("WLAN", "Home 5G", "Home Profile 2")}};
    system.countersValue = {counters("WLAN", 1000, 2000)};
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const SampleReport report = platform->sampleWifi();
    WIFIMETER_CHECK(report.samples.empty());
    WIFIMETER_CHECK(hasFailure(report.failures, FailureKind::inconsistent, "WLAN"));
}

void reportsBandWhenTheChannelIsKnown()
{
    // 2.4 GHz 信道能推出频率，平台据此给出频段标签；与 Linux 侧用同一套边界。
    FakeSystem system;
    WlanStatus status = connectedStatus("WLAN", "Home", "Home");
    status.frequencyMhz = 2437;
    system.statusRounds = {{status}};
    system.countersValue = {counters("WLAN", 1, 2)};
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const SampleReport report = platform->sampleWifi();
    WIFIMETER_CHECK_EQ(report.links.size(), std::size_t(1));
    WIFIMETER_CHECK(report.links[0].band == Band::ghz2_4);
    WIFIMETER_CHECK_EQ(std::string(bandLabel(report.links[0].band)), std::string("2.4 GHz"));
    WIFIMETER_CHECK_EQ(report.links[0].frequencyMhz.value_or(0), 2437);

    // 频率未知时频段保持未知，而不是从信号强度之类的数据猜测。
    system.statusCalls = 0;
    system.statusRounds = {{connectedStatus("WLAN", "Home", "Home")}};
    const SampleReport unknown = platform->sampleWifi();
    WIFIMETER_CHECK(unknown.links[0].band == Band::unknown);
    WIFIMETER_CHECK(!unknown.links[0].frequencyMhz.has_value());
}

void samplesInAutomaticMode()
{
    // 真机上最常见的形态：Windows 自动连接到首选网络（mode = auto）。
    // 早先只认 profile，结果这张网卡被当成未关联，采样永远为空。
    FakeSystem system;
    WlanStatus automatic = connectedStatus("WLAN", "CMCC-mKm3-5G", "CMCC-mKm3-5G");
    automatic.mode = ConnectionMode::automatic;
    system.statusRounds = {{automatic}};
    system.countersValue = {counters("WLAN", 5000, 6000)};
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const SampleReport report = platform->sampleWifi();
    WIFIMETER_CHECK_EQ(report.samples.size(), std::size_t(1));
    WIFIMETER_CHECK_EQ(report.samples[0].identity.ssid.value_or(""), std::string("CMCC-mKm3-5G"));
    WIFIMETER_CHECK_EQ(report.samples[0].rxBytes, std::uint64_t(5000));
    WIFIMETER_CHECK(report.complete());
    // 这种网卡也要出现在实时状态里。
    WIFIMETER_CHECK_EQ(report.links.size(), std::size_t(1));
    WIFIMETER_CHECK(report.links[0].identity.associated());

    // 断开守卫同样要认得它：SSID 匹配时才允许断开。
    system.disconnectResult.accepted = true;
    // 上面的采样已经读了两次状态，这里把轮次重置到已知位置：
    // 判定一次 → 复核仍在关联一次 → 复核确认已断开。
    system.statusCalls = 0;
    system.statusRounds = {{automatic}, {automatic}, {disconnectedStatus("WLAN")}};
    const DisconnectReport disconnected = platform->disconnectIfAssociated("WLAN", "CMCC-mKm3-5G");
    WIFIMETER_CHECK(disconnected.outcome == DisconnectOutcome::disconnected);
}

void reportsMissingCounters()
{
    FakeSystem system;
    system.statusRounds = {{connectedStatus("WLAN", "Home 5G", "Home Profile")}};
    // 计数里没有这张网卡（例如刚被禁用）。
    system.countersValue = {counters("Ethernet", 10, 20)};
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const SampleReport report = platform->sampleWifi();
    WIFIMETER_CHECK(report.samples.empty());
    WIFIMETER_CHECK(hasFailure(report.failures, FailureKind::countersMissing, "WLAN"));
    // 计数缺失是单张网卡的失败，网络状态本身仍要如实上报。
    WIFIMETER_CHECK_EQ(report.links.size(), std::size_t(1));
}

void reportsCounterQueryFailure()
{
    FakeSystem system;
    system.statusRounds = {{connectedStatus("WLAN", "Home 5G", "Home Profile")}};
    system.countersFailure = Failure{FailureKind::commandFailed, {}, "GetIfTable2 失败，错误码 5"};
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const SampleReport report = platform->sampleWifi();
    WIFIMETER_CHECK(report.samples.empty());
    WIFIMETER_CHECK(hasGlobalFailure(report.failures, FailureKind::commandFailed));
}

// 第一次读状态成功、第二次失败的假系统：验证采样中途失联的处理。
class FlakyStatusSystem final : public SystemApi
{
public:
    int statusCalls = 0;
    int counterCalls = 0;

    QueryResult<std::vector<WlanStatus>> wlanStatuses() override
    {
        ++statusCalls;
        if (statusCalls == 1)
            return QueryResult<std::vector<WlanStatus>>::success({connectedStatus("WLAN", "Home 5G", "Home Profile")});
        return QueryResult<std::vector<WlanStatus>>::failed(FailureKind::unavailable, "WlanQueryInterface 失败，错误码 87");
    }

    QueryResult<std::vector<InterfaceCounters>> interfaceCounters() override
    {
        ++counterCalls;
        return QueryResult<std::vector<InterfaceCounters>>::success({counters("WLAN", 1, 2)});
    }

    DisconnectCommand requestDisconnect(const std::string&) override
    {
        return {};
    }

};

void reportsStatusFailureAfterCounters()
{
    FlakyStatusSystem system;
    FakeWait wait;
    WindowsNetworkPlatform::Options options;
    options.system = &system;
    options.wait = wait.function();
    WindowsNetworkPlatform platform(options);

    const SampleReport report = platform.sampleWifi();
    // 身份无法二次确认时宁可丢弃样本，也不能把流量记到可能已经变化的网络上。
    WIFIMETER_CHECK(report.samples.empty());
    WIFIMETER_CHECK(hasGlobalFailure(report.failures, FailureKind::unavailable));
    WIFIMETER_CHECK_EQ(system.counterCalls, 1);
}

void reportsFailuresAlongsideUsableStatuses()
{
    // 一张网卡查不动、另一张正常：失败要上报，正常那张仍要参与采样。
    FakeSystem system;
    system.statusRounds = {{connectedStatus("WLAN", "Home 5G", "Home Profile"), connectedStatus("WLAN 2", "Office", "Office Profile")}};
    system.perAdapterFailures = {Failure{FailureKind::inconsistent, "WLAN 2", "网卡报告已连接，但无法读取连接属性。"}};
    system.countersValue = {counters("WLAN", 100, 200), counters("WLAN 2", 300, 400)};
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const LinkReport links = platform->wirelessLinks();
    WIFIMETER_CHECK(hasFailure(links.failures, FailureKind::inconsistent, "WLAN 2"));
    // 逐网卡失败不能让整体变成不可用：两张网卡的状态都还在。
    WIFIMETER_CHECK_EQ(links.links.size(), std::size_t(2));

    const SampleReport report = platform->sampleWifi();
    WIFIMETER_CHECK(hasFailure(report.failures, FailureKind::inconsistent, "WLAN 2"));
    // 正常的网卡照常产出样本：单张网卡的问题不影响其他网卡。
    WIFIMETER_CHECK_EQ(report.samples.size(), std::size_t(2));
    WIFIMETER_CHECK_EQ(report.samples[0].rxBytes, std::uint64_t(100));
}

void keepsLiveStateWhenOnlyOneAdapterFails()
{
    // 逐网卡失败不能算成“整条 WLAN 栈不可用”，否则界面会从“已连接”跳到“采集器暂未响应”。
    FakeSystem system;
    system.statusRounds = {{connectedStatus("WLAN", "Home 5G", "Home Profile")}};
    system.perAdapterFailures = {Failure{FailureKind::inconsistent, "WLAN 2", "无法取得网卡的接口别名，已退回驱动描述。"}};
    system.countersValue = {counters("WLAN", 1, 2)};
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const SampleReport report = platform->sampleWifi();
    WIFIMETER_CHECK(!hasGlobalFailure(report.failures, FailureKind::unavailable));
    WIFIMETER_CHECK_EQ(report.samples.size(), std::size_t(1));
}

void refusesDisconnectWhenNotAssociated()
{
    FakeSystem system;
    system.statusRounds = {{disconnectedStatus("WLAN")}};
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const DisconnectReport report = platform->disconnectIfAssociated("WLAN", "Home 5G");
    WIFIMETER_CHECK(report.outcome == DisconnectOutcome::notAssociated);
    // 判定不通过就不能碰系统状态。
    WIFIMETER_CHECK(system.disconnectedInterfaces.empty());
}

void refusesDisconnectOnSsidMismatch()
{
    FakeSystem system;
    system.statusRounds = {{connectedStatus("WLAN", "Office", "Office Profile")}};
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const DisconnectReport report = platform->disconnectIfAssociated("WLAN", "Home 5G");
    WIFIMETER_CHECK(report.outcome == DisconnectOutcome::ssidMismatch);
    WIFIMETER_CHECK(system.disconnectedInterfaces.empty());
}

void disconnectWaitsForStateToChange()
{
    FakeSystem system;
    // 请求被接受后，状态要再读两次才变成未连接（Windows 的断开是异步的）。
    system.statusRounds = {
        {connectedStatus("WLAN", "Home 5G", "Home Profile")},
        {connectedStatus("WLAN", "Home 5G", "Home Profile")},
        {disconnectedStatus("WLAN")},
    };
    system.disconnectResult.accepted = true;
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const DisconnectReport report = platform->disconnectIfAssociated("WLAN", "Home 5G");
    WIFIMETER_CHECK(report.outcome == DisconnectOutcome::disconnected);
    WIFIMETER_CHECK_EQ(system.disconnectedInterfaces.size(), std::size_t(1));
    WIFIMETER_CHECK_EQ(system.disconnectedInterfaces[0], std::string("WLAN"));
    // 等了一次才复核成功。
    WIFIMETER_CHECK_EQ(wait.calls, 1);
}

void disconnectTimesOutWhenStillAssociated()
{
    FakeSystem system;
    // 状态一直是已关联：例如系统随即自动重连。假的等待函数不消耗时间，因此按次数收敛。
    system.statusRounds = {{connectedStatus("WLAN", "Home 5G", "Home Profile")}};
    system.disconnectResult.accepted = true;
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const DisconnectReport report = platform->disconnectIfAssociated("WLAN", "Home 5G");
    WIFIMETER_CHECK(report.outcome == DisconnectOutcome::stillAssociated);
    // 轮询有确定上限：2 秒超时、100 毫秒间隔 → 最多看 20 次，等 19 次。
    // 不能无限等下去，也不能因为最后一次之后的等待而超出预算。
    WIFIMETER_CHECK_EQ(wait.calls, 19);
    WIFIMETER_CHECK(wait.total == std::chrono::milliseconds(1900));
    // 首次判定 1 次 + 轮询 20 次。
    WIFIMETER_CHECK_EQ(system.statusCalls, 21);
}

void disconnectReportsUnavailableWhenRequestRejected()
{
    FakeSystem system;
    system.statusRounds = {{connectedStatus("WLAN", "Home 5G", "Home Profile")}};
    system.disconnectResult.accepted = false;
    system.disconnectResult.failureKind = FailureKind::unavailable;
    system.disconnectResult.detail = "WlanDisconnect 失败，错误码 1062";
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const DisconnectReport report = platform->disconnectIfAssociated("WLAN", "Home 5G");
    WIFIMETER_CHECK(report.outcome == DisconnectOutcome::unavailable);
    WIFIMETER_CHECK_EQ(report.detail, std::string("WlanDisconnect 失败，错误码 1062"));
    WIFIMETER_CHECK_EQ(wait.calls, 0);
}

void disconnectReportsCommandFailedWhenStatusUnreadable()
{
    FakeSystem system;
    system.statusesFailure = Failure{FailureKind::commandFailed, {}, "WlanQueryInterface 失败，错误码 87"};
    FakeWait wait;
    auto platform = makePlatform(system, wait);

    const DisconnectReport report = platform->disconnectIfAssociated("WLAN", "Home 5G");
    WIFIMETER_CHECK(report.outcome == DisconnectOutcome::commandFailed);
    WIFIMETER_CHECK(system.disconnectedInterfaces.empty());
}

}  // namespace

int main()
{
    fakeAdapterDataPreservesEthernetType();
    samplesEthernetAlongsideWifi();
    excludesVirtualEthernetAndKeepsStableIdentity();
    samplesEthernetWithoutWlanAndRefusesDisconnect();
    discardsEthernetWhenItDisappearsOrDisconnects();
    reportsLinksWithIdentity();
    reportsGlobalFailureWhenWlanUnavailable();
    samplesAssociatedInterfacesWithCounters();
    skipsWhenNothingAssociated();
    discardsSampleWhenNetworkChanged();
    discardsSampleWhenProfileChanged();
    reportsBandWhenTheChannelIsKnown();
    samplesInAutomaticMode();
    reportsMissingCounters();
    reportsCounterQueryFailure();
    reportsStatusFailureAfterCounters();
    reportsFailuresAlongsideUsableStatuses();
    keepsLiveStateWhenOnlyOneAdapterFails();
    refusesDisconnectWhenNotAssociated();
    refusesDisconnectOnSsidMismatch();
    disconnectWaitsForStateToChange();
    disconnectTimesOutWhenStillAssociated();
    disconnectReportsUnavailableWhenRequestRejected();
    disconnectReportsCommandFailedWhenStatusUnreadable();
    return WIFIMETER_REPORT();
}
