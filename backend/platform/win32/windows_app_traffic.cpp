#include "windows_app_traffic.h"

#include <winsock2.h>
#include <windows.h>
#include <objbase.h>
#include <sddl.h>
#include <shellapi.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

#include "../windows/text_convert.h"

namespace wifimeter::platform::windows
{
namespace
{
AppTrafficReport failure(DWORD code, const std::string& context)
{
    return {code == ERROR_ACCESS_DENIED || code == ERROR_PRIVILEGE_NOT_HELD || code == ERROR_CANCELLED
        ? AppCollectorState::permission : AppCollectorState::unavailable, {}, context + "，错误码 " + std::to_string(code), {}};
}

bool elevated()
{
    HANDLE token = nullptr;
    if (!::OpenProcessToken(::GetCurrentProcess(), TOKEN_QUERY, &token))
        return false;
    TOKEN_ELEVATION elevation{};
    DWORD size = 0;
    const bool result = ::GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size) && elevation.TokenIsElevated;
    ::CloseHandle(token);
    return result;
}

PSECURITY_DESCRIPTOR pipeSecurity()
{
    HANDLE token = nullptr;
    if (!::OpenProcessToken(::GetCurrentProcess(), TOKEN_QUERY, &token))
        return nullptr;
    DWORD size = 0;
    ::GetTokenInformation(token, TokenUser, nullptr, 0, &size);
    std::vector<std::uint8_t> data(size);
    const bool queried = ::GetTokenInformation(token, TokenUser, data.data(), size, &size) != FALSE;
    ::CloseHandle(token);
    if (!queried)
        return nullptr;
    LPWSTR sid = nullptr;
    if (!::ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid, &sid))
        return nullptr;
    // 普通调用者、管理员（含 UAC 使用其他管理员账户）及 SYSTEM。
    const auto sddl = std::wstring(L"D:P(A;;GA;;;") + sid + L")(A;;GA;;;BA)(A;;GA;;;SY)";
    ::LocalFree(sid);
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    if (!::ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr))
        return nullptr;
    return descriptor;
}
}  // namespace

class WindowsAppTrafficSource::Session
{
public:
    explicit Session(Options options) : options_(std::move(options)) {}
    ~Session()
    {
        stop();
        if (process_) ::CloseHandle(process_);
        if (stopped_) ::CloseHandle(stopped_);
    }

    void publish(AppTrafficReport report)
    {
        std::lock_guard lock(mutex_);
        report_ = std::move(report);
        ++revision_;
        changed_.notify_all();
    }

    bool prepare()
    {
        publish({AppCollectorState::starting, {}, {}, {}});
        stopped_ = ::CreateEventW(nullptr, TRUE, FALSE, nullptr);
        GUID guid{};
        wchar_t text[40]{};
        if (!stopped_ || FAILED(::CoCreateGuid(&guid)) || !::StringFromGUID2(guid, text, 40))
        {
            publish(failure(ERROR_GEN_FAILURE, "创建应用采集会话失败"));
            return false;
        }
        name_ = std::wstring(L"\\\\.\\pipe\\WiFiMeter.Apps.") + text;
        auto* descriptor = pipeSecurity();
        if (!descriptor)
        {
            publish(failure(::GetLastError(), "设置应用采集管道访问权限失败"));
            return false;
        }
        SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE};
        pipe_ = ::CreateNamedPipeW(name_.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 0, &security);
        const auto code = ::GetLastError();
        ::LocalFree(descriptor);
        if (pipe_ == INVALID_HANDLE_VALUE)
        {
            publish(failure(code, "创建应用采集管道失败"));
            return false;
        }
        worker_ = std::thread([this] { run(); });
        return true;
    }

    void launch()
    {
        const auto path = toUtf16(options_.helperPath);
        const auto parameters = std::wstring(L"--pipe \"") + name_ + L"\" --parent " + std::to_wstring(::GetCurrentProcessId());
        HANDLE process = nullptr;
        DWORD code = ERROR_SUCCESS;
        if (options_.authorize && !elevated())
        {
            const auto initialized = ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
            if (FAILED(initialized))
                code = ERROR_GEN_FAILURE;
            else
            {
                SHELLEXECUTEINFOW execute{};
                execute.cbSize = sizeof(execute);
                execute.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
                execute.lpVerb = L"runas";
                execute.lpFile = path.c_str();
                execute.lpParameters = parameters.c_str();
                execute.nShow = SW_HIDE;
                if (!::ShellExecuteExW(&execute))
                    code = ::GetLastError();
                else
                    process = execute.hProcess;
                ::CoUninitialize();
            }
        }
        else
        {
            auto command = L"\"" + path + L"\" " + parameters;
            STARTUPINFOW startup{};
            startup.cb = sizeof(startup);
            PROCESS_INFORMATION info{};
            if (!::CreateProcessW(path.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &info))
                code = ::GetLastError();
            else
            {
                ::CloseHandle(info.hThread);
                process = info.hProcess;
            }
        }
        if (!process && code == ERROR_SUCCESS)
            code = ERROR_INVALID_HANDLE;
        std::lock_guard lock(mutex_);
        process_ = process;
        launchCode_ = code;
        launched_ = true;
        changed_.notify_all();
    }

    void stop()
    {
        if (stopped_) ::SetEvent(stopped_);
        if (worker_.joinable()) worker_.join();
        // 不等待 UAC 窗口。晚到的 helper 会因管道关闭而在创建 ETW 会话前退出。
    }

    AppTrafficReport read()
    {
        std::unique_lock lock(mutex_);
        const auto revision = revision_;
        requested_ = true;
        changed_.wait_for(lock, std::chrono::milliseconds(100), [&] { return revision_ != revision; });
        return report_;
    }

