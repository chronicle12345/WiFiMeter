#include "wlan.h"

#include <algorithm>

#include "text_convert.h"

namespace wifimeter::platform::windows
{
namespace
{

// Windows 的 wlanSignalQuality 是 0..100 的百分比，但驱动可能报告越界值。
std::optional<int> signalFrom(std::uint32_t quality, bool present)
{
    if (!present || quality > 100)
        return std::nullopt;
    return static_cast<int>(quality);
}

}  // namespace

ConnectionMode connectionModeFrom(std::uint32_t value)
{
    switch (value)
    {
        case 0:
            return ConnectionMode::profile;
        case 1:
            return ConnectionMode::temporaryProfile;
        case 2:
            return ConnectionMode::discoverySecure;
        case 3:
            return ConnectionMode::discoveryUnsecure;
        case 4:
            return ConnectionMode::automatic;
        default:
            return ConnectionMode::invalid;
    }
}

bool isConnectedMode(ConnectionMode mode)
{
    // 只有两个 discovery 取值代表“还没连上”。invalid 是未知，保守地不算已连接。
    return mode == ConnectionMode::profile || mode == ConnectionMode::temporaryProfile || mode == ConnectionMode::automatic;
}

std::optional<int> frequencyFromChannel(int channel)
{
    // 2.4 GHz：信道 1..13 从 2412 MHz 起每信道 5 MHz；日本追加信道 14 = 2484 MHz。
    // 这段映射唯一，可以放心换算。
    if (channel >= 1 && channel <= 13)
        return 2407 + channel * 5;
    if (channel == 14)
        return 2484;

    // 其余信道号不唯一：5 GHz 与 6 GHz 都从信道 1 重新编号，同一个数字（例如 36）
    // 在两个频段里都存在。仅凭信道号无法判断属于哪个频段，因此宁可不报，也不猜一个
    // 可能错误的频率——频段显示错误比显示“未知”更糟。
    //
    // 想要覆盖这两个频段需要另一条数据来源：WlanGetNetworkBssList 的
    // ulChCenterFrequency 会直接给出当前网络的中心频率（实测 5745000 kHz = 5745 MHz，
    // 即 5 GHz 的 149 信道），代价是每次查询多一次调用，留待需要时再补。
    return std::nullopt;
}

bool isAssociatedState(bool connected, ConnectionMode mode, std::string_view ssid)
{
    return connected && isConnectedMode(mode) && !ssid.empty();
}

bool isAssociated(const WlanInterface& link)
{
    return isAssociatedState(link.connected, link.mode, link.ssid.value_or(std::string{}));
}

std::string adapterAliasFrom(std::string_view description, std::string_view interfaceId)
{
    if (!description.empty())
        return std::string(description);
    return std::string(interfaceId);
}

WlanInterface wlanInterfaceFrom(const RawWlanInterface& raw)
{
    WlanInterface interface;
    interface.interfaceId = toUtf8(raw.alias);
    interface.description = toUtf8(raw.description);
    interface.adapterAlias = adapterAliasFrom(interface.description, interface.interfaceId);
    interface.connected = raw.connected;
    interface.mode = connectionModeFrom(raw.connectionMode);
    interface.profileName = toUtf8(raw.profileName);

    // SSID 已经是原始字节串（DOT11_SSID.ucSSID）：直接使用，不再按 UTF-16 解释。
    const std::string ssid = raw.hasSsid ? raw.ssid : std::string{};
    if (isAssociatedState(interface.connected, interface.mode, ssid))
        interface.ssid = ssid;

    interface.signalPercent = signalFrom(raw.signalQuality, raw.hasSignal);
    if (raw.channel > 0)
        interface.frequencyMhz = frequencyFromChannel(static_cast<int>(raw.channel));
    return interface;
}

std::vector<WlanInterface> wlanInterfacesFrom(const std::vector<RawWlanInterface>& raw)
{
    std::vector<WlanInterface> interfaces;
    interfaces.reserve(raw.size());
    for (const RawWlanInterface& item : raw)
        interfaces.push_back(wlanInterfaceFrom(item));
    return interfaces;
}

const WlanInterface* findWlanInterface(const std::vector<WlanInterface>& interfaces, std::string_view interfaceId)
{
    const auto found = std::find_if(interfaces.begin(), interfaces.end(), [interfaceId](const WlanInterface& item) { return item.interfaceId == interfaceId; });
    return found == interfaces.end() ? nullptr : &*found;
}

}  // namespace wifimeter::platform::windows
