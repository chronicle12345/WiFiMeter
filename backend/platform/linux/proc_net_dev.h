#pragma once

// /proc/net/dev 的解析：每张网卡的累计接收/发送字节数。
// 内核格式稳定且与语言环境无关，是 Linux 上与 Windows IP 统计计数器对应的数据源。

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace wifimeter::platform::linux
{

struct InterfaceCounters
{
    std::string interfaceId;  // 内核接口名，例如 wlan0
    std::uint64_t rxBytes = 0;
    std::uint64_t txBytes = 0;
};

// 解析 /proc/net/dev 内容。
// 表头行、字段不足的行以及无法解析的计数都会被跳过；同一接口重复出现时以最后一行为准。
std::vector<InterfaceCounters> parseProcNetDev(std::string_view text);

// 读取计数文件，默认使用 /proc/net/dev；读取失败返回空列表。
std::vector<InterfaceCounters> readInterfaceCounters(const std::string& path = "/proc/net/dev");

// 按接口名查找累计字节数，找不到返回空值。
std::optional<InterfaceCounters> findInterfaceCounters(const std::vector<InterfaceCounters>& counters, std::string_view interfaceId);

}  // namespace wifimeter::platform::linux
