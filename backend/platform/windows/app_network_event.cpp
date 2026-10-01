#include "app_network_event.h"

#include <algorithm>

namespace wifimeter::platform::windows
{

AppNetworkEvent parseAppNetworkEvent(AppNetworkProtocol protocol, std::uint8_t opcode,
    std::uint8_t version, std::span<const std::uint8_t> payload)
{
    const bool receive = opcode == 11 || opcode == 27;
    const bool send = opcode == 10 || opcode == 26;
    const bool retransmit = protocol == AppNetworkProtocol::tcp && (opcode == 14 || opcode == 30);
    if (!receive && !send && !retransmit)
        return {};
    if (version != 2)
        return {AppNetworkEventState::unsupported, {}};
    const bool ipv6 = opcode >= 26;
    const std::size_t addressSize = ipv6 ? 16 : 4;
    // PID、size、目的地址、源地址、两个端口。
    if (payload.size() < 8 + 2 * addressSize + 4)
        return {AppNetworkEventState::malformed, {}};
    const auto integer = [&](std::size_t offset) {
        return std::uint32_t(payload[offset]) | (std::uint32_t(payload[offset + 1]) << 8) |
            (std::uint32_t(payload[offset + 2]) << 16) | (std::uint32_t(payload[offset + 3]) << 24);
    };
    AppNetworkPacket packet;
    packet.processId = integer(0);
    packet.bytes = integer(4);
    packet.receive = receive;
    packet.ipv6 = ipv6;
    std::copy_n(payload.begin() + 8, addressSize, packet.destinationAddress.begin());
    std::copy_n(payload.begin() + 8 + addressSize, addressSize, packet.sourceAddress.begin());
    return {AppNetworkEventState::packet, packet};
}

}  // namespace wifimeter::platform::windows
