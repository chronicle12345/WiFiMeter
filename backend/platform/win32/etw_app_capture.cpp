#include "etw_app_capture.h"

#include <winsock2.h>
#include <ws2ipdef.h>
#include <windows.h>
#include <evntrace.h>
#include <evntcons.h>
#include <iphlpapi.h>
#include <netioapi.h>
#include <objbase.h>

#include <atomic>
#include <algorithm>
#include <cstddef>
#include <cstring>
#include <filesystem>
#include <limits>
#include <map>
#include <mutex>
#include <thread>
#include <tuple>

#include "../windows/app_network_event.h"
#include "../windows/text_convert.h"

namespace wifimeter::platform::windows
{
namespace
{
constexpr GUID tcpGuid{0x9a280ac0, 0xc8e0, 0x11d1, {0x84, 0xe2, 0x00, 0xc0, 0x4f, 0xb9, 0x98, 0xa2}};
constexpr GUID udpGuid{0xbf3a50c5, 0xa9c9, 0x4988, {0xa0, 0x05, 0x2d, 0xf0, 0xb7, 0xc8, 0x0f, 0x80}};

AppTrafficReport failed(ULONG code, const std::string& context)
{
    return {code == ERROR_ACCESS_DENIED || code == ERROR_PRIVILEGE_NOT_HELD ? AppCollectorState::permission : AppCollectorState::unavailable,
        {}, context + "，错误码 " + std::to_string(code), {}};
}

std::string utf8(const std::wstring& text)
{
    return toUtf8(std::u16string_view(reinterpret_cast<const char16_t*>(text.data()), text.size()));
}

std::uint64_t fileTime(const FILETIME& time)
{
    return (std::uint64_t(time.dwHighDateTime) << 32) | time.dwLowDateTime;
}

struct Address
{
    bool ipv6 = false;
    std::array<std::uint8_t, 16> bytes{};
    bool operator<(const Address& other) const { return std::tie(ipv6, bytes) < std::tie(other.ipv6, other.bytes); }
};

struct Process
{
    HANDLE handle = nullptr;
    std::uint64_t started = 0;
    std::string appId = "unknown";
    std::string name = "未识别应用";
    ~Process() { if (handle) ::CloseHandle(handle); }
};

struct Properties
{
    EVENT_TRACE_PROPERTIES value{};
    wchar_t name[1024]{};
};
}  // namespace

class EtwAppCapture::Impl
{
public:
    ~Impl() { stop(); }

    AppTrafficReport start()
    {
        stop();
        if (FAILED(::CoCreateGuid(&guid_)))
            return failed(ERROR_GEN_FAILURE, "生成应用采集会话标识失败");
        wchar_t guidText[40]{};
        if (!::StringFromGUID2(guid_, guidText, 40))
            return failed(ERROR_GEN_FAILURE, "生成应用采集会话名称失败");
        name_ = std::wstring(L"WiFiMeter.Apps.") + guidText;
        generation_ = utf8(name_);
        refreshAddresses();
        auto properties = configuration();
        properties.value.Wnode.ClientContext = 1;
        properties.value.BufferSize = 64;
        properties.value.MinimumBuffers = 4;
        properties.value.MaximumBuffers = 64;
        properties.value.FlushTimer = 1;
        properties.value.LogFileMode = EVENT_TRACE_SYSTEM_LOGGER_MODE | EVENT_TRACE_REAL_TIME_MODE;
        properties.value.EnableFlags = EVENT_TRACE_FLAG_NETWORK_TCPIP;
        const auto started = ::StartTraceW(&session_, name_.c_str(), &properties.value);
        if (started != ERROR_SUCCESS)
        {
            session_ = 0;
            return failed(started, "启动应用流量 ETW 会话失败");
        }
        EVENT_TRACE_LOGFILEW logfile{};
        logfile.LoggerName = name_.data();
        logfile.ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
        logfile.EventRecordCallback = &event;
        logfile.Context = this;
        consumer_ = ::OpenTraceW(&logfile);
        if (consumer_ == INVALID_PROCESSTRACE_HANDLE)
        {
            const auto error = ::GetLastError();
            stop();
            return failed(error, "打开应用流量 ETW 消费者失败");
        }
        stopping_ = false;
        consumerCode_ = ERROR_SUCCESS;
        finished_ = false;
        worker_ = std::thread([this, handle = consumer_]() mutable {
            const auto code = ::ProcessTrace(&handle, 1, nullptr, nullptr);
            consumerCode_ = code;
            finished_ = true;
        });
        return {AppCollectorState::running, generation_, {}, {}};
    }

