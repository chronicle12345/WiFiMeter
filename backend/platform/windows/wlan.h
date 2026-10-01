#pragma once

// Windows 无线接口的状态与身份来源。
//
// 与 Linux 上分开查“设备列表”和“扫描结果”不同，Windows 的 WLAN API 一次调用
// （WlanQueryInterface(wlan_intf_opcode_current_connection)）就能同时给出：
//
//   * 连接状态（wlan_interface_state_connected 位与 WLAN_CONNECTION_MODE），据此判断
//     网卡是否关联到网络；
//   * 关联的配置名（strProfileName）；
//   * 当前 SSID（dot11Ssid），用户认得的网络名；
//   * 接收信号强度（wlanSignalQuality），0..100。
//
// 配置名不是网络键：Windows 的配置名由用户或系统命名，可以含空格、中文与冒号，
// 不满足快照 network.id 的 ^[-a-zA-Z0-9_]+$。这里如实报告 profileName 并留空
// profileUuid，由 core/network_key 统一退回按 SSID 散列取键，平台层不自己编造键。
//
// SSID 与配置名都是用户数据（可能含中文），一律按 UTF-8 处理，不做本地化匹配。
// 频段不在这里：Win32 不通过 WLAN API 报告当前信道，因此留空由上层展示为“未知”，
// 而不是从信号强度之类的数据猜测。
//
// 本文件只做“系统事实 → 平台结构”的转换，不调用任何 Windows API，便于用构造数据测试。

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace wifimeter::platform::windows
{

// WLAN_CONNECTION_MODE 的取值，顺序与 Windows SDK 的 wlanapi.h 完全一致。
//
// 两个容易搞错、又直接影响“能不能采到流量”的取值：
//
//   * discovery_secure / discovery_unsecure 是网卡正在扫描，尚未连接；
//   * auto 是“自动连接到首选网络”，也就是正常的已连接状态——实测家用笔记本上
//     大多是它。曾经按 0..3 猜测这套枚举，把 4 当成未知，结果在真机上永远采不到
//     样本（网卡明明连着，却被判定为未关联）。
enum class ConnectionMode : std::uint32_t
{
    profile = 0,            // 按保存的配置连接
    temporaryProfile = 1,   // 临时配置（一次性连接）
    discoverySecure = 2,    // 仅扫描（安全网络）
    discoveryUnsecure = 3,  // 仅扫描（开放网络）
    automatic = 4,          // 自动连接到首选网络：已连接
    invalid = 5,
};

ConnectionMode connectionModeFrom(std::uint32_t value);

// 该连接模式是否代表“连接在某个网络上”。
// 只有扫描态不是；invalid 视为未知，按保守处理（不算已连接）。
bool isConnectedMode(ConnectionMode mode);

// 信道号 → 频率（MHz）。无法确定时返回空值。
//
// 为什么不直接问系统：WLAN API 只给信道号（wlan_intf_opcode_channel_number），
// 而且并非所有驱动都支持。频率再交给 platform/network_platform.h 的 classifyBand
// 归类，与 Linux 侧用同一套频段边界。
std::optional<int> frequencyFromChannel(int channel);

struct WlanInterface
{
    std::string interfaceId;      // 网卡名称（适配器别名），与计数使用同一个键
    std::string adapterAlias;     // 展示名称，取不到更好的名称时等于 interfaceId
    std::string description;      // 驱动报告的网卡描述
    bool connected = false;       // wlan_interface_state_connected 位
    ConnectionMode mode = ConnectionMode::discoverySecure;
    std::string profileName;              // 关联的配置名
    std::optional<std::string> ssid;      // 已关联时的网络名
    std::optional<int> signalPercent;     // 0..100
    std::optional<int> frequencyMhz;      // 当前信道对应的频率；驱动不支持时为空
};

// 从原始字段判断是否关联：状态位为已连接、连接模式确实是已连接、并且读到了 SSID。
bool isAssociatedState(bool connected, ConnectionMode mode, std::string_view ssid);

// 接口是否代表“关联在某个网络上”。
bool isAssociated(const WlanInterface& link);

// 驱动描述优先，为空时退回网卡名称。
std::string adapterAliasFrom(std::string_view description, std::string_view interfaceId);

// 系统调用的原始结果：字符串按 UTF-16 码元承载，避免平台层依赖 Win32 类型。
struct RawWlanInterface
{
    std::u16string alias;
    std::u16string description;
    bool connected = false;
    std::uint32_t connectionMode = static_cast<std::uint32_t>(ConnectionMode::discoverySecure);
    std::u16string profileName;
    // SSID 在系统里是原始字节串（DOT11_SSID.ucSSID），因此这里也是字节串。
    // 用 u16string 承载它会把相邻两个字节当成一个码元，实测会把 "CMCC-mKm3-5G"
    // 变成一串乱码，因此单独用 string。
    std::string ssid;
    bool hasSsid = false;
    std::uint32_t signalQuality = 0;
    bool hasSignal = false;
    // 当前信道；驱动不支持该查询时为 0（不当成错误）。
    std::uint32_t channel = 0;
};

// 把系统取到的接口转换成平台结构。
// SSID 只在“关联状态”下保留：未关联的网卡即使残留着上一次的 SSID 也不能算作身份。
// 信号强度按 0..100 截断；系统报告超出范围时宁可丢弃也不上报可疑数值。
WlanInterface wlanInterfaceFrom(const RawWlanInterface& raw);

// 批量转换，保持系统给出的顺序。
std::vector<WlanInterface> wlanInterfacesFrom(const std::vector<RawWlanInterface>& raw);

// 按网卡名称查找，找不到返回空值。
const WlanInterface* findWlanInterface(const std::vector<WlanInterface>& interfaces, std::string_view interfaceId);

}  // namespace wifimeter::platform::windows
