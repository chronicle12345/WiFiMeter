// 网络键推导测试：结果必须满足快照对 network.id 的字符集与长度约束。

#include "../core/network_key.h"

#include <string>

#include "test_support.h"

using namespace wifimeter::core;

namespace platform = wifimeter::platform;

namespace
{

platform::NetworkIdentity identity(const std::string& uuid, const std::string& name, const std::string& ssid)
{
    platform::NetworkIdentity value;
    if (!uuid.empty())
        value.profileUuid = uuid;
    value.profileName = name;
    if (!ssid.empty())
        value.ssid = ssid;
    return value;
}

void acceptsValidKeys()
{
    WIFIMETER_CHECK(isValidNetworkKey("home"));
    WIFIMETER_CHECK(isValidNetworkKey("21f995e7-fe3b-41a1-ae3a-6468c6918397"));
    WIFIMETER_CHECK(isValidNetworkKey("ssid_0123456789abcdef"));
    WIFIMETER_CHECK(isValidNetworkKey("a_b-C9"));
    WIFIMETER_CHECK(isValidNetworkKey(std::string(64, 'a')));
}

void rejectsInvalidKeys()
{
    WIFIMETER_CHECK(!isValidNetworkKey(""));
    WIFIMETER_CHECK(!isValidNetworkKey(std::string(65, 'a')));
    WIFIMETER_CHECK(!isValidNetworkKey("家里的 Wi-Fi"));
    WIFIMETER_CHECK(!isValidNetworkKey("has space"));
    WIFIMETER_CHECK(!isValidNetworkKey("has:colon"));
    WIFIMETER_CHECK(!isValidNetworkKey("dot.dot"));
    WIFIMETER_CHECK(!isValidNetworkKey("slash/name"));
}

void prefersTheProfileUuid()
{
    const NetworkRef reference = networkRefOf(identity("21f995e7-fe3b-41a1-ae3a-6468c6918397", "Home Profile", "Habitat_5G"));
    WIFIMETER_CHECK_EQ(reference.key, std::string("21f995e7-fe3b-41a1-ae3a-6468c6918397"));
    WIFIMETER_CHECK_EQ(reference.ssid, std::string("Habitat_5G"));
    WIFIMETER_CHECK(reference.valid());
    WIFIMETER_CHECK(isValidNetworkKey(reference.key));
}

void fallsBackToTheSsidHash()
{
    const NetworkRef reference = networkRefOf(identity("", "有线连接 1", "家里的 Wi-Fi"));
    WIFIMETER_CHECK_EQ(reference.ssid, std::string("家里的 Wi-Fi"));
    WIFIMETER_CHECK(reference.valid());
    WIFIMETER_CHECK(isValidNetworkKey(reference.key));
    WIFIMETER_CHECK_EQ(reference.key, fallbackKeyForSsid("家里的 Wi-Fi"));
    WIFIMETER_CHECK_EQ(reference.key.size(), std::size_t{21});  // "ssid_" 加 16 位十六进制
}

void rejectsIllegalProfileUuids()
{
    // 配置 UUID 含非法字符时不能直接当键用，退回 SSID 散列。
    const NetworkRef reference = networkRefOf(identity("not a valid uuid", "Profile", "Home"));
    WIFIMETER_CHECK_EQ(reference.key, fallbackKeyForSsid("Home"));
}

void derivesStableDistinctKeysFromSsids()
{
    WIFIMETER_CHECK_EQ(fallbackKeyForSsid("Home"), fallbackKeyForSsid("Home"));
    WIFIMETER_CHECK(fallbackKeyForSsid("Home") != fallbackKeyForSsid("home"));  // SSID 区分大小写
    WIFIMETER_CHECK(fallbackKeyForSsid("Home") != fallbackKeyForSsid("Office"));
    WIFIMETER_CHECK(fallbackKeyForSsid("").empty());
}

void reportsUnknownIdentity()
{
    const NetworkRef reference = networkRefOf(identity("", "", ""));
    WIFIMETER_CHECK(!reference.valid());
    WIFIMETER_CHECK(reference.key.empty());
}

}  // namespace

int main()
{
    acceptsValidKeys();
    rejectsInvalidKeys();
    prefersTheProfileUuid();
    fallsBackToTheSsidHash();
    rejectsIllegalProfileUuids();
    derivesStableDistinctKeysFromSsids();
    reportsUnknownIdentity();
    return WIFIMETER_REPORT();
}
