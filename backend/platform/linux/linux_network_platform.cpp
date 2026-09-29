#include "linux_network_platform.h"

#include <algorithm>
#include <optional>
#include <utility>

#include "proc_net_dev.h"
#include "wifi_control.h"

namespace wifimeter::platform::linux
{
namespace
{

const WirelessInterfaceInfo* findInterface(const std::vector<WirelessInterfaceInfo>& interfaces, const std::string& name)
{
    const auto found = std::find_if(interfaces.begin(), interfaces.end(), [&name](const WirelessInterfaceInfo& item) { return item.name == name; });
    return found == interfaces.end() ? nullptr : &*found;
}

const WifiLink* findLink(const std::vector<WifiLink>& links, const std::string& interfaceId)
{
    const auto found = std::find_if(links.begin(), links.end(), [&interfaceId](const WifiLink& item) { return item.interfaceId == interfaceId; });
    return found == links.end() ? nullptr : &*found;
}

// 已关联时返回网络名，未关联或身份缺失时返回空字符串。
std::string ssidOf(const WifiLink* link)
{
    if (link == nullptr || !link->identity.ssid)
        return {};
    return *link->identity.ssid;
}

bool isAssociated(const WifiLink& link)
{
    return link.identity.associated();
}

}  // namespace

LinuxNetworkPlatform::LinuxNetworkPlatform()
    : LinuxNetworkPlatform(Options{})
{}

LinuxNetworkPlatform::LinuxNetworkPlatform(Options options)
    : options_(std::move(options)),
      nmcli_(options_.nmcliExecutable, options_.commandTimeout)
{}

LinkReport LinuxNetworkPlatform::readLinks()
{
    LinkReport report;
    const Nmcli::DevicesResult devices = nmcli_.devices();
    if (!devices.ok())
    {
        report.failures.push_back(*devices.failure);
        return report;
    }

    const std::vector<WirelessInterfaceInfo> interfaces = listWirelessInterfaces(options_.sysClassNet);
    for (const DeviceStatus& device : devices.devices)
    {
        if (device.type != "wifi")
            continue;

        WifiLink link;
        link.interfaceId = device.device;
        link.adapterAlias = adapterAliasFrom(device.vendor, device.product);
        if (link.adapterAlias.empty())
            link.adapterAlias = device.device;
        if (!device.connectionUuid.empty())
            link.identity.profileUuid = device.connectionUuid;
        link.identity.profileName = device.connection;
        link.identity.ssid = device.ssid;

        // 内核链路已断开，但连接管理器仍报告已激活：身份不可靠，本轮不报告该网卡。
        const WirelessInterfaceInfo* info = findInterface(interfaces, device.device);
        if (link.identity.associated() && info != nullptr && info->operstate == "down")
        {
            report.failures.push_back({FailureKind::inconsistent, device.device, "内核链路已断开，但连接管理器仍报告已激活。"});
            continue;
        }

        // 信号与频段来自扫描结果，按 SSID 原文匹配，不依赖任何本地化文本；
        // 它们只是可选信息，查询失败时保留网卡但把失败原因上报。
        if (link.identity.associated())
        {
            const Nmcli::WifiListResult list = nmcli_.wifiList(device.device);
            if (list.ok())
            {
                if (const auto bss = findBssBySsid(list.list, *link.identity.ssid))
                {
                    link.signalPercent = bss->signalPercent;
                    link.frequencyMhz = bss->frequencyMhz;
                    if (link.frequencyMhz)
                        link.band = classifyBand(*link.frequencyMhz);
                }
            }
            else if (list.failure)
            {
                report.failures.push_back(*list.failure);
            }
        }
        report.links.push_back(std::move(link));
    }
    return report;
}

LinkReport LinuxNetworkPlatform::wirelessLinks()
{
    return readLinks();
}

SampleReport LinuxNetworkPlatform::sampleWifi()
{
    SampleReport report;
    const LinkReport before = readLinks();
    report.failures = before.failures;

    const bool anyAssociated = std::any_of(before.links.begin(), before.links.end(), isAssociated);
    const std::vector<InterfaceCounters> counters = anyAssociated ? readInterfaceCounters(options_.procNetDevPath) : std::vector<InterfaceCounters>{};

    LinkReport after;
    if (anyAssociated)
    {
        after = readLinks();
        report.failures.insert(report.failures.end(), after.failures.begin(), after.failures.end());
    }

    for (const WifiLink& link : before.links)
    {
        if (!link.identity.associated())
            continue;

        // 读取计数前后必须关联到同一个网络，否则这次样本无法可靠归属。
        const WifiLink* current = findLink(after.links, link.interfaceId);
        if (current == nullptr || current->identity.ssid != link.identity.ssid)
        {
            report.failures.push_back({FailureKind::inconsistent, link.interfaceId, "采样期间网络发生变化，已丢弃该样本。"});
            continue;
        }

        const auto counted = findInterfaceCounters(counters, link.interfaceId);
        if (!counted)
        {
            report.failures.push_back({FailureKind::countersMissing, link.interfaceId, "内核计数中没有这张网卡。"});
            continue;
        }

        WifiSample sample;
        sample.interfaceId = link.interfaceId;
        sample.identity = link.identity;
        sample.rxBytes = counted->rxBytes;
        sample.txBytes = counted->txBytes;
        report.samples.push_back(std::move(sample));
    }

    // 把确认过的网卡状态一并带回去，上层展示实时状态时不必再查一次系统。
    for (const WifiLink& link : after.links)
    {
        if (findLink(report.links, link.interfaceId) != nullptr)
            continue;
        report.links.push_back(link);
    }
    return report;
}

DisconnectReport LinuxNetworkPlatform::disconnectIfAssociated(const std::string& interfaceId, const std::string& expectedSsid)
{
    const LinkReport before = wirelessLinks();
    const std::string current = ssidOf(findLink(before.links, interfaceId));

    const DisconnectOutcome decision = decideDisconnect(current, expectedSsid);
    if (decision != DisconnectOutcome::disconnected)
    {
        DisconnectReport report;
        report.outcome = decision;
        return report;
    }

    DisconnectReport report = requestDisconnect(interfaceId, nmcli_);
    if (report.outcome != DisconnectOutcome::disconnected)
        return report;

    // 复核断开是否真的生效：命令成功但随即被自动重连时不能报告成功。
    const LinkReport refreshed = wirelessLinks();
    if (ssidOf(findLink(refreshed.links, interfaceId)) == expectedSsid)
        report.outcome = DisconnectOutcome::stillAssociated;
    return report;
}

}  // namespace wifimeter::platform::linux
