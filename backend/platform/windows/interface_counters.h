#pragma once

// 网卡累计字节数：Windows 上对应 IP Helper 的 MIB_IF_ROW2.InOctets / OutOctets。
//
// 与 Linux 的 /proc/net/dev 一样，这里是单调累加的计数器而不是速率；差值计算、计数器
// 回绕（网卡重连或驱动重置后计数会归零）与累计有效性由 core/usage_accumulator 判断，
// 平台层只负责如实报告当前读到的数值。
//
// 原始结构里的字符串用 std::u16string 而不是 std::wstring：wchar_t 在 Windows 上是
// 16 位、在 Linux 上是 32 位，用 u16string 才能让这些转换函数在开发机上原样编译与测试
// （见 wlanapi_query.h 中把系统结果搬过来的方式）。

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "../network_platform.h"

namespace wifimeter::platform::windows
{

struct InterfaceCounters
{
    std::string interfaceId;  // 网卡名称（IF_ROW2.Alias），例如 "WLAN"
    std::uint64_t rxBytes = 0;
    std::uint64_t txBytes = 0;
};

// 与 MIB_IF_ROW2 同形的中间结构：便于把系统调用与转换分开测试。
struct RawInterfaceRow
{
    std::u16string alias;  // 网卡名称
    std::u16string description;
    std::size_t index = 0;  // 接口索引，名称缺失时作为兜底标识
    std::uint32_t type = 0;  // IANA 接口类型：71 为 IEEE 802.11 无线
    std::uint64_t rxBytes = 0;
    std::uint64_t txBytes = 0;
    std::string guid;       // 规范化 GUID，不随别名或接口索引改变
    bool hardware = false;
    bool up = false;
};

// IF_TYPE_IEEE80211：无线网卡的 IANA 类型编号。
inline constexpr std::uint32_t kIeee80211InterfaceType = 71;

// 把 UTF-16 的网卡名称转成接口标识（UTF-8）；名称为空时退回接口索引。
std::string toInterfaceId(std::u16string_view alias, std::size_t index);

// 把系统取到的行转换成计数列表。
std::vector<InterfaceCounters> countersFromRows(const std::vector<RawInterfaceRow>& rows);

// 只保留无线网卡，再转成计数列表。
std::vector<InterfaceCounters> wifiCountersFromRows(const std::vector<RawInterfaceRow>& rows);

// 排除虚拟接口，只保留物理 Ethernet（含未连接状态）。
std::vector<WifiLink> ethernetLinksFromRows(const std::vector<RawInterfaceRow>& rows);

// 按接口标识查找累计字节数，找不到返回空值。
std::optional<InterfaceCounters> findInterfaceCounters(const std::vector<InterfaceCounters>& counters, std::string_view interfaceId);

}  // namespace wifimeter::platform::windows
