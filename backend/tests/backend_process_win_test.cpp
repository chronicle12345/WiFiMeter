// 端到端测试（Windows）：真的把 wifimeter-backend.exe 作为子进程拉起来，按协议用管道对话。
//
// 测试数据与断言在 backend_process_support.h 里，与 Linux 侧共用同一份；
// 这里只提供 Windows 的子进程实现（CreateProcess + 匿名管道）。
//
// 注意：测试数据通过环境变量传给子进程，因此这里手工拼环境块——CreateProcess 不会
// 把当前进程新增的环境变量算进去，必须显式传 lpEnvironment。

#include <winsock2.h>
#include <ws2ipdef.h>
#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <cwchar>
#include <string>
#include <utility>
#include <vector>

#include "backend_process_support.h"
#include "test_support.h"
#include "windows_test_support.h"

#ifndef WIFIMETER_BACKEND_BINARY
#error "需要在 CMake 中定义 WIFIMETER_BACKEND_BINARY"
#endif

namespace
{

std::wstring wideFromUtf8(const std::string& text)
{
    if (text.empty())
        return {};
    const int size = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
    if (size <= 0)
        return {};
    std::wstring result(static_cast<std::size_t>(size), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), result.data(), size);
    return result;
}

// 当前进程环境 + 覆盖项，按 "KEY=VALUE\0...\0" 拼成环境块。
std::vector<wchar_t> buildEnvironment(const std::vector<std::pair<std::string, std::string>>& overrides)
{
    std::vector<std::pair<std::wstring, std::wstring>> entries;
    if (LPWCH current = ::GetEnvironmentStringsW(); current != nullptr)
    {
        for (LPWCH item = current; *item != L'\0'; item += ::wcslen(item) + 1)
        {
            const std::wstring text(item);
            const std::size_t separator = text.find(L'=');
            if (separator == std::wstring::npos || separator == 0)
                continue;
            entries.emplace_back(text.substr(0, separator), text.substr(separator + 1));
        }
        ::FreeEnvironmentStringsW(current);
    }

    for (const auto& entry : overrides)
    {
        const std::wstring key = wideFromUtf8(entry.first);
        const std::wstring value = wideFromUtf8(entry.second);
        const auto existing = std::find_if(entries.begin(), entries.end(), [&key](const auto& item) { return item.first == key; });
        if (existing == entries.end())
            entries.emplace_back(key, value);
        else
            existing->second = value;
    }

    std::vector<wchar_t> block;
    for (const auto& entry : entries)
    {
        const std::wstring text = entry.first + L"=" + entry.second;
        block.insert(block.end(), text.begin(), text.end());
        block.push_back(L'\0');
    }
    block.push_back(L'\0');
    return block;
}

std::wstring quoteArgument(const std::wstring& argument)
{
    // CreateProcess 的命令行解析规则：含空格或引号时用双引号包裹，内部引号翻倍。
    if (!argument.empty() && argument.find_first_of(L" \t\"") == std::wstring::npos)
        return argument;
    std::wstring quoted = L"\"";
    for (const wchar_t character : argument)
    {
        if (character == L'"')
            quoted.push_back(L'\\');
        quoted.push_back(character);
    }
    quoted.push_back(L'"');
    return quoted;
}

class WindowsProcessRunner final : public wifimeter::test::ProcessRunner
{
public:
    ~WindowsProcessRunner() override
    {
        stop();
    }

    bool start(const std::string& executable, const std::vector<std::string>& arguments, const std::vector<std::pair<std::string, std::string>>& environment) override
    {
        stop();

        SECURITY_ATTRIBUTES attributes{};
        attributes.nLength = sizeof(attributes);
        attributes.bInheritHandle = TRUE;

        HANDLE childInput = nullptr;   // 子进程的 stdin（我们写）
        HANDLE childOutput = nullptr;  // 子进程的 stdout（我们读）
        if (!::CreatePipe(&childInput, &inputWrite_, &attributes, 0))
            return false;
        if (!::CreatePipe(&outputRead_, &childOutput, &attributes, 0))
            return false;
        // 父进程这一端不要被子进程继承。
        ::SetHandleInformation(inputWrite_, HANDLE_FLAG_INHERIT, 0);
        ::SetHandleInformation(outputRead_, HANDLE_FLAG_INHERIT, 0);

        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = childInput;
        startup.hStdOutput = childOutput;
        // 后端的日志走标准错误；测试只按行过滤，因此与标准输出共用同一个管道。
        startup.hStdError = childOutput;

        std::vector<wchar_t> environmentBlock = buildEnvironment(environment);
        std::wstring commandLine = quoteArgument(wideFromUtf8(executable));
        for (const std::string& argument : arguments)
        {
            commandLine.push_back(L' ');
            commandLine += quoteArgument(wideFromUtf8(argument));
        }

        PROCESS_INFORMATION info{};
        const BOOL created = ::CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, TRUE, 0, environmentBlock.data(), nullptr, &startup, &info);
        ::CloseHandle(childInput);
        ::CloseHandle(childOutput);
        if (!created)
        {
            stop();
            return false;
        }

