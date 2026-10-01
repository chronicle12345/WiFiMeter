#include "../platform/windows/app_network_event.h"
#include "test_support.h"

#include <vector>

using namespace wifimeter::platform::windows;

int main()
{
    for (const auto protocol : {AppNetworkProtocol::tcp, AppNetworkProtocol::udp})
    {
        for (const bool ipv6 : {false, true})
        {
            const std::size_t addressSize = ipv6 ? 16 : 4;
            std::vector<std::uint8_t> payload(8 + 2 * addressSize + 4, 0);
            payload[0] = 0x78; payload[1] = 0x56; payload[2] = 0x34; payload[3] = 0x12;
            payload[4] = 0xff; payload[5] = 0xff; payload[6] = 0xff; payload[7] = 0xff;
            for (std::size_t byte = 0; byte < addressSize; ++byte)
            {
                payload[8 + byte] = static_cast<std::uint8_t>(byte + 1);
                payload[8 + addressSize + byte] = static_cast<std::uint8_t>(byte + 17);
            }
            for (const bool receive : {false, true})
            {
                const auto opcode = static_cast<std::uint8_t>((ipv6 ? 26 : 10) + (receive ? 1 : 0));
                const auto parsed = parseAppNetworkEvent(protocol, opcode, 2, payload);
                WIFIMETER_CHECK(parsed.state == AppNetworkEventState::packet);
                WIFIMETER_CHECK(parsed.packet.has_value());
                if (parsed.packet)
                {
                    WIFIMETER_CHECK_EQ(parsed.packet->processId, std::uint32_t{0x12345678});
                    WIFIMETER_CHECK_EQ(parsed.packet->bytes, std::uint32_t{0xffffffff});
                    WIFIMETER_CHECK_EQ(parsed.packet->receive, receive);
                    WIFIMETER_CHECK_EQ(parsed.packet->ipv6, ipv6);
                    for (std::size_t byte = 0; byte < addressSize; ++byte)
                    {
                        WIFIMETER_CHECK_EQ(parsed.packet->destinationAddress[byte], static_cast<std::uint8_t>(byte + 1));
                        WIFIMETER_CHECK_EQ(parsed.packet->sourceAddress[byte], static_cast<std::uint8_t>(byte + 17));
                    }
                }
                WIFIMETER_CHECK(parseAppNetworkEvent(protocol, opcode, 3, payload).state == AppNetworkEventState::unsupported);
                WIFIMETER_CHECK(parseAppNetworkEvent(protocol, opcode, 2, std::span(payload).first(payload.size() - 1)).state == AppNetworkEventState::malformed);
            }
            const auto retransmit = static_cast<std::uint8_t>(ipv6 ? 30 : 14);
            const auto repeated = parseAppNetworkEvent(protocol, retransmit, 2, payload);
            WIFIMETER_CHECK(repeated.state == (protocol == AppNetworkProtocol::tcp ? AppNetworkEventState::packet : AppNetworkEventState::ignored));
            if (repeated.packet)
                WIFIMETER_CHECK(!repeated.packet->receive);
        }
    }
    // Connect、Reconnect、Fail、TCPCopy 不应被当作流量，避免重复统计。
    for (const std::uint8_t opcode : {12, 15, 16, 17, 18, 28, 31, 32, 34})
        WIFIMETER_CHECK(parseAppNetworkEvent(AppNetworkProtocol::tcp, opcode, 2, {}).state == AppNetworkEventState::ignored);
    return WIFIMETER_REPORT();
}
