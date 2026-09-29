#include "server_windows.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>

namespace wifimeter::ipc
{
namespace
{

HANDLE standardHandle(DWORD which)
{
    const HANDLE handle = ::GetStdHandle(which);
    return handle == nullptr ? INVALID_HANDLE_VALUE : handle;
}

// 管道写入必须一次写完：文件句柄的 WriteFile 是原子的，管道上则可能部分写入。
bool writeAll(HANDLE handle, const std::string& text)
{
    std::size_t written = 0;
    while (written < text.size())
    {
        const DWORD chunk = static_cast<DWORD>(std::min<std::size_t>(text.size() - written, 64 * 1024));
        DWORD count = 0;
        if (!::WriteFile(handle, text.data() + written, chunk, &count, nullptr) || count == 0)
            return false;
        written += count;
    }
    return true;
}

}  // namespace

StdioServer::StdioServer(BackendService& service)
    : StdioServer(service, Options{})
{}

StdioServer::StdioServer(BackendService& service, Options options)
    : service_(service),
      options_(options)
{
    if (options_.input == INVALID_HANDLE_VALUE)
        options_.input = standardHandle(STD_INPUT_HANDLE);
    if (options_.output == INVALID_HANDLE_VALUE)
        options_.output = standardHandle(STD_OUTPUT_HANDLE);
}

bool StdioServer::writeLine(const std::string& text)
{
    std::string line = text;
    line.push_back('\n');
    return writeAll(options_.output, line);
}

void StdioServer::emitEvent(const std::string& name, const support::JsonValue& payload)
{
    writeLine(encodeEvent(name, payload));
}

bool StdioServer::handleLine(const std::string& line, core::TimePoint now)
{
    if (line.empty())
        return true;

    Error error;
    const auto request = parseRequest(line, error);
    if (!request)
    {
        // 没有 id 的坏请求也要回一条错误，方便对面定位。
        Request placeholder;
        writeLine(encodeError(placeholder, error));
        return true;
    }

    const BackendService::Response response = service_.handle(*request, now);
    writeLine(response.ok() ? encodeResult(*request, response.result) : encodeError(*request, error));

    // 处理请求时产生的事件（例如 collectNow 触发的采样）随后推送。
    for (const auto& event : service_.takePendingEvents())
        emitEvent(event.first, event.second);

    if (response.ok() && request->method == method::kShutdown)
        return false;
    return true;
}

int StdioServer::run(core::TimePoint startAt)
{
    service_.onStart(startAt);
    std::string buffer;
    bool running = true;

    while (running)
    {
        // 下一次采样与输入到达，谁先到就处理谁。
        auto wait = options_.maxWait;
        const auto untilSample = service_.nextSampleAt() - std::chrono::system_clock::now();
        if (!service_.paused() && untilSample < wait)
            wait = std::chrono::duration_cast<std::chrono::milliseconds>(untilSample);
        if (wait.count() < 0)
            wait = std::chrono::milliseconds(0);

        const DWORD timeout = static_cast<DWORD>(std::min<std::int64_t>(wait.count(), 60 * 1000));
        const DWORD ready = ::WaitForSingleObject(options_.input, timeout);

        if (ready == WAIT_OBJECT_0)
        {
            char chunk[4096];
            DWORD count = 0;
            const BOOL ok = ::ReadFile(options_.input, chunk, static_cast<DWORD>(sizeof(chunk)), &count, nullptr);
            if (!ok)
            {
                const DWORD error = ::GetLastError();
                // 管道被对面关闭时读取会失败：按正常结束处理。
                if (error == ERROR_BROKEN_PIPE || error == ERROR_HANDLE_EOF)
                    break;
                return 1;
            }
            if (count == 0)
                break;  // 输入结束：正常退出

            buffer.append(chunk, static_cast<std::size_t>(count));
            std::size_t newline = buffer.find('\n');
            while (newline != std::string::npos)
            {
                std::string line = buffer.substr(0, newline);
                buffer.erase(0, newline + 1);
                if (!line.empty() && line.back() == '\r')
                    line.pop_back();
                if (!handleLine(line, std::chrono::system_clock::now()))
                {
                    running = false;
                    break;
                }
                newline = buffer.find('\n');
            }
            if (!running)
                break;
            continue;
        }

        if (ready == WAIT_FAILED)
            return 1;

        // 超时：到点就采一次。
        const auto now = std::chrono::system_clock::now();
        if (!service_.paused() && now >= service_.nextSampleAt())
        {
            const BackendService::Events events = service_.collectOnce(now);
            for (std::size_t index = 0; index < events.items.size(); ++index)
                emitEvent(events.names[index], events.items[index]);
        }
    }
    return 0;
}

}  // namespace wifimeter::ipc