private:
    bool cancelled() const { return ::WaitForSingleObject(stopped_, 0) == WAIT_OBJECT_0; }

    bool ready(OVERLAPPED& operation)
    {
        HANDLE events[]{stopped_, operation.hEvent};
        while (::WaitForMultipleObjects(2, events, FALSE, 50) == WAIT_TIMEOUT)
        {
            std::lock_guard lock(mutex_);
            if (launched_ && (launchCode_ != ERROR_SUCCESS || ::WaitForSingleObject(process_, 0) == WAIT_OBJECT_0))
            {
                publishUnlocked(failure(launchCode_ ? launchCode_ : ERROR_BROKEN_PIPE, "应用采集辅助进程未连接"));
                ::CancelIoEx(pipe_, &operation);
                DWORD ignored;
                ::GetOverlappedResult(pipe_, &operation, &ignored, TRUE);
                return false;
            }
        }
        if (cancelled())
        {
            ::CancelIoEx(pipe_, &operation);
            DWORD ignored;
            ::GetOverlappedResult(pipe_, &operation, &ignored, TRUE);
            return false;
        }
        DWORD size = 0;
        return ::GetOverlappedResult(pipe_, &operation, &size, FALSE) != FALSE;
    }

    void publishUnlocked(AppTrafficReport report)
    {
        report_ = std::move(report);
        ++revision_;
        changed_.notify_all();
    }

    bool send(const char* command, DWORD length)
    {
        OVERLAPPED operation{};
        operation.hEvent = ::CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!operation.hEvent)
            return false;
        DWORD size = 0;
        bool sent = ::WriteFile(pipe_, command, length, &size, &operation) != FALSE;
        if (!sent && ::GetLastError() == ERROR_IO_PENDING)
        {
            sent = ready(operation);
            if (sent) sent = ::GetOverlappedResult(pipe_, &operation, &size, FALSE) != FALSE;
        }
        ::CloseHandle(operation.hEvent);
        return sent && size == length;
    }

    void run()
    {
        OVERLAPPED connect{};
        connect.hEvent = ::CreateEventW(nullptr, TRUE, FALSE, nullptr);
        bool connected = connect.hEvent && ::ConnectNamedPipe(pipe_, &connect);
        if (!connected && connect.hEvent)
        {
            const auto code = ::GetLastError();
            if (code == ERROR_PIPE_CONNECTED) connected = true;
            else if (code == ERROR_IO_PENDING) connected = ready(connect);
        }
        if (connect.hEvent) ::CloseHandle(connect.hEvent);
        if (connected)
        {
            while (!cancelled())
            {
                bool launched;
                { std::lock_guard lock(mutex_); launched = launched_; }
                if (launched) break;
                ::WaitForSingleObject(stopped_, 50);
            }
            std::lock_guard lock(mutex_);
            ULONG client = 0;
            connected = !cancelled() && process_ && ::GetNamedPipeClientProcessId(pipe_, &client) && client == ::GetProcessId(process_);
            if (!connected && !cancelled())
                publishUnlocked(failure(ERROR_ACCESS_DENIED, "应用采集管道客户端身份不匹配"));
        }
        if (connected)
            exchange();
        else if (!cancelled())
        {
            std::lock_guard lock(mutex_);
            if (report_.state == AppCollectorState::starting)
                publishUnlocked(failure(ERROR_BROKEN_PIPE, "应用采集辅助进程未连接"));
        }
        ::CancelIoEx(pipe_, nullptr);
        ::CloseHandle(pipe_);
        pipe_ = INVALID_HANDLE_VALUE;
    }

    void exchange()
    {
        std::string buffer;
        bool received = false, pending = false;
        auto requestedAt = std::chrono::steady_clock::now();
        while (!cancelled())
        {
            bool request = false;
            { std::lock_guard lock(mutex_); if (received) request = std::exchange(requested_, false); }
            if (request && !pending)
            {
                if (!send("read\n", 5)) break;
                pending = true;
                requestedAt = std::chrono::steady_clock::now();
            }
            if ((pending || !received) && std::chrono::steady_clock::now() - requestedAt > std::chrono::seconds(5))
            {
                publish(failure(ERROR_TIMEOUT, "应用采集辅助进程没有响应"));
                break;
            }
            DWORD available = 0;
            if (!::PeekNamedPipe(pipe_, nullptr, 0, nullptr, &available, nullptr)) break;
            if (!available)
            {
                ::WaitForSingleObject(stopped_, 50);
                continue;
            }
            char bytes[8192];
            OVERLAPPED operation{};
            operation.hEvent = ::CreateEventW(nullptr, TRUE, FALSE, nullptr);
            if (!operation.hEvent) break;
            DWORD size = 0;
            bool read = ::ReadFile(pipe_, bytes, sizeof(bytes), &size, &operation) != FALSE;
            if (!read && ::GetLastError() == ERROR_IO_PENDING)
            {
                read = ready(operation);
                if (read) read = ::GetOverlappedResult(pipe_, &operation, &size, FALSE) != FALSE;
            }
            ::CloseHandle(operation.hEvent);
            if (!read || !size) break;
            buffer.append(bytes, size);
            if (buffer.size() > 128 * 1024 * 1024)
            {
                publish(failure(ERROR_BUFFER_OVERFLOW, "应用采集快照过大"));
                break;
            }
            std::size_t newline;
            while ((newline = buffer.find('\n')) != std::string::npos)
            {
                publish(parseAppTrafficReport(std::string_view(buffer).substr(0, newline)));
                buffer.erase(0, newline + 1);
                received = true;
                pending = false;
            }
        }
        if (!cancelled())
        {
            std::lock_guard lock(mutex_);
            if (!received || report_.state == AppCollectorState::running || report_.state == AppCollectorState::partial)
                publishUnlocked(failure(ERROR_BROKEN_PIPE, "应用采集辅助进程已退出"));
        }
    }

    Options options_;
    std::wstring name_;
    HANDLE pipe_ = INVALID_HANDLE_VALUE;
    HANDLE stopped_ = nullptr;
    HANDLE process_ = nullptr;
    std::thread worker_;
    std::mutex mutex_;
    std::condition_variable changed_;
    AppTrafficReport report_;
    std::uint64_t revision_ = 0;
    bool requested_ = false, launched_ = false;
    DWORD launchCode_ = ERROR_SUCCESS;
};

WindowsAppTrafficSource::WindowsAppTrafficSource(Options options) : options_(std::move(options)) {}
WindowsAppTrafficSource::~WindowsAppTrafficSource() { stop(); }
void WindowsAppTrafficSource::start()
{
    stop();
    session_ = std::make_shared<Session>(options_);
    if (session_->prepare())
        std::thread([session = session_] { session->launch(); }).detach();
}
void WindowsAppTrafficSource::stop()
{
    if (session_) session_->stop();
    session_.reset();
}
AppTrafficReport WindowsAppTrafficSource::read() { return session_ ? session_->read() : AppTrafficReport{}; }

}  // namespace wifimeter::platform::windows
