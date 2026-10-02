#include "tcp_estats_capture.h"
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#include <tcpestats.h>
#include <algorithm>
#include <array>
#include <cstring>
#include <filesystem>
#include <map>
#include <mutex>
#include <thread>
#include <condition_variable>
#include "../proxy_attribution.h"
#include "../windows/text_convert.h"

namespace wifimeter::platform::windows
{
namespace
{
bool elevated()
{
    HANDLE token=nullptr; TOKEN_ELEVATION value{}; DWORD size=0;
    if (!::OpenProcessToken(::GetCurrentProcess(),TOKEN_QUERY,&token)) return false;
    const bool result=::GetTokenInformation(token,TokenElevation,&value,sizeof(value),&size) && value.TokenIsElevated;
    ::CloseHandle(token); return result;
}
struct Socket
{
    bool v6 = false;
    MIB_TCPROW row{};
    MIB_TCP6ROW row6{};
    ProxyTcpConnection connection;
};
std::string address(const void* bytes, bool v6, DWORD scope = 0)
{
    char text[INET6_ADDRSTRLEN]{};
    if (!::InetNtopA(v6 ? AF_INET6 : AF_INET, bytes, text, sizeof(text))) return {};
    return std::string(text) + (scope ? "%" + std::to_string(scope) : "");
}
bool loopback(const unsigned char* bytes, bool v6)
{
    if (!v6) return bytes[0] == 127;
    if (!std::all_of(bytes,bytes+10,[](auto b){return b==0;})) return false;
    if (bytes[10]==255 && bytes[11]==255) return bytes[12]==127;
    return std::all_of(bytes+10,bytes+15,[](auto b){return b==0;}) && bytes[15]==1;
}
DWORD table(bool v6, std::vector<Socket>& sockets)
{
    DWORD size=0;
    auto code=::GetExtendedTcpTable(nullptr,&size,FALSE,v6?AF_INET6:AF_INET,TCP_TABLE_OWNER_PID_ALL,0);
    if (code==ERROR_NO_DATA || (code==NO_ERROR && !size)) return NO_ERROR;
    std::vector<unsigned char> data;
    for (int attempt=0; attempt<3 && code==ERROR_INSUFFICIENT_BUFFER; ++attempt)
    {
        data.resize(size);
        code=::GetExtendedTcpTable(data.data(),&size,FALSE,v6?AF_INET6:AF_INET,TCP_TABLE_OWNER_PID_ALL,0);
    }
    if (code!=NO_ERROR) return code;
    const auto offset=v6?offsetof(MIB_TCP6TABLE_OWNER_PID,table):offsetof(MIB_TCPTABLE_OWNER_PID,table);
    const auto stride=v6?sizeof(MIB_TCP6ROW_OWNER_PID):sizeof(MIB_TCPROW_OWNER_PID);
    DWORD count=0;
    if (size<offset || size>data.size()) return ERROR_INVALID_DATA;
    std::memcpy(&count,data.data(),sizeof(count));
    if (count>(size-offset)/stride) return ERROR_INVALID_DATA;
    for (DWORD i=0;i<count;++i)
    {
        Socket socket; socket.v6=v6;
        auto& connection=socket.connection;
        if (v6)
        {
            MIB_TCP6ROW_OWNER_PID row{}; std::memcpy(&row,data.data()+offset+i*stride,stride);
            if (row.dwState!=MIB_TCP_STATE_ESTAB || !loopback(row.ucRemoteAddr,true) || !loopback(row.ucLocalAddr,true)) continue;
            socket.row6.State=static_cast<MIB_TCP_STATE>(row.dwState);
            std::memcpy(socket.row6.LocalAddr.u.Byte,row.ucLocalAddr,16);
            std::memcpy(socket.row6.RemoteAddr.u.Byte,row.ucRemoteAddr,16);
            socket.row6.dwLocalScopeId=row.dwLocalScopeId; socket.row6.dwRemoteScopeId=row.dwRemoteScopeId;
            socket.row6.dwLocalPort=row.dwLocalPort; socket.row6.dwRemotePort=row.dwRemotePort;
            connection.processId=row.dwOwningPid;
            connection.localAddress=address(row.ucLocalAddr,true,row.dwLocalScopeId);
            connection.remoteAddress=address(row.ucRemoteAddr,true,row.dwRemoteScopeId);
            connection.localPort=ntohs(static_cast<u_short>(row.dwLocalPort)); connection.remotePort=ntohs(static_cast<u_short>(row.dwRemotePort));
        }
        else
        {
            MIB_TCPROW_OWNER_PID row{}; std::memcpy(&row,data.data()+offset+i*stride,stride);
            if (row.dwState!=MIB_TCP_STATE_ESTAB || !loopback(reinterpret_cast<unsigned char*>(&row.dwRemoteAddr),false) ||
                !loopback(reinterpret_cast<unsigned char*>(&row.dwLocalAddr),false)) continue;
            socket.row.dwState=row.dwState; socket.row.dwLocalAddr=row.dwLocalAddr; socket.row.dwRemoteAddr=row.dwRemoteAddr;
            socket.row.dwLocalPort=row.dwLocalPort; socket.row.dwRemotePort=row.dwRemotePort;
            connection.processId=row.dwOwningPid;
            connection.localAddress=address(&row.dwLocalAddr,false); connection.remoteAddress=address(&row.dwRemoteAddr,false);
            connection.localPort=ntohs(static_cast<u_short>(row.dwLocalPort)); connection.remotePort=ntohs(static_cast<u_short>(row.dwRemotePort));
        }
        sockets.push_back(std::move(socket));
    }
    return NO_ERROR;
}
DWORD readStats(Socket& socket, TCP_ESTATS_DATA_RW_v0& rw, TCP_ESTATS_DATA_ROD_v0& data)
{
    auto* r=reinterpret_cast<PUCHAR>(&rw); auto* d=reinterpret_cast<PUCHAR>(&data);
    return socket.v6 ? ::GetPerTcp6ConnectionEStats(&socket.row6,TcpConnectionEstatsData,r,0,sizeof(rw),nullptr,0,0,d,0,sizeof(data)) :
        ::GetPerTcpConnectionEStats(&socket.row,TcpConnectionEstatsData,r,0,sizeof(rw),nullptr,0,0,d,0,sizeof(data));
}
DWORD enable(Socket& socket)
{
    TCP_ESTATS_DATA_RW_v0 rw{TRUE};
    return socket.v6 ? ::SetPerTcp6ConnectionEStats(&socket.row6,TcpConnectionEstatsData,reinterpret_cast<PUCHAR>(&rw),0,sizeof(rw),0) :
        ::SetPerTcpConnectionEStats(&socket.row,TcpConnectionEstatsData,reinterpret_cast<PUCHAR>(&rw),0,sizeof(rw),0);
}
AppTrafficSample identity(DWORD pid)
{
    AppTrafficSample sample; sample.interfaceId="loopback"; sample.processId=pid;
    sample.source="WindowsTcpEStats";
    const auto handle=::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);
    if (!handle) return sample;
    FILETIME created{},exited{},kernel{},user{};
    std::wstring path(32768,L'\0'); DWORD size=static_cast<DWORD>(path.size());
    if (::GetProcessTimes(handle,&created,&exited,&kernel,&user) && ::QueryFullProcessImageNameW(handle,0,path.data(),&size))
    {
        path.resize(size);
        sample.appId=toUtf8(std::u16string_view(reinterpret_cast<const char16_t*>(path.data()),path.size()));
        const auto filename=std::filesystem::path(path).filename().wstring();
        sample.name=toUtf8(std::u16string_view(reinterpret_cast<const char16_t*>(filename.data()),filename.size()));
        sample.instanceId=std::to_string(pid)+":"+std::to_string((std::uint64_t(created.dwHighDateTime)<<32)|created.dwLowDateTime);
    }
    ::CloseHandle(handle);
    return sample;
}
}
class TcpEStatsCapture::Impl
{
public:
    struct Baseline { std::uint64_t rx,tx; AppTrafficSample sample; };
    std::map<std::string,Baseline> previous;
    std::uint64_t serial=0;
    std::string generation="estats:"+std::to_string(::GetCurrentProcessId())+":"+std::to_string(::GetTickCount64());
    std::mutex mutex;
    std::condition_variable changed;
    bool stopping=false;
    AppTrafficReport latest;
    std::thread worker;
    Impl()
    {
        latest=capture();
        worker=std::thread([this] {
            std::unique_lock lock(mutex);
            while (!changed.wait_for(lock,std::chrono::seconds(1),[this]{return stopping;}))
            {
                lock.unlock(); auto report=capture(); lock.lock(); latest=std::move(report);
            }
        });
    }
    ~Impl()
    {
        { std::lock_guard lock(mutex); stopping=true; }
        changed.notify_all();
        if (worker.joinable()) worker.join();
    }
    AppTrafficReport read() { std::lock_guard lock(mutex); return latest; }
    AppTrafficReport capture()
    {
        if (!elevated()) return {AppCollectorState::permission,generation,"TCP EStats requires administrator permission (error 5).",{}};
        std::vector<Socket> sockets;
        const auto v4=table(false,sockets),v6=table(true,sockets);
        DWORD error=v4?v4:v6;
        std::size_t failed=(v4!=0)+(v6!=0);
        std::map<DWORD,AppTrafficSample> identities;
        std::map<std::string,Baseline> next;
        AppTrafficReport report{AppCollectorState::running,generation,
            "TCP EStats loopback; polling may miss short connections and final bytes; excludes UDP/QUIC.",{}};
        for (auto& socket:sockets)
        {
            const auto pid=socket.connection.processId;
            if (!identities.count(pid)) identities[pid]=identity(pid);
            auto sample=identities[pid];
            if (sample.instanceId.empty() || sample.appId.empty()) { ++failed; continue; }
            TCP_ESTATS_DATA_RW_v0 rw{}; TCP_ESTATS_DATA_ROD_v0 data{};
            auto code=readStats(socket,rw,data);
            bool newlyEnabled=false;
            if (code==NO_ERROR && !rw.EnableCollection)
            {
                code=enable(socket); newlyEnabled=code==NO_ERROR;
                if (newlyEnabled) code=readStats(socket,rw,data);
            }
            if (code!=NO_ERROR || !rw.EnableCollection) { ++failed; error=code?code:ERROR_NOT_SUPPORTED; continue; }
            sample.connectionKey=proxyConnectionKey(socket.connection);
            const auto key=sample.instanceId+"|"+sample.connectionKey;
            const auto old=previous.find(key);
            if (old!=previous.end() && !newlyEnabled && data.DataBytesIn>=old->second.rx && data.DataBytesOut>=old->second.tx)
            {
                sample=old->second.sample;
                sample.rxBytes+=data.DataBytesIn-old->second.rx; sample.txBytes+=data.DataBytesOut-old->second.tx;
            }
            else sample.instanceId+=":"+std::to_string(++serial);
            next[key]={data.DataBytesIn,data.DataBytesOut,sample};
            report.samples.push_back(std::move(sample));
        }
        report.sampledAtMs = report.loopbackSampledAtMs = static_cast<std::int64_t>(::GetTickCount64());
        previous=std::move(next);
        if (failed)
        {
            report.state=report.samples.empty() ? (error==ERROR_ACCESS_DENIED?AppCollectorState::permission:AppCollectorState::unavailable) : AppCollectorState::partial;
            report.detail+=" Failed reads: "+std::to_string(failed)+"; error: "+std::to_string(error)+".";
        }
        return report;
    }
};
TcpEStatsCapture::TcpEStatsCapture():impl_(std::make_unique<Impl>()) {}
TcpEStatsCapture::~TcpEStatsCapture()=default;
AppTrafficReport TcpEStatsCapture::read() { return impl_->read(); }
// 不关闭全局 EStats 开关：其他消费者可能同时启用，连接关闭时由系统释放存储。
void TcpEStatsCapture::clear() { impl_=std::make_unique<Impl>(); }
}