    void stop()
    {
        stopping_ = true;
        if (session_)
        {
            auto properties = configuration();
            ::ControlTraceW(session_, nullptr, &properties.value, EVENT_TRACE_CONTROL_STOP);
            session_ = 0;
        }
        if (consumer_ != INVALID_PROCESSTRACE_HANDLE)
        {
            ::CloseTrace(consumer_);
            consumer_ = INVALID_PROCESSTRACE_HANDLE;
        }
        if (worker_.joinable())
            worker_.join();
        std::lock_guard lock(mutex_);
        processes_.clear();
        counters_.clear();
        addresses_.clear();
        missing_ = lastMissing_ = 0;
        lastLost_ = 0;
    }

    AppTrafficReport read()
    {
        if (!session_)
            return {};
        if (finished_)
            return failed(consumerCode_ == ERROR_SUCCESS ? ERROR_GEN_FAILURE : consumerCode_.load(), "应用流量 ETW 消费者已结束");
        refreshAddresses();
        auto properties = configuration();
        const auto queried = ::ControlTraceW(session_, nullptr, &properties.value, EVENT_TRACE_CONTROL_QUERY);
        if (queried != ERROR_SUCCESS)
            return failed(queried, "读取应用流量 ETW 状态失败");
        const std::uint64_t lost = std::uint64_t(properties.value.EventsLost) + properties.value.LogBuffersLost + properties.value.RealTimeBuffersLost;
        std::lock_guard lock(mutex_);
        AppTrafficReport report{AppCollectorState::running, generation_, {}, {}};
        report.samples.reserve(counters_.size());
        for (const auto& [key, value] : counters_)
        {
            auto sample = value;
            const auto process = processes_.find(sample.processId);
            sample.active = process != processes_.end() && process->second->handle &&
                ::WaitForSingleObject(process->second->handle, 0) == WAIT_TIMEOUT;
            if (!sample.active || sample.appId == "unknown")
                sample.processId = 0;
            report.samples.push_back(std::move(sample));
        }
        if (missing_ != lastMissing_ || lost != lastLost_)
        {
            report.state = AppCollectorState::partial;
            report.detail = "部分事件的进程、接口或格式不可读，或 ETW 丢失了事件。";
        }
        lastMissing_ = missing_;
        lastLost_ = lost;
        return report;
    }

private:
    Properties configuration() const
    {
        Properties result;
        result.value.Wnode.BufferSize = sizeof(result);
        result.value.Wnode.Flags = WNODE_FLAG_TRACED_GUID;
        result.value.Wnode.Guid = guid_;
        result.value.LoggerNameOffset = offsetof(Properties, name);
        std::copy(name_.begin(), name_.end(), result.name);
        return result;
    }

    void refreshAddresses()
    {
        MIB_UNICASTIPADDRESS_TABLE* table = nullptr;
        const auto code = ::GetUnicastIpAddressTable(AF_UNSPEC, &table);
        std::map<Address, std::string> addresses;
        if (code == NO_ERROR)
        {
            for (ULONG index = 0; index < table->NumEntries; ++index)
            {
                const auto& row = table->Table[index];
                Address address;
                if (row.Address.si_family == AF_INET)
                    std::memcpy(address.bytes.data(), &row.Address.Ipv4.sin_addr, 4);
                else if (row.Address.si_family == AF_INET6)
                {
                    address.ipv6 = true;
                    std::memcpy(address.bytes.data(), &row.Address.Ipv6.sin6_addr, 16);
                }
                else
                    continue;
                wchar_t alias[IF_MAX_STRING_SIZE + 1]{};
                const auto converted = ::ConvertInterfaceLuidToAlias(&row.InterfaceLuid, alias, IF_MAX_STRING_SIZE + 1);
                const auto name = converted == NO_ERROR ? utf8(alias) : "if" + std::to_string(row.InterfaceIndex);
                const auto found = addresses.find(address);
                if (found == addresses.end())
                    addresses.emplace(address, name);
                else if (found->second != name)
                    found->second.clear();  // 重复的 link-local 地址缺少 scope，不能猜网卡。
            }
            ::FreeMibTable(table);
        }
        std::lock_guard lock(mutex_);
        addresses_ = std::move(addresses);
        if (code != NO_ERROR)
            ++missing_;
    }

