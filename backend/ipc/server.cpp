#include "server.h"

#include <poll.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>

namespace wifimeter::ipc
{
namespace
{

bool writeAll(int fd, const std::string& text)
{
    std::size_t written = 0;
    while (written < text.size())
    {
        const ssize_t count = ::write(fd, text.data() + written, text.size() - written);
        if (count > 0)
        {
            written += static_cast<std::size_t>(count);
            continue;
        }
        if (count < 0 && errno == EINTR)
            continue;
        return false;
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
{}

bool StdioServer::writeLine(const std::string& text)
{
    std::string line = text;
    line.push_back('\n');
    return writeAll(options_.outputFd, line);
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
    writeLine(response.ok() ? encodeResult(*request, response.result) : encodeError(*request, response.error));

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

        pollfd descriptor{options_.inputFd, POLLIN, 0};
        const int ready = ::poll(&descriptor, 1, static_cast<int>(wait.count()));
        if (ready < 0)
        {
            if (errno == EINTR)
                continue;
            return 1;
        }

        if (ready > 0 && (descriptor.revents & (POLLIN | POLLHUP | POLLERR)) != 0)
        {
            char chunk[4096];
            const ssize_t count = ::read(options_.inputFd, chunk, sizeof(chunk));
            if (count == 0)
                break;  // 对面关闭了输入：正常退出
            if (count < 0)
            {
                if (errno == EINTR)
                    continue;
                return 1;
            }

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
