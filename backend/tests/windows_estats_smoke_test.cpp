#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <array>
#include <thread>
#include "../platform/win32/tcp_estats_capture.h"
#include "../platform/proxy_attribution.h"
#include "test_support.h"
using namespace wifimeter;
namespace
{
bool elevated()
{
    HANDLE token=nullptr; TOKEN_ELEVATION value{}; DWORD size=0;
    if (!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token)) return false;
    const bool result=GetTokenInformation(token,TokenElevation,&value,sizeof(value),&size) && value.TokenIsElevated;
    CloseHandle(token);return result;
}
struct Socket { SOCKET value=INVALID_SOCKET; ~Socket(){if(value!=INVALID_SOCKET)closesocket(value);} };
void exercise(bool v6)
{
    const int family=v6?AF_INET6:AF_INET;
    Socket listener{socket(family,SOCK_STREAM,IPPROTO_TCP)},client{socket(family,SOCK_STREAM,IPPROTO_TCP)};
    sockaddr_storage endpoint{};int size=v6?sizeof(sockaddr_in6):sizeof(sockaddr_in);
    if(v6) {auto& a=reinterpret_cast<sockaddr_in6&>(endpoint);a.sin6_family=AF_INET6;a.sin6_addr=in6addr_loopback;}
    else {auto& a=reinterpret_cast<sockaddr_in&>(endpoint);a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);}
    WIFIMETER_CHECK(bind(listener.value,reinterpret_cast<sockaddr*>(&endpoint),size)==0);
    WIFIMETER_CHECK(listen(listener.value,1)==0);
    WIFIMETER_CHECK(getsockname(listener.value,reinterpret_cast<sockaddr*>(&endpoint),&size)==0);
    WIFIMETER_CHECK(connect(client.value,reinterpret_cast<sockaddr*>(&endpoint),size)==0);
    Socket server{accept(listener.value,nullptr,nullptr)};
    if(server.value==INVALID_SOCKET) {WIFIMETER_CHECK(false);return;}
    DWORD timeout=3000;
    for(auto s:{client.value,server.value}) {setsockopt(s,SOL_SOCKET,SO_RCVTIMEO,reinterpret_cast<const char*>(&timeout),sizeof(timeout));setsockopt(s,SOL_SOCKET,SO_SNDTIMEO,reinterpret_cast<const char*>(&timeout),sizeof(timeout));}
    sockaddr_storage local{};int localSize=sizeof(local);getsockname(client.value,reinterpret_cast<sockaddr*>(&local),&localSize);
    platform::ProxyTcpConnection connection;
    connection.localAddress=connection.remoteAddress=v6?"::1":"127.0.0.1";
    connection.localPort=ntohs(v6?reinterpret_cast<sockaddr_in6&>(local).sin6_port:reinterpret_cast<sockaddr_in&>(local).sin_port);
    connection.remotePort=ntohs(v6?reinterpret_cast<sockaddr_in6&>(endpoint).sin6_port:reinterpret_cast<sockaddr_in&>(endpoint).sin_port);
    const auto key=platform::proxyConnectionKey(connection);
    platform::windows::TcpEStatsCapture capture;
    auto before=capture.read();
    auto find=[&](const auto& report)->const platform::AppTrafficSample* {for(const auto& row:report.samples) if(row.connectionKey==key && row.processId==GetCurrentProcessId())return &row;return nullptr;};
    const auto* first=find(before);
    if(!first) {std::fprintf(stderr,"EStats initial: %s\n",platform::serializeAppTrafficReport(before).c_str());WIFIMETER_CHECK(first);return;}
    std::array<char,4096> bytes{};
    auto transfer=[&](SOCKET from,SOCKET to,int times) {
        for(int i=0;i<times;++i) {
            int sent=0;while(sent<4096){const auto n=send(from,bytes.data()+sent,4096-sent,0);if(n<=0){WIFIMETER_CHECK(false);return;}sent+=n;}
            int received=0;while(received<4096){const auto n=recv(to,bytes.data()+received,4096-received,0);if(n<=0){WIFIMETER_CHECK(false);return;}received+=n;}
        }
    };
    transfer(client.value,server.value,16);transfer(server.value,client.value,8);
    platform::AppTrafficReport after;
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
    do {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));after=capture.read();
        if(const auto* row=find(after);row && row->txBytes>=65536 && row->rxBytes>=32768)break;
    }while(std::chrono::steady_clock::now()<deadline);
    const auto* measured=find(after);WIFIMETER_CHECK(measured);
    if(measured) {
        std::fprintf(stdout,"IPv%d client PID %lu: rx=%llu tx=%llu source=WindowsTcpEStats\n",v6?6:4,GetCurrentProcessId(),static_cast<unsigned long long>(measured->rxBytes),static_cast<unsigned long long>(measured->txBytes));
        // DataBytesIn/Out include retransmitted data, so payload sizes are lower bounds.
        // https://learn.microsoft.com/windows/win32/api/tcpestats/ns-tcpestats-tcp_estats_data_rod_v0
        WIFIMETER_CHECK(measured->txBytes>=std::uint64_t(65536));WIFIMETER_CHECK(measured->rxBytes>=std::uint64_t(32768));
        WIFIMETER_CHECK_EQ(measured->appId,first->appId);WIFIMETER_CHECK(!measured->instanceId.empty());
    }
}
}
int main()
{
    if(!elevated()) {std::puts("SKIP: TCP EStats enable requires an elevated token; no UAC requested.");return 77;}
    WSADATA data{};if(WSAStartup(MAKEWORD(2,2),&data)!=0)return 1;
    exercise(false);exercise(true);WSACleanup();return WIFIMETER_REPORT();
}