    static void WINAPI event(EVENT_RECORD* record)
    {
        auto* capture = static_cast<Impl*>(record->UserContext);
        if (!capture || capture->stopping_)
            return;
        AppNetworkProtocol protocol;
        if (::IsEqualGUID(record->EventHeader.ProviderId, tcpGuid))
            protocol = AppNetworkProtocol::tcp;
        else if (::IsEqualGUID(record->EventHeader.ProviderId, udpGuid))
            protocol = AppNetworkProtocol::udp;
        else
            return;
        const auto parsed = parseAppNetworkEvent(protocol, record->EventHeader.EventDescriptor.Opcode,
            record->EventHeader.EventDescriptor.Version, std::span(static_cast<const std::uint8_t*>(record->UserData), record->UserDataLength));
        if (parsed.state == AppNetworkEventState::ignored)
            return;
        std::lock_guard lock(capture->mutex_);
        if (!parsed.packet)
        {
            ++capture->missing_;
            return;
        }
        capture->count(*parsed.packet, static_cast<std::uint64_t>(record->EventHeader.TimeStamp.QuadPart));
    }

    Process& process(std::uint32_t pid)
    {
        const auto found = processes_.find(pid);
        if (found != processes_.end())
            return *found->second;
        auto identity = std::make_unique<Process>();
        identity->handle = ::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
        if (identity->handle)
        {
            FILETIME created{}, exited{}, kernel{}, user{};
            std::wstring path(32768, L'\0');
            DWORD length = static_cast<DWORD>(path.size());
            if (::GetProcessTimes(identity->handle, &created, &exited, &kernel, &user) &&
                ::QueryFullProcessImageNameW(identity->handle, 0, path.data(), &length))
            {
                path.resize(length);
                const auto appId = utf8(path);
                if (!appId.empty() && appId.size() <= 1024)
                {
                    identity->started = fileTime(created);
                    identity->appId = appId;
                    identity->name = utf8(std::filesystem::path(path).filename().wstring());
                    if (identity->name.empty() || identity->name.size() > 256)
                        identity->name = "应用";
                }
            }
        }
        return *processes_.emplace(pid, std::move(identity)).first->second;
    }

    void count(const AppNetworkPacket& packet, std::uint64_t timestamp)
    {
        if (!packet.bytes)
            return;
        // 用系统实际本机地址确认接口，不假定 ETW 连接端点的排列等同于包的收发方向。
        const auto source = addresses_.find(Address{packet.ipv6, packet.sourceAddress});
        const auto destination = addresses_.find(Address{packet.ipv6, packet.destinationAddress});
        const auto networkInterface = source != addresses_.end() ? source : destination;
        const bool ambiguous = source != addresses_.end() && destination != addresses_.end() && source->second != destination->second;
        if (networkInterface == addresses_.end() || networkInterface->second.empty() || ambiguous ||
            (processes_.size() >= 65536 && processes_.find(packet.processId) == processes_.end()))
        {
            ++missing_;
            return;
        }
        const auto& owner = process(packet.processId);
        const bool identified = owner.started && timestamp >= owner.started;
        const auto instance = std::to_string(packet.processId) + ":" + (identified ? std::to_string(owner.started) : "unknown");
        const auto key = std::make_pair(networkInterface->second, instance);
        auto found = counters_.find(key);
        if (found == counters_.end())
        {
            if (counters_.size() >= 65536)
            {
                ++missing_;
                return;
            }
            found = counters_.emplace(key, AppTrafficSample{networkInterface->second, identified ? owner.appId : "unknown",
                identified ? owner.name : "未识别应用", instance, identified ? packet.processId : 0, 0, 0, identified}).first;
        }
        auto& bytes = packet.receive ? found->second.rxBytes : found->second.txBytes;
        if (std::numeric_limits<std::uint64_t>::max() - bytes < packet.bytes)
        {
            ++missing_;
            return;
        }
        bytes += packet.bytes;
        if (!identified)
            ++missing_;
    }

    GUID guid_{};
    std::wstring name_;
    std::string generation_;
    TRACEHANDLE session_ = 0;
    TRACEHANDLE consumer_ = INVALID_PROCESSTRACE_HANDLE;
    std::thread worker_;
    std::atomic<bool> stopping_{true};
    std::atomic<bool> finished_{false};
    std::atomic<ULONG> consumerCode_{ERROR_SUCCESS};
    std::mutex mutex_;
    std::map<Address, std::string> addresses_;
    std::map<std::uint32_t, std::unique_ptr<Process>> processes_;
    std::map<std::pair<std::string, std::string>, AppTrafficSample> counters_;
    std::uint64_t missing_ = 0, lastMissing_ = 0, lastLost_ = 0;
};

EtwAppCapture::EtwAppCapture() : impl_(std::make_unique<Impl>()) {}
EtwAppCapture::~EtwAppCapture() = default;
AppTrafficReport EtwAppCapture::start() { return impl_->start(); }
AppTrafficReport EtwAppCapture::read() { return impl_->read(); }
void EtwAppCapture::stop() { impl_->stop(); }

}  // namespace wifimeter::platform::windows
