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

// WLAN_CONNECTION_MODE 的取值，数值与 wlanapi.h 一致。
enum class ConnectionMode : std::uint32_t
{
    profile = 0,   // 按配置连接（普通基础设施网络）
    adhoc = 1,     // 临时网络（计算机到计算机）
    discover = 2,  // 仅扫描，未连接
    unknown = 3,
};

ConnectionMode connectionModeFrom(std::uint32_t value);

struct WlanInterface
{
    std::string interfaceId;      // 网卡名称（适配器别名），与计数使用同一个键
    std::string adapterAlias;     // 展示名称，取不到更好的名称时等于 interfaceId
    std::string description;      // 驱动报告的网卡描述
    bool connected = false;       // wlan_interface_state_connected 位
    ConnectionMode mode = ConnectionMode::discover;
    std::string profileName;              // 关联的配置名
    std::optional<std::string> ssid;      // 已关联时的网络名
    std::optional<int> signalPercent;     // 0..100
};

// 从原始字段判断是否关联：已连接、按配置连接、并且确实读到了 SSID。
bool isAssociatedState(bool connected, ConnectionMode mode, std::string_view ssid);

// 接口是否代表“关联在某个网络上”。
// 仅扫描（discover）与临时网络（adhoc）也会报告连接模式，但不计入流量归属，
// 因此必须显式排除，而不是只看状态位。
//
// 形参不叫 interface：Windows 的 rpc.h 把 interface 定义成 struct 宏，
// 用了那个名字的头文件会连带把这里改写成语法错误。
bool isAssociated(const WlanInterface& link);

// 驱动描述优先，为空时退回网卡名称。
std::string adapterAliasFrom(std::string_view description, std::string_view interfaceId);

// 系统调用的原始结果：字符串按 UTF-16 码元承载，避免平台层依赖 Win32 类型。
struct RawWlanInterface
{
    std::u16string alias;
    std::u16string description;
    bool connected = false;
    std::uint32_t connectionMode = static_cast<std::uint32_t>(ConnectionMode::discover);
    std::u16string profileName;
    std::u16string ssid;  // 原始 SSID 字节，按 UTF-16 码元承载
    bool hasSsid = false;
    std::uint32_t signalQuality = 0;
    bool hasSignal = false;
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
