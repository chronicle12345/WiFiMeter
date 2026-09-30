#include <winsock2.h>
#include <windows.h>
#include <shellapi.h>

#include <filesystem>
#include <thread>

#include "../platform/win32/windows_app_traffic.h"
#include "../platform/windows/text_convert.h"
#include "test_support.h"

namespace platform = wifimeter::platform;
namespace windows = platform::windows;

std::string utf8(const std::wstring& text)
{
    return windows::toUtf8(std::u16string_view(reinterpret_cast<const char16_t*>(text.data()), text.size()));
}

std::wstring executable()
{
    std::wstring path(32768, L'\0');
    const auto size = ::GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    path.resize(size);
    return path;
}

bool emit(HANDLE pipe, const std::string& json)
{
    const auto text = json + "\n";
    DWORD size = 0;
    return ::WriteFile(pipe, text.data(), static_cast<DWORD>(text.size()), &size, nullptr) && size == text.size();
}

int helper(const std::wstring& name)
{
    const auto path = executable();
    if (path.find(L"delayed") != std::wstring::npos)
        ::Sleep(1500);
    const auto pipe = ::CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
    if (pipe == INVALID_HANDLE_VALUE)
        return 1;
    platform::AppTrafficReport report{platform::AppCollectorState::running, "one", {},
        {{"WLAN", "browser", "浏览器", "42:100", 42, 123, 45}}};
    std::string json = platform::serializeAppTrafficReport(report);
    const bool denied = path.find(L"permission") != std::wstring::npos;
    const bool invalid = path.find(L"invalid") != std::wstring::npos;
    const bool unresponsive = path.find(L"unresponsive") != std::wstring::npos;
    if (denied) json = "{\"state\":\"permission\",\"detail\":\"Access denied\"}";
    if (invalid) json = "invalid JSON";
    if (!emit(pipe, json) || denied || invalid)
    {
        ::CloseHandle(pipe);
        return 1;
    }
    std::string commands;
    char bytes[128];
    DWORD size = 0;
    while (::ReadFile(pipe, bytes, sizeof(bytes), &size, nullptr) && size)
    {
        commands.append(bytes, size);
        std::size_t newline;
        while ((newline = commands.find('\n')) != std::string::npos)
        {
            const auto command = commands.substr(0, newline);
            commands.erase(0, newline + 1);
            if (command == "read" && !unresponsive && !emit(pipe, json))
            {
                ::CloseHandle(pipe);
                return 0;
            }
        }
    }
    ::CloseHandle(pipe);
    return 0;
}

platform::AppTrafficReport waitFor(windows::WindowsAppTrafficSource& source, platform::AppCollectorState expected,
    std::chrono::seconds timeout = std::chrono::seconds(10))
{
    platform::AppTrafficReport result;
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    do
    {
        result = source.read();
        if (result.state == expected)
            break;
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
    } while (std::chrono::steady_clock::now() < deadline);
    return result;
}

int main()
{
    int count = 0;
    auto** arguments = ::CommandLineToArgvW(::GetCommandLineW(), &count);
    if (!arguments)
        return 2;
    const bool child = count == 5 && std::wstring(arguments[1]) == L"--pipe";
    const std::wstring pipeName = child ? arguments[2] : L"";
    ::LocalFree(arguments);
    if (child)
        return helper(pipeName);
    wifimeter::test::TempDirectory directory("windows-app-helper");
    const auto makeHelper = [&](const std::string& name) {
        const auto path = directory.file(name + " 带空格.exe");
        std::filesystem::copy_file(std::filesystem::path(executable()), std::filesystem::path(windows::toUtf16(path)));
        return path;
    };
    windows::WindowsAppTrafficSource source({makeHelper("normal"), false});
    WIFIMETER_CHECK(source.read().state == platform::AppCollectorState::disabled);
    source.start();
    const auto report = waitFor(source, platform::AppCollectorState::running);
    WIFIMETER_CHECK(report.state == platform::AppCollectorState::running);
    WIFIMETER_CHECK_EQ(report.samples.size(), std::size_t{1});
    if (!report.samples.empty())
    {
        WIFIMETER_CHECK_EQ(report.samples[0].name, std::string("浏览器"));
        WIFIMETER_CHECK_EQ(report.samples[0].rxBytes, std::uint64_t{123});
    }
    source.stop();
    WIFIMETER_CHECK(source.read().state == platform::AppCollectorState::disabled);
    windows::WindowsAppTrafficSource denied({makeHelper("permission"), false});
    denied.start();
    const auto deniedReport = waitFor(denied, platform::AppCollectorState::permission);
    WIFIMETER_CHECK(deniedReport.state == platform::AppCollectorState::permission);
    WIFIMETER_CHECK_EQ(deniedReport.detail, std::string("Access denied"));
    if (deniedReport.state != platform::AppCollectorState::permission)
        std::fprintf(stderr, "权限失败报告：%s\n", platform::serializeAppTrafficReport(deniedReport).c_str());
    denied.stop();
    windows::WindowsAppTrafficSource invalid({makeHelper("invalid"), false});
    invalid.start();
    WIFIMETER_CHECK(waitFor(invalid, platform::AppCollectorState::unavailable).state == platform::AppCollectorState::unavailable);
    invalid.stop();
    windows::WindowsAppTrafficSource missing({directory.file("missing.exe"), false});
    missing.start();
    WIFIMETER_CHECK(waitFor(missing, platform::AppCollectorState::unavailable).state == platform::AppCollectorState::unavailable);
    missing.stop();
    windows::WindowsAppTrafficSource delayed({makeHelper("delayed"), false});
    delayed.start();
    const auto before = std::chrono::steady_clock::now();
    delayed.stop();
    WIFIMETER_CHECK(std::chrono::steady_clock::now() - before < std::chrono::seconds(1));
    WIFIMETER_CHECK(delayed.read().state == platform::AppCollectorState::disabled);
    windows::WindowsAppTrafficSource stalled({makeHelper("unresponsive"), false});
    stalled.start();
    WIFIMETER_CHECK(waitFor(stalled, platform::AppCollectorState::running).state == platform::AppCollectorState::running);
    WIFIMETER_CHECK(waitFor(stalled, platform::AppCollectorState::unavailable).state == platform::AppCollectorState::unavailable);
    stalled.stop();
    return WIFIMETER_REPORT();
}
