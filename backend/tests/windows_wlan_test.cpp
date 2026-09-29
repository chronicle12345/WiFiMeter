// WLAN 状态转换测试：用构造的系统结果验证“是否关联”“身份字段”“信号强度”的判定。
//
// 重点是不要把仅扫描（discover）与临时网络（adhoc）误判成已关联：那会让无法归属的
// 流量被计到错误的网络上。

#include "../platform/windows/wlan.h"

#include <cstdint>
#include <string>
#include <vector>

#include "test_support.h"
#include "windows_test_support.h"

using namespace wifimeter::platform::windows;
using wifimeter::test::windows_support::utf16;

namespace
{

RawWlanInterface connected(const std::string& alias, const std::string& ssid, const std::string& profile)
{
    RawWlanInterface raw;
    raw.alias = utf16(alias);
    raw.description = utf16("Intel(R) Wi-Fi 6 AX201 160MHz");
    raw.connected = true;
    raw.connectionMode = static_cast<std::uint32_t>(ConnectionMode::profile);
    raw.profileName = utf16(profile);
    raw.ssid = utf16(ssid);
    raw.hasSsid = true;
    raw.signalQuality = 72;
    raw.hasSignal = true;
    return raw;
}

void classifiesConnectionModes()
{
    WIFIMETER_CHECK(connectionModeFrom(0) == ConnectionMode::profile);
    WIFIMETER_CHECK(connectionModeFrom(1) == ConnectionMode::adhoc);
    WIFIMETER_CHECK(connectionModeFrom(2) == ConnectionMode::discover);
    WIFIMETER_CHECK(connectionModeFrom(3) == ConnectionMode::unknown);
    // 未来版本新增的取值按未知处理，而不是猜成已连接。
    WIFIMETER_CHECK(connectionModeFrom(99) == ConnectionMode::unknown);
}

void requiresConnectedProfileWithSsid()
{
    WIFIMETER_CHECK(isAssociatedState(true, ConnectionMode::profile, "Home"));
    WIFIMETER_CHECK(!isAssociatedState(false, ConnectionMode::profile, "Home"));
    WIFIMETER_CHECK(!isAssociatedState(true, ConnectionMode::discover, "Home"));
    WIFIMETER_CHECK(!isAssociatedState(true, ConnectionMode::adhoc, "Home"));
    WIFIMETER_CHECK(!isAssociatedState(true, ConnectionMode::unknown, "Home"));
    // 状态位说已连接但拿不到 SSID：身份不可靠，不产生样本。
    WIFIMETER_CHECK(!isAssociatedState(true, ConnectionMode::profile, ""));
}

void convertsConnectedInterface()
{
    const WlanInterface interface = wlanInterfaceFrom(connected("WLAN", "Home 5G", "Home Profile"));
    WIFIMETER_CHECK_EQ(interface.interfaceId, std::string("WLAN"));
    WIFIMETER_CHECK_EQ(interface.adapterAlias, std::string("Intel(R) Wi-Fi 6 AX201 160MHz"));
    WIFIMETER_CHECK_EQ(interface.profileName, std::string("Home Profile"));
    WIFIMETER_CHECK(interface.ssid.has_value());
    WIFIMETER_CHECK_EQ(interface.ssid.value_or(""), std::string("Home 5G"));
    WIFIMETER_CHECK(interface.signalPercent.has_value());
    WIFIMETER_CHECK_EQ(interface.signalPercent.value_or(-1), 72);
    WIFIMETER_CHECK(isAssociated(interface));
}

void dropsSsidWhenNotAssociated()
{
    RawWlanInterface raw = connected("WLAN", "Home 5G", "Home Profile");
    raw.connected = false;
    const WlanInterface interface = wlanInterfaceFrom(raw);
    // 未关联时残留的 SSID 不能当作身份。
    WIFIMETER_CHECK(!interface.ssid.has_value());
    WIFIMETER_CHECK(!isAssociated(interface));
    // 信号强度仍可上报：它是网卡状态而不是身份。
    WIFIMETER_CHECK(interface.signalPercent.has_value());
}

void dropsSsidForAdHoc()
{
    RawWlanInterface raw = connected("WLAN", "Direct-ABC", "Direct");
    raw.connectionMode = static_cast<std::uint32_t>(ConnectionMode::adhoc);
    const WlanInterface interface = wlanInterfaceFrom(raw);
    WIFIMETER_CHECK(!interface.ssid.has_value());
    WIFIMETER_CHECK(!isAssociated(interface));
}

void dropsSsidForDiscoverMode()
{
    RawWlanInterface raw = connected("WLAN", "Home", "Home");
    raw.connectionMode = static_cast<std::uint32_t>(ConnectionMode::discover);
    WIFIMETER_CHECK(!wlanInterfaceFrom(raw).ssid.has_value());
}

void keepsChineseIdentity()
{
    // 无线网卡 / 中文网卡 / 家庭网络 / 我的WIFI
    RawWlanInterface raw;
    raw.alias = utf16("无线网卡");
    raw.description = utf16("中文网卡");
    raw.connected = true;
    raw.connectionMode = static_cast<std::uint32_t>(ConnectionMode::profile);
    raw.profileName = utf16("家庭网络");
    raw.ssid = utf16("我的WIFI");
    raw.hasSsid = true;

    const WlanInterface interface = wlanInterfaceFrom(raw);
    WIFIMETER_CHECK_EQ(interface.interfaceId, std::string("\xE6\x97\xA0\xE7\xBA\xBF\xE7\xBD\x91\xE5\x8D\xA1"));
    WIFIMETER_CHECK_EQ(interface.adapterAlias, std::string("\xE4\xB8\xAD\xE6\x96\x87\xE7\xBD\x91\xE5\x8D\xA1"));
    WIFIMETER_CHECK_EQ(interface.profileName, std::string("\xE5\xAE\xB6\xE5\xBA\xAD\xE7\xBD\x91\xE7\xBB\x9C"));
    WIFIMETER_CHECK_EQ(interface.ssid.value_or(""), std::string("\xE6\x88\x91\xE7\x9A\x84WIFI"));
    // 没有信号数据时不编造数值。
    WIFIMETER_CHECK(!interface.signalPercent.has_value());
}

void keepsEmojiSsid()
{
    // U+1F4F6（📶）在 UTF-16 里是一对代理项，转换后应还原成 4 字节的 UTF-8。
    RawWlanInterface raw;
    raw.alias = utf16("WLAN");
    raw.connected = true;
    raw.connectionMode = static_cast<std::uint32_t>(ConnectionMode::profile);
    raw.ssid = utf16("Cafe \xF0\x9F\x93\xB6");
    raw.hasSsid = true;
    WIFIMETER_CHECK_EQ(wlanInterfaceFrom(raw).ssid.value_or(""), std::string("Cafe \xF0\x9F\x93\xB6"));
}

void rejectsOutOfRangeSignal()
{
    RawWlanInterface raw = connected("WLAN", "Home", "Home");
    raw.signalQuality = 101;
    WIFIMETER_CHECK(!wlanInterfaceFrom(raw).signalPercent.has_value());

    raw.signalQuality = 0;
    WIFIMETER_CHECK_EQ(wlanInterfaceFrom(raw).signalPercent.value_or(-1), 0);
}

void fallsBackToAliasForDisplayName()
{
    RawWlanInterface raw = connected("WLAN", "Home", "Home");
    raw.description.clear();
    WIFIMETER_CHECK_EQ(wlanInterfaceFrom(raw).adapterAlias, std::string("WLAN"));
}

void keepsOrderAndFindsByName()
{
    const std::vector<WlanInterface> interfaces = wlanInterfacesFrom({connected("WLAN", "Home", "P1"), connected("WLAN 2", "Office", "P2")});
    WIFIMETER_CHECK_EQ(interfaces.size(), std::size_t(2));
    WIFIMETER_CHECK_EQ(interfaces[1].interfaceId, std::string("WLAN 2"));
    const WlanInterface* found = findWlanInterface(interfaces, "WLAN 2");
    WIFIMETER_CHECK(found != nullptr);
    if (found != nullptr)
        WIFIMETER_CHECK_EQ(found->ssid.value_or(""), std::string("Office"));
    WIFIMETER_CHECK(findWlanInterface(interfaces, "WLAN 3") == nullptr);
}

void handlesEmptyInput()
{
    WIFIMETER_CHECK(wlanInterfacesFrom({}).empty());
    WIFIMETER_CHECK(findWlanInterface({}, "WLAN") == nullptr);
}

}  // namespace

int main()
{
    classifiesConnectionModes();
    requiresConnectedProfileWithSsid();
    convertsConnectedInterface();
    dropsSsidWhenNotAssociated();
    dropsSsidForAdHoc();
    dropsSsidForDiscoverMode();
    keepsChineseIdentity();
    keepsEmojiSsid();
    rejectsOutOfRangeSignal();
    fallsBackToAliasForDisplayName();
    keepsOrderAndFindsByName();
    handlesEmptyInput();
    return WIFIMETER_REPORT();
}
