#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <span>

namespace wifimeter::platform::windows
{

enum class AppNetworkProtocol { tcp, udp };
enum class AppNetworkEventState { ignored, unsupported, malformed, packet };

struct AppNetworkPacket
{
    std::uint32_t processId = 0;
    std::uint32_t bytes = 0;
    bool receive = false;
    bool ipv6 = false;
    std::array<std::uint8_t, 16> sourceAddress{};
    std::array<std::uint8_t, 16> destinationAddress{};
};

struct AppNetworkEvent
{
    AppNetworkEventState state = AppNetworkEventState::ignored;
    std::optional<AppNetworkPacket> packet;
};

// TcpIp/UdpIp 的 v2 MOF 数据。PID 来自 payload，不能使用记录事件的线程 PID。
// 只读取固定前缀；connid 是指针大小字段，不参与字节或接口归属。
AppNetworkEvent parseAppNetworkEvent(AppNetworkProtocol protocol, std::uint8_t opcode,
    std::uint8_t version, std::span<const std::uint8_t> payload);

}  // namespace wifimeter::platform::windows
