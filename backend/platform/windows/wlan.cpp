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
