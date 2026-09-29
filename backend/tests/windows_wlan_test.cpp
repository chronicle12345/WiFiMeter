// WLAN 状态转换测试：用构造的系统结果验证“是否关联”“身份字段”“信号强度”的判定。
//
// 这里的枚举取值与 SSID 的表示方式都照着真实机器的实测结果写：
//
//   * WLAN_CONNECTION_MODE 的顺序来自 Windows SDK（0 profile、1 temporary、2/3 discovery、
//     4 auto）。曾经按猜测写成 0/1/2/3，把 auto 当成未知，真机上因此永远采不到样本；
//   * SSID 是原始字节串，不是 UTF-16 码元；按码元读会把 "CMCC-mKm3-5G" 变成乱码。

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
    raw.ssid = ssid;  // 原始字节串
    raw.hasSsid = true;
    raw.signalQuality = 72;
    raw.hasSignal = true;
    return raw;
}

void classifiesConnectionModes()
{
    // 与 Windows SDK 的枚举顺序逐项对应。
    WIFIMETER_CHECK(connectionModeFrom(0) == ConnectionMode::profile);
    WIFIMETER_CHECK(connectionModeFrom(1) == ConnectionMode::temporaryProfile);
    WIFIMETER_CHECK(connectionModeFrom(2) == ConnectionMode::discoverySecure);
    WIFIMETER_CHECK(connectionModeFrom(3) == ConnectionMode::discoveryUnsecure);
    WIFIMETER_CHECK(connectionModeFrom(4) == ConnectionMode::automatic);
    WIFIMETER_CHECK(connectionModeFrom(5) == ConnectionMode::invalid);
    // 未来版本新增的取值按无效处理，而不是猜成已连接。
    WIFIMETER_CHECK(connectionModeFrom(99) == ConnectionMode::invalid);
}

void treatsAutoAndProfileModesAsConnected()
{
    WIFIMETER_CHECK(isConnectedMode(ConnectionMode::profile));
    WIFIMETER_CHECK(isConnectedMode(ConnectionMode::temporaryProfile));
    // 自动连接到首选网络是最常见的已连接状态（实测家用笔记本就是它）。
    WIFIMETER_CHECK(isConnectedMode(ConnectionMode::automatic));
    // 扫描中的两种取值都不是已连接。
    WIFIMETER_CHECK(!isConnectedMode(ConnectionMode::discoverySecure));
    WIFIMETER_CHECK(!isConnectedMode(ConnectionMode::discoveryUnsecure));
    // 未知取值保守处理：没有身份就不归属流量。
    WIFIMETER_CHECK(!isConnectedMode(ConnectionMode::invalid));
}

void requiresConnectedModeWithSsid()
{
    WIFIMETER_CHECK(isAssociatedState(true, ConnectionMode::profile, "Home"));
    WIFIMETER_CHECK(!isAssociatedState(false, ConnectionMode::profile, "Home"));
    WIFIMETER_CHECK(!isAssociatedState(true, ConnectionMode::discoverySecure, "Home"));
    WIFIMETER_CHECK(!isAssociatedState(true, ConnectionMode::discoveryUnsecure, "Home"));
    WIFIMETER_CHECK(!isAssociatedState(true, ConnectionMode::invalid, "Home"));
    // 状态位说已连接但拿不到 SSID：身份不可靠，不产生样本。
    WIFIMETER_CHECK(!isAssociatedState(true, ConnectionMode::profile, ""));
    // auto 模式同样是已关联——这是真机上最容易漏掉的一条。
    WIFIMETER_CHECK(isAssociatedState(true, ConnectionMode::automatic, "Home"));
}

void convertsConnectedInterface()
{
    const WlanInterface link = wlanInterfaceFrom(connected("WLAN", "Home 5G", "Home Profile"));
    WIFIMETER_CHECK_EQ(link.interfaceId, std::string("WLAN"));
    WIFIMETER_CHECK_EQ(link.adapterAlias, std::string("Intel(R) Wi-Fi 6 AX201 160MHz"));
    WIFIMETER_CHECK_EQ(link.profileName, std::string("Home Profile"));
    WIFIMETER_CHECK(link.ssid.has_value());
    WIFIMETER_CHECK_EQ(link.ssid.value_or(""), std::string("Home 5G"));
    WIFIMETER_CHECK(link.signalPercent.has_value());
    WIFIMETER_CHECK_EQ(link.signalPercent.value_or(-1), 72);
    WIFIMETER_CHECK(isAssociated(link));
}

