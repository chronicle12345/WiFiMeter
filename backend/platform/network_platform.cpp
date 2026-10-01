#include "network_platform.h"

#include <cstdio>

namespace wifimeter::platform
{

NetworkIdentity ethernetIdentity(std::string_view stableId, const std::string& name, bool connected)
{
    NetworkIdentity identity;
    identity.type = "ethernet";
    identity.profileName = name;
    if (stableId.empty())
        return identity;
    // GUID 可直接保留；MAC 和设备路径散列后仍满足 network.id 的字符与长度约束。
    bool safe = stableId.size() <= 55;
    for (const char ch : stableId)
        safe = safe && ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-');
    std::string key(stableId);
    if (!safe)
    {
        std::uint64_t hash = 14695981039346656037ULL;
        for (const unsigned char ch : stableId)
        {
            hash ^= ch;
            hash *= 1099511628211ULL;
        }
        char buffer[17]{};
        std::snprintf(buffer, sizeof(buffer), "%016llx", static_cast<unsigned long long>(hash));
        key = buffer;
    }
    identity.profileUuid = "ethernet_" + key;
    if (connected)
        identity.ssid = "Ethernet:" + std::string(stableId);
    return identity;
}

Band classifyBand(int frequencyMhz)
{
    // 边界按 IEEE 802.11 的频段划分：5 GHz 与 6 GHz 之间留出的间隔不予归类。
    if (frequencyMhz >= 2400 && frequencyMhz <= 2500)
        return Band::ghz2_4;
    if (frequencyMhz >= 4900 && frequencyMhz <= 5895)
        return Band::ghz5;
    if (frequencyMhz >= 5925 && frequencyMhz <= 7125)
        return Band::ghz6;
    if (frequencyMhz >= 57000 && frequencyMhz <= 71000)
        return Band::ghz60;
    return Band::unknown;
}

std::string_view bandLabel(Band band)
{
    switch (band)
    {
        case Band::ghz2_4:
            return "2.4 GHz";
        case Band::ghz5:
            return "5 GHz";
        case Band::ghz6:
            return "6 GHz";
        case Band::ghz60:
            return "60 GHz";
        case Band::unknown:
            break;
    }
    return {};
}

}  // namespace wifimeter::platform
