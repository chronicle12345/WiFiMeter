#include "network_key.h"

#include <cstdint>
#include <cstdio>

namespace wifimeter::core
{
namespace
{

// 快照中 network.id 的最大长度（model.js 的 validString(n.id, 64)）。
constexpr std::size_t kMaxKeyLength = 64;

std::uint64_t fnv1a(std::string_view text)
{
    std::uint64_t hash = 14695981039346656037ULL;
    for (const char character : text)
    {
        hash ^= static_cast<unsigned char>(character);
        hash *= 1099511628211ULL;
    }
    return hash;
}

std::string toHex(std::uint64_t value)
{
    char buffer[17] = {};
    std::snprintf(buffer, sizeof(buffer), "%016llx", static_cast<unsigned long long>(value));
    return buffer;
}

}  // namespace

bool isValidNetworkKey(std::string_view key)
{
    if (key.empty() || key.size() > kMaxKeyLength)
        return false;
    for (const char character : key)
    {
        const bool allowed = (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character == '-' || character == '_';
        if (!allowed)
            return false;
    }
    return true;
}

std::string fallbackKeyForSsid(std::string_view ssid)
{
    if (ssid.empty())
        return {};
    return "ssid_" + toHex(fnv1a(ssid));
}

NetworkRef networkRefOf(const platform::NetworkIdentity& identity)
{
    NetworkRef reference;
    reference.type = identity.type;
    if (identity.ssid)
        reference.ssid = *identity.ssid;

    if (identity.profileUuid && isValidNetworkKey(*identity.profileUuid))
    {
        reference.key = *identity.profileUuid;
        return reference;
    }

    // 配置 UUID 缺失或不合法时退回 SSID 散列；两者都没有则无法归属。
    reference.key = fallbackKeyForSsid(reference.ssid);
    return reference;
}

}  // namespace wifimeter::core
