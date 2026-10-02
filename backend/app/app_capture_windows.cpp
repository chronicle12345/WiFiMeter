// Windows 授权辅助进程：采集非回环 ETW 与回环 TCP EStats，通过专用管道返回累计计数。
#include <winsock2.h>
#include <windows.h>
#include <shellapi.h>

#include <fcntl.h>
#include <io.h>

#include <charconv>
#include <iostream>
#include <string>

#include "../platform/app_traffic.h"
#include "../platform/win32/etw_app_capture.h"
#include "../platform/windows/text_convert.h"

namespace platform = wifimeter::platform;
namespace windows = platform::windows;

namespace
{
bool write(HANDLE output, const platform::AppTrafficReport& report)
{
    const auto text = platform::serializeAppTrafficReport(report) + "\n";
    std::size_t position = 0;
    while (position < text.size())
    {
        DWORD size = 0;
        const auto remaining = static_cast<DWORD>(text.size() - position);
        if (!::WriteFile(output, text.data() + position, remaining, &size, nullptr) || !size)
            return false;
        position += size;
    }
    return true;
}

int stdio()
{
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    windows::EtwAppCapture capture;
    const auto initial = capture.start();
    std::cout << platform::serializeAppTrafficReport(initial) << std::endl;
    if (initial.state != platform::AppCollectorState::running)
        return 1;
    std::string command;
    while (std::getline(std::cin, command))
    {
        if (command == "shutdown")
            break;
        if (command == "read")
            std::cout << platform::serializeAppTrafficReport(capture.read()) << std::endl;
    }
    return 0;
}

int pipe(const std::wstring& name, DWORD expectedParent)
{
    const auto connection = ::CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
    if (connection == INVALID_HANDLE_VALUE)
        return 1;
    ULONG server = 0;
    if (!::GetNamedPipeServerProcessId(connection, &server) || server != expectedParent)
    {
        ::CloseHandle(connection);
        return 1;
    }
    const auto parent = ::OpenProcess(SYNCHRONIZE, FALSE, expectedParent);
    if (!parent || ::WaitForSingleObject(parent, 0) != WAIT_TIMEOUT)
    {
        if (parent) ::CloseHandle(parent);
        ::CloseHandle(connection);
        return 1;
    }
    int result = 0;
    {
        // 先确认调用者及管道，再创建 ETW 会话；授权期间被取消也不会留下采集器。
        windows::EtwAppCapture capture;
        const auto initial = capture.start();
        if (!write(connection, initial) || initial.state != platform::AppCollectorState::running)
            result = 1;
        else
        {
            std::string buffer;
            bool stopped = false;
            while (!stopped && ::WaitForSingleObject(parent, 0) == WAIT_TIMEOUT)
            {
                DWORD available = 0;
                if (!::PeekNamedPipe(connection, nullptr, 0, nullptr, &available, nullptr))
                    break;
                if (!available)
                {
                    ::Sleep(50);
                    continue;
                }
                char bytes[128];
                DWORD size = 0;
                if (!::ReadFile(connection, bytes, sizeof(bytes), &size, nullptr) || !size)
                    break;
                buffer.append(bytes, size);
                if (buffer.size() > 1024)
                    break;
                std::size_t newline;
                while ((newline = buffer.find('\n')) != std::string::npos)
                {
                    const auto command = buffer.substr(0, newline);
                    buffer.erase(0, newline + 1);
                    if (command == "shutdown")
                    {
                        stopped = true;
                        break;
                    }
                    if (command == "read" && !write(connection, capture.read()))
                    {
                        stopped = true;
                        break;
                    }
                }
            }
        }
    }  // 必须先停止本实例的 ETW 会话，再关闭通信句柄。
    ::CloseHandle(parent);
    ::CloseHandle(connection);
    return result;
}
}  // namespace

int main()
{
    int count = 0;
    auto** arguments = ::CommandLineToArgvW(::GetCommandLineW(), &count);
    if (!arguments)
        return 2;
    bool useStdio = count == 2 && std::wstring(arguments[1]) == L"--stdio";
    std::wstring pipeName;
    DWORD parent = 0;
    if (count == 5 && std::wstring(arguments[1]) == L"--pipe" && std::wstring(arguments[3]) == L"--parent")
    {
        pipeName = arguments[2];
        const auto pid = windows::toUtf8(std::u16string_view(reinterpret_cast<const char16_t*>(arguments[4])));
        const auto parsed = std::from_chars(pid.data(), pid.data() + pid.size(), parent);
        if (parsed.ec != std::errc{} || parsed.ptr != pid.data() + pid.size())
            parent = 0;
    }
    ::LocalFree(arguments);
    if (useStdio)
        return stdio();
    if (parent && pipeName.starts_with(L"\\\\.\\pipe\\WiFiMeter.Apps."))
        return pipe(pipeName, parent);
    std::fprintf(stderr, "用法：wifimeter-app-capture.exe --pipe 名称 --parent PID，或 --stdio（原生测试）。\n");
    return 2;
}
