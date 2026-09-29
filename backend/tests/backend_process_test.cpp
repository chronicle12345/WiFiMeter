// 端到端测试（Linux）：真的把 wifimeter-backend 作为子进程拉起来，按协议用管道对话。
//
// 测试数据与断言在 backend_process_support.h 里，与 Windows 侧共用同一份；
// 这里只提供 POSIX 的子进程实现（fork + execv + 管道）。

#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstring>
#include <string>
#include <vector>

#include "backend_process_support.h"
#include "test_support.h"

#ifndef WIFIMETER_BACKEND_BINARY
#error "需要在 CMake 中定义 WIFIMETER_BACKEND_BINARY"
#endif

namespace
{

class PosixProcessRunner final : public wifimeter::test::ProcessRunner
{
public:
    ~PosixProcessRunner() override
    {
        stop();
    }

    bool start(const std::string& executable, const std::vector<std::string>& arguments, const std::vector<std::pair<std::string, std::string>>& environment) override
    {
        stop();
        int inputPipe[2] = {-1, -1};
        int outputPipe[2] = {-1, -1};
        if (::pipe(inputPipe) != 0 || ::pipe(outputPipe) != 0)
            return false;

        child_ = ::fork();
        if (child_ < 0)
            return false;
        if (child_ == 0)
        {
            ::dup2(inputPipe[0], STDIN_FILENO);
            ::dup2(outputPipe[1], STDOUT_FILENO);
            // 后端的日志走标准错误，测试里不需要，直接丢弃。
            const int devNull = ::open("/dev/null", O_WRONLY);
            if (devNull >= 0)
                ::dup2(devNull, STDERR_FILENO);
            ::close(inputPipe[0]);
            ::close(inputPipe[1]);
            ::close(outputPipe[0]);
            ::close(outputPipe[1]);

            for (const auto& entry : environment)
                ::setenv(entry.first.c_str(), entry.second.c_str(), 1);

            std::vector<char*> argv;
            argv.push_back(const_cast<char*>(executable.c_str()));
            for (const std::string& argument : arguments)
                argv.push_back(const_cast<char*>(argument.c_str()));
            argv.push_back(nullptr);
            ::execv(executable.c_str(), argv.data());
            ::_exit(127);
        }

        ::close(inputPipe[0]);
        ::close(outputPipe[1]);
        input_ = inputPipe[1];
        output_ = outputPipe[0];
        return true;
    }

    bool send(const std::string& line) override
    {
        if (input_ < 0)
            return false;
        const std::string text = line + "\n";
        std::size_t written = 0;
        while (written < text.size())
        {
            const ssize_t count = ::write(input_, text.data() + written, text.size() - written);
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

            pollfd descriptor{output_, POLLIN, 0};
            const int ready = ::poll(&descriptor, 1, static_cast<int>(remaining));
            if (ready < 0)
            {
                if (errno == EINTR)
                    continue;
                return std::nullopt;
            }
            if (ready == 0)
                return std::nullopt;

            char chunk[4096];
            const ssize_t count = ::read(output_, chunk, sizeof(chunk));
            if (count > 0)
            {
                buffer_.append(chunk, static_cast<std::size_t>(count));
                continue;
            }
            if (count == 0)
                return std::nullopt;  // 子进程退出
            if (errno != EINTR)
                return std::nullopt;
        }
    }

    void closeInput() override
    {
        if (input_ >= 0)
        {
            ::close(input_);
            input_ = -1;
        }
    }

    std::optional<int> waitForExit(std::chrono::milliseconds timeout) override
    {
        if (child_ <= 0)
            return std::nullopt;
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        while (std::chrono::steady_clock::now() < deadline)
        {
            int status = 0;
            const pid_t done = ::waitpid(child_, &status, WNOHANG);
            if (done == child_)
            {
                child_ = -1;
                return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
            }
            if (done < 0 && errno != EINTR)
                return std::nullopt;
            ::usleep(20000);
        }
        return std::nullopt;
    }

    int wait() override
    {
        if (child_ <= 0)
            return -1;
        int status = 0;
        while (::waitpid(child_, &status, 0) < 0 && errno == EINTR)
        {
        }
        const int code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
        child_ = -1;
        return code;
    }

private:
    void stop()
    {
        closeInput();
        if (child_ > 0 && !waitForExit(std::chrono::seconds(5)))
        {
            ::kill(child_, SIGKILL);
            int status = 0;
            while (::waitpid(child_, &status, 0) < 0 && errno == EINTR)
            {
            }
            child_ = -1;
        }
        if (output_ >= 0)
        {
            ::close(output_);
            output_ = -1;
        }
    }

    pid_t child_ = -1;
    int input_ = -1;
    int output_ = -1;
    std::string buffer_;
};

}  // namespace

int main()
{
    PosixProcessRunner runner;
    return wifimeter::test::runAllProcessTests(runner, WIFIMETER_BACKEND_BINARY);
}
