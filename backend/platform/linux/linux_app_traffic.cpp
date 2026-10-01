#include "linux_app_traffic.h"

#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <spawn.h>
#include <span>
#include <sys/wait.h>
#include <unistd.h>
#include <utility>

extern char** environ;

namespace wifimeter::platform::linux
{

LinuxAppTrafficSource::LinuxAppTrafficSource(Options options) : options_(std::move(options)) {}
LinuxAppTrafficSource::~LinuxAppTrafficSource() { stop(); }

void LinuxAppTrafficSource::publish(AppTrafficReport report)
{
    std::lock_guard lock(mutex_);
    report_ = std::move(report);
    ++revision_;
    changed_.notify_all();
}

void LinuxAppTrafficSource::start()
{
    stop();
    stopped_ = false;
    publish({AppCollectorState::starting, {}, {}, {}});
    worker_ = std::thread([this] { run(); });
}

void LinuxAppTrafficSource::stop()
{
    stopped_ = true;
    changed_.notify_all();
    if (worker_.joinable())
        worker_.join();
    publish({});
}

AppTrafficReport LinuxAppTrafficSource::read()
{
    std::unique_lock lock(mutex_);
    if (stopped_)
        return report_;
    const auto before = revision_;
    requested_ = true;
    changed_.wait_for(lock, std::chrono::milliseconds(100), [&] { return revision_ != before || stopped_; });
    return report_;
}

void LinuxAppTrafficSource::run()
{
    int input[2]{-1, -1}, output[2]{-1, -1};
    const auto closePipes = [&] {
        for (int* pipe : {input, output})
            for (int& fd : std::span<int, 2>(pipe, 2))
                if (fd >= 0) { ::close(fd); fd = -1; }
    };
    if (::pipe2(input, O_CLOEXEC) != 0 || ::pipe2(output, O_CLOEXEC) != 0)
    {
        const auto detail = std::string("创建采集管道失败：") + std::strerror(errno);
        closePipes();
        publish({AppCollectorState::unavailable, {}, detail, {}});
        return;
    }
    posix_spawn_file_actions_t actions;
    ::posix_spawn_file_actions_init(&actions);
    ::posix_spawn_file_actions_adddup2(&actions, input[0], STDIN_FILENO);
    ::posix_spawn_file_actions_adddup2(&actions, output[1], STDOUT_FILENO);
    for (const int fd : {input[0], input[1], output[0], output[1]})
        ::posix_spawn_file_actions_addclose(&actions, fd);
    const bool authorize = options_.authorize && ::geteuid() != 0;
    std::string command = authorize ? "/usr/bin/pkexec" : options_.helperPath;
    char* arguments[]{command.data(), authorize ? options_.helperPath.data() : nullptr, nullptr};
    pid_t child = -1;
    const int spawned = ::posix_spawn(&child, command.c_str(), &actions, nullptr, arguments, environ);
    ::posix_spawn_file_actions_destroy(&actions);
    if (spawned)
    {
        closePipes();
        publish({AppCollectorState::unavailable, {}, "启动应用采集辅助进程失败：" + std::string(std::strerror(spawned)), {}});
        return;
    }
    ::close(input[0]); input[0] = -1;
    ::close(output[1]); output[1] = -1;
    ::fcntl(input[1], F_SETFL, O_NONBLOCK);
    ::fcntl(output[0], F_SETFL, O_NONBLOCK);
    // 只在此线程屏蔽 SIGPIPE；辅助进程提前退出不能结束普通后端。
    sigset_t blocked;
    ::sigemptyset(&blocked);
    ::sigaddset(&blocked, SIGPIPE);
    ::pthread_sigmask(SIG_BLOCK, &blocked, nullptr);
    std::string buffer;
    bool received = false;
    bool pending = false;
    auto requestedAt = std::chrono::steady_clock::now();
    while (!stopped_)
    {
        bool request = false;
        {
            std::lock_guard lock(mutex_);
            request = std::exchange(requested_, false);
        }
        if (request && !pending && ::write(input[1], "read\n", 5) == 5)
        {
            pending = true;
            requestedAt = std::chrono::steady_clock::now();
        }
        if (received && pending && std::chrono::steady_clock::now() - requestedAt > std::chrono::seconds(5))
        {
            publish({AppCollectorState::unavailable, {}, "应用采集辅助进程没有响应。", {}});
            break;
        }
        pollfd descriptor{output[0], POLLIN, 0};
        const int ready = ::poll(&descriptor, 1, 50);
        if (ready < 0 && errno == EINTR)
            continue;
        if (ready < 0)
            break;
        if (!ready)
            continue;
        char bytes[8192];
        const auto size = ::read(output[0], bytes, sizeof(bytes));
        if (size < 0 && (errno == EINTR || errno == EAGAIN))
            continue;
        if (size <= 0)
            break;
        buffer.append(bytes, static_cast<std::size_t>(size));
        if (buffer.size() > 128 * 1024 * 1024)
        {
            publish({AppCollectorState::unavailable, {}, "应用采集快照过大。", {}});
            received = true;
            pending = false;
            break;
        }
        std::size_t newline = 0;
        while ((newline = buffer.find('\n')) != std::string::npos)
        {
            publish(parseAppTrafficReport(std::string_view(buffer).substr(0, newline)));
            buffer.erase(0, newline + 1);
            received = true;
            pending = false;
        }
    }
    const std::string_view shutdown = "shutdown\n";
    std::size_t sent = 0;
    while (sent < shutdown.size())
    {
        const auto written = ::write(input[1], shutdown.data() + sent, shutdown.size() - sent);
        if (written > 0)
            sent += static_cast<std::size_t>(written);
        else if (written < 0 && errno == EINTR)
            continue;
        else
            // 管道已满、关闭或写入失败时，关闭管道以 EOF 通知 helper 退出。
            break;
    }
    closePipes();
    // 授权尚未结束时 pkexec 的 real UID 仍属调用者，可以取消该进程；授权后由 EOF 结束 helper。
    ::kill(child, SIGTERM);
    int status = 0;
    bool exited = false;
    for (int attempt = 0; attempt < 20; ++attempt)
    {
        const auto waited = ::waitpid(child, &status, WNOHANG);
        if (waited == child || (waited < 0 && errno == ECHILD)) { exited = true; break; }
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
    }
    if (!exited)
    {
        ::kill(child, SIGKILL);
        // 不阻塞桌面关闭；极端情况下最终退出的辅助进程仍会被回收。
        std::thread([child] { int status; while (::waitpid(child, &status, 0) < 0 && errno == EINTR) {} }).detach();
    }
    if (!stopped_)
    {
        std::lock_guard lock(mutex_);
        if (!received || report_.state == AppCollectorState::running || report_.state == AppCollectorState::partial)
        {
            report_ = {authorize && exited && WIFEXITED(status) && (WEXITSTATUS(status) == 126 || WEXITSTATUS(status) == 127)
                ? AppCollectorState::permission : AppCollectorState::unavailable, {}, "应用采集辅助进程已退出，可能需要重新完成系统授权。", {}};
            ++revision_;
            changed_.notify_all();
        }
    }
}

}  // namespace wifimeter::platform::linux
