#include "linux_network_platform.h"

#include <algorithm>
#include <optional>
#include <utility>

#include "../fake_source.h"
#include "../sampling.h"
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

}  // namespace

LinuxNetworkPlatform::LinuxNetworkPlatform()
    : LinuxNetworkPlatform(Options{})
{}

LinuxNetworkPlatform::LinuxNetworkPlatform(Options options)
    : options_(std::move(options)),
      nmcli_(options_.nmcliExecutable, options_.commandTimeout)
{}

LinkReport LinuxNetworkPlatform::readStatuses()
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
    return readStatuses();
}

SampleReport LinuxNetworkPlatform::sampleWifi()
{
    // 采样时序由 platform/sampling.cpp 统一实现，平台只提供数据：
    // 两端共用同一份“前后各确认一次身份”的逻辑，避免各自漂移。
    return sampleFrom(*this);
}

DisconnectReport LinuxNetworkPlatform::disconnectIfAssociated(const std::string& interfaceId, const std::string& expectedSsid)
{
    return disconnectFrom(*this, interfaceId, expectedSsid, [this](const std::string& target, const std::string& expected) {
        // 复核：重新读一次状态，仍关联在期望网络上就说明断开没生效（例如随即被自动重连）。
        const LinkReport refreshed = readStatuses();
        return ssidOf(findLink(refreshed.links, target)) != expected;
    });
}

LinkReadResult LinuxNetworkPlatform::readLinks()
{
    LinkReadResult result;

    // 测试数据源优先，而且必须完全取代系统调用：这台机器上没有 nmcli 时，
    // 继续调用只会产生一条全局失败，测试数据再正确也读不到。
    if (fake::adapterOverrideActive())
    {
        const auto adapters = fake::readOverriddenAdapters();
        if (!adapters)
        {
            result.failures.push_back({FailureKind::unavailable, {}, "无法读取测试用网卡数据。"});
            return result;
        }
        result.links = fake::linksFromAdapters(*adapters);
        return result;
    }

    const LinkReport report = readStatuses();
    result.links = report.links;
    result.failures = report.failures;
    return result;
}

CounterReadResult LinuxNetworkPlatform::readCounters()
{
    CounterReadResult result;
    // 测试数据源优先：设置了 WIFIMETER_FAKE_COUNTERS 时不再读 /proc/net/dev，
    // 这样端到端测试不必依赖真实网卡，也不会因为缺少计数而误判。
    if (fake::countersOverrideActive())
    {
        const auto counters = fake::readOverriddenCounters();
        if (!counters)
        {
            result.failures.push_back({FailureKind::unavailable, {}, "无法读取测试用计数数据。"});
            return result;
        }
        result.counters = *counters;
        return result;
    }

    for (const InterfaceCounters& entry : readInterfaceCounters(options_.procNetDevPath))
    {
        CounterReading reading;
        reading.interfaceId = entry.interfaceId;
        reading.rxBytes = entry.rxBytes;
        reading.txBytes = entry.txBytes;
        result.counters.push_back(std::move(reading));
    }
    return result;
}

DisconnectOutcome LinuxNetworkPlatform::requestDisconnect(const std::string& interfaceId, std::string& detail)
{
    const DisconnectReport report = linux::requestDisconnect(interfaceId, nmcli_);
    detail = report.detail;
    return report.outcome;
}

}  // namespace wifimeter::platform::linux