        process_ = info.hProcess;
        ::CloseHandle(info.hThread);
        return true;
    }

    bool send(const std::string& line) override
    {
        if (inputWrite_ == nullptr)
            return false;
        const std::string text = line + "\n";
        std::size_t written = 0;
        while (written < text.size())
        {
            const DWORD chunk = static_cast<DWORD>(std::min<std::size_t>(text.size() - written, 64 * 1024));
            DWORD count = 0;
            if (!::WriteFile(inputWrite_, text.data() + written, chunk, &count, nullptr) || count == 0)
                return false;
            written += count;
        }
        return true;
    }

    std::optional<std::string> readLine(std::chrono::milliseconds timeout) override
    {
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        while (true)
        {
            if (const std::size_t newline = buffer_.find('\n'); newline != std::string::npos)
            {
                std::string line = buffer_.substr(0, newline);
                buffer_.erase(0, newline + 1);
                if (!line.empty() && line.back() == '\r')
                    line.pop_back();
                return line;
            }

            const auto now = std::chrono::steady_clock::now();
            if (now >= deadline)
                return std::nullopt;
            const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();

            if (outputRead_ == nullptr)
                return std::nullopt;
            // 管道句柄上的 WaitForSingleObject 不支持超时，因此先 PeekNamedPipe 轮询。
            const std::int64_t bounded = std::min<std::int64_t>(std::max<std::int64_t>(remaining, 1), 50);
            const DWORD step = static_cast<DWORD>(bounded);
            DWORD available = 0;
            if (::PeekNamedPipe(outputRead_, nullptr, 0, nullptr, &available, nullptr) && available > 0)
            {
                char chunk[4096];
                DWORD count = 0;
                if (::ReadFile(outputRead_, chunk, static_cast<DWORD>(sizeof(chunk)), &count, nullptr) && count > 0)
                {
                    buffer_.append(chunk, static_cast<std::size_t>(count));
                    continue;
                }
                return std::nullopt;  // 管道关闭
            }
            if (process_ != nullptr && ::WaitForSingleObject(process_, 0) == WAIT_OBJECT_0 && available == 0)
                return std::nullopt;  // 进程已退出且没有更多输出
            ::Sleep(step);
        }
    }

    void closeInput() override
    {
        if (inputWrite_ != nullptr)
        {
            ::CloseHandle(inputWrite_);
            inputWrite_ = nullptr;
        }
    }

    std::optional<int> waitForExit(std::chrono::milliseconds timeout) override
    {
        if (process_ == nullptr)
            return std::nullopt;
        const DWORD milliseconds = static_cast<DWORD>(timeout.count());
        if (::WaitForSingleObject(process_, milliseconds) != WAIT_OBJECT_0)
            return std::nullopt;
        DWORD code = 1;
        ::GetExitCodeProcess(process_, &code);
        ::CloseHandle(process_);
        process_ = nullptr;
        return static_cast<int>(code);
    }

    int wait() override
    {
        const auto code = waitForExit(std::chrono::seconds(30));
        return code.value_or(-1);
    }

private:
    void stop()
    {
        closeInput();
        if (process_ != nullptr)
        {
            if (::WaitForSingleObject(process_, 5000) != WAIT_OBJECT_0)
                ::TerminateProcess(process_, 1);
            ::CloseHandle(process_);
            process_ = nullptr;
        }
        if (outputRead_ != nullptr)
        {
            ::CloseHandle(outputRead_);
            outputRead_ = nullptr;
        }
    }

    HANDLE process_ = nullptr;
    HANDLE inputWrite_ = nullptr;
    HANDLE outputRead_ = nullptr;
    std::string buffer_;
};

}  // namespace

int main()
{
    WindowsProcessRunner runner;
    return wifimeter::test::runAllProcessTests(runner, WIFIMETER_BACKEND_BINARY);
}