void keepsSsidVerbatim()
{
    // 真机实测：SSID "CMCC-mKm3-5G" 必须原样保留，而不是被当成 UTF-16 码元读成乱码。
    const WlanInterface link = wlanInterfaceFrom(connected("WLAN", "CMCC-mKm3-5G", "CMCC-mKm3-5G"));
    WIFIMETER_CHECK_EQ(link.ssid.value_or(""), std::string("CMCC-mKm3-5G"));
    WIFIMETER_CHECK_EQ(link.ssid->size(), std::size_t(12));
}

void connectsInAutomaticMode()
{
    // 真机最常见的形态：状态位已连接、模式为 auto、带 SSID。
    RawWlanInterface raw = connected("WLAN", "CMCC-mKm3-5G", "CMCC-mKm3-5G");
    raw.connectionMode = static_cast<std::uint32_t>(ConnectionMode::automatic);
    const WlanInterface link = wlanInterfaceFrom(raw);
    WIFIMETER_CHECK(link.mode == ConnectionMode::automatic);
    WIFIMETER_CHECK(isAssociated(link));
    WIFIMETER_CHECK_EQ(link.ssid.value_or(""), std::string("CMCC-mKm3-5G"));
}

void dropsSsidWhenNotAssociated()
{
    RawWlanInterface raw = connected("WLAN", "Home 5G", "Home Profile");
    raw.connected = false;
    const WlanInterface link = wlanInterfaceFrom(raw);
    // 未关联时残留的 SSID 不能当作身份。
    WIFIMETER_CHECK(!link.ssid.has_value());
    WIFIMETER_CHECK(!isAssociated(link));
    // 信号强度仍可上报：它是网卡状态而不是身份。
    WIFIMETER_CHECK(link.signalPercent.has_value());
}

void dropsSsidWhileScanning()
{
    RawWlanInterface raw = connected("WLAN", "Direct-ABC", "Direct");
    raw.connectionMode = static_cast<std::uint32_t>(ConnectionMode::discoverySecure);
    WIFIMETER_CHECK(!wlanInterfaceFrom(raw).ssid.has_value());

    raw.connectionMode = static_cast<std::uint32_t>(ConnectionMode::discoveryUnsecure);
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
    raw.ssid = "我的WIFI";  // 原始字节串本来就是 UTF-8
    raw.hasSsid = true;

    const WlanInterface link = wlanInterfaceFrom(raw);
    WIFIMETER_CHECK_EQ(link.interfaceId, std::string("\xE6\x97\xA0\xE7\xBA\xBF\xE7\xBD\x91\xE5\x8D\xA1"));
    WIFIMETER_CHECK_EQ(link.adapterAlias, std::string("\xE4\xB8\xAD\xE6\x96\x87\xE7\xBD\x91\xE5\x8D\xA1"));
    WIFIMETER_CHECK_EQ(link.profileName, std::string("\xE5\xAE\xB6\xE5\xBA\xAD\xE7\xBD\x91\xE7\xBB\x9C"));
    WIFIMETER_CHECK_EQ(link.ssid.value_or(""), std::string("\xE6\x88\x91\xE7\x9A\x84WIFI"));
    // 没有信号数据时不编造数值。
    WIFIMETER_CHECK(!link.signalPercent.has_value());
}

void keepsEmojiSsid()
{
    // U+1F4F6（📶）在 UTF-8 里是 4 字节；字节串直接保留，不做码元转换。
    RawWlanInterface raw;
    raw.alias = utf16("WLAN");
    raw.connected = true;
    raw.connectionMode = static_cast<std::uint32_t>(ConnectionMode::profile);
    raw.ssid = "Cafe \xF0\x9F\x93\xB6";
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
    const std::vector<WlanInterface> links = wlanInterfacesFrom({connected("WLAN", "Home", "P1"), connected("WLAN 2", "Office", "P2")});
    WIFIMETER_CHECK_EQ(links.size(), std::size_t(2));
    WIFIMETER_CHECK_EQ(links[1].interfaceId, std::string("WLAN 2"));
    const WlanInterface* found = findWlanInterface(links, "WLAN 2");
    WIFIMETER_CHECK(found != nullptr);
    if (found != nullptr)
        WIFIMETER_CHECK_EQ(found->ssid.value_or(""), std::string("Office"));
    WIFIMETER_CHECK(findWlanInterface(links, "WLAN 3") == nullptr);
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
    treatsAutoAndProfileModesAsConnected();
    requiresConnectedModeWithSsid();
    convertsConnectedInterface();
    keepsSsidVerbatim();
    connectsInAutomaticMode();
    dropsSsidWhenNotAssociated();
    dropsSsidWhileScanning();
    keepsChineseIdentity();
    keepsEmojiSsid();
    rejectsOutOfRangeSignal();
    fallsBackToAliasForDisplayName();
    keepsOrderAndFindsByName();
    handlesEmptyInput();
    return WIFIMETER_REPORT();
}
