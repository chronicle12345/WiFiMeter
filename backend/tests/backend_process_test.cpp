// 端到端测试：真的把 wifimeter-backend 作为子进程拉起来，按协议用管道对话。
//
// 假的网卡数据通过 --nmcli 与 --proc-net-dev 注入，因此不碰真实网络，
// 但进程、协议、SQLite 落库与事件推送都是真的。

#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

#include "../support/json.h"
#include "test_support.h"

#ifndef WIFIMETER_BACKEND_BINARY
#error "需要在 CMake 中定义 WIFIMETER_BACKEND_BINARY"
#endif

using wifimeter::support::JsonValue;
using wifimeter::test::TempDirectory;

namespace
{

namespace fs = std::filesystem;

// 假 nmcli：固定报告 wlan0 已关联到 Habitat_5G。
const char* kFakeNmcli = R"SH(#!/bin/sh
case "$*" in
  *"dev show"*)
    printf 'GENERAL.DEVICE:wlan0\nGENERAL.TYPE:wifi\nGENERAL.STATE:100 (connected)\nGENERAL.CONNECTION:Habitat_5G\nGENERAL.CON-UUID:21f995e7-fe3b-41a1-ae3a-6468c6918397\nGENERAL.VENDOR:AICSemi\nGENERAL.PRODUCT:AIC8800DC\n\n'
    ;;
  *"802-11-wireless.ssid"*) printf '802-11-wireless.ssid:Habitat_5G\n' ;;
  *"dev wifi list"*) printf '*:Habitat_5G:82:5180 MHz\n' ;;
  *"dev disconnect"*) printf 'Device %s successfully disconnected.\n' "$4" ;;
  *) exit 1 ;;
esac
exit 0
)SH";

// 子进程包装：写标准输入、按行读标准输出，读的时候跳过事件。
class BackendProcess
{
public:
    ~BackendProcess()
    {
        stop();
    }

    bool start(const std::string& binary, const std::vector<std::string>& arguments)
    {
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

            std::vector<char*> argv;
            argv.push_back(const_cast<char*>(binary.c_str()));
            for (const std::string& argument : arguments)
                argv.push_back(const_cast<char*>(argument.c_str()));
            argv.push_back(nullptr);
            ::execv(binary.c_str(), argv.data());
            ::_exit(127);
        }

        ::close(inputPipe[0]);
        ::close(outputPipe[1]);
        input_ = inputPipe[1];
        output_ = outputPipe[0];
        return true;
    }

    bool send(const std::string& line)
    {
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

    std::optional<std::string> readLine(std::chrono::milliseconds timeout)
    {
        const auto deadline = std::chrono::steady_clock::now() + timeout;
        while (true)
        {
            if (const std::size_t newline = buffer_.find('\n'); newline != std::string::npos)
            {
                std::string line = buffer_.substr(0, newline);
                buffer_.erase(0, newline + 1);
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

    // 发一条请求并等到对应 id 的响应；期间收到的事件记到 events 里。
    // 读取并记录当前可读的所有事件（响应之后推送的事件要靠它收上来）。
    void drainEvents(std::chrono::milliseconds quiet = std::chrono::milliseconds(400))
    {
        while (true)
        {
            const auto text = readLine(quiet);
            if (!text)
                return;
            std::string error;
            const auto parsed = JsonValue::parse(*text, error);
            if (parsed && parsed->find("event") != nullptr)
                events.push_back(*parsed);
        }
    }

    std::optional<JsonValue> request(long long id, const std::string& method, const std::string& paramsJson = "{}", std::chrono::milliseconds timeout = std::chrono::seconds(10))
    {
        const std::string line = "{\"id\":" + std::to_string(id) + ",\"method\":\"" + method + "\",\"params\":" + paramsJson + "}";
        if (!send(line))
            return std::nullopt;

        const auto deadline = std::chrono::steady_clock::now() + timeout;
        while (true)
        {
            const auto now = std::chrono::steady_clock::now();
            if (now >= deadline)
                return std::nullopt;
            const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
            const auto text = readLine(remaining);
            if (!text)
                return std::nullopt;

            std::string error;
            const auto parsed = JsonValue::parse(*text, error);
            if (!parsed)
                continue;
            if (parsed->find("event") != nullptr)
            {
                events.push_back(*parsed);
                continue;
            }
            if (parsed->intOr("id", -1) == id)
                return parsed;
        }
    }

    void closeInput()
    {
        if (input_ >= 0)
        {
            ::close(input_);
            input_ = -1;
        }
    }

    // 等待退出；超时返回空值。
    std::optional<int> waitForExit(std::chrono::milliseconds timeout)
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

    int wait()
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

    void stop()
    {
        closeInput();
        if (child_ > 0 && !waitForExit(std::chrono::seconds(3)))
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

    std::vector<JsonValue> events;

private:
    pid_t child_ = -1;
    int input_ = -1;
    int output_ = -1;
    std::string buffer_;
};

std::string countersFile(std::uint64_t rx, std::uint64_t tx)
{
    return "Inter-|   Receive                                                |  Transmit\n"
           " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n"
           "wlan0: " +
           std::to_string(rx) + " 0 0 0 0 0 0 0 " + std::to_string(tx) + " 0 0 0 0 0 0 0\n";
}

struct Fixture
{
    TempDirectory directory{"backend-process"};
    std::string binary = WIFIMETER_BACKEND_BINARY;
    std::string nmcli;
    std::string procNetDev;
    std::string database;

    Fixture()
    {
        nmcli = directory.file("fake-nmcli");
        wifimeter::test::writeFile(nmcli, kFakeNmcli, true);
        procNetDev = directory.file("dev");
        wifimeter::test::writeFile(procNetDev, countersFile(5000000, 900000));
        database = directory.file("meter.db");
    }

    std::vector<std::string> arguments() const
    {
        return {"--db", database, "--nmcli", nmcli, "--proc-net-dev", procNetDev};
    }

    void setCounters(std::uint64_t rx, std::uint64_t tx) const
    {
        wifimeter::test::writeFile(procNetDev, countersFile(rx, tx));
    }
};

void talksTheProtocol()
{
    Fixture fixture;
    BackendProcess process;
    WIFIMETER_CHECK(process.start(fixture.binary, fixture.arguments()));
    if (!process.send(""))  // 空行应当被忽略
        return;

    const auto hello = process.request(1, "hello");
    WIFIMETER_CHECK(hello.has_value());
    if (hello)
    {
        WIFIMETER_CHECK(hello->boolOr("ok"));
        const JsonValue* result = hello->find("result");
        WIFIMETER_CHECK(result != nullptr);
        if (result != nullptr)
        {
            WIFIMETER_CHECK_EQ(result->intOr("protocol"), std::int64_t{1});
            WIFIMETER_CHECK_EQ(result->stringOr("application"), std::string("wifimeter-backend"));
        }
    }

    // 未知方法要被拒绝，且带明确错误码。
    const auto unknown = process.request(2, "noSuchMethod");
    WIFIMETER_CHECK(unknown.has_value());
    if (unknown)
    {
        WIFIMETER_CHECK(!unknown->boolOr("ok"));
        WIFIMETER_CHECK_EQ(unknown->find("error")->stringOr("code"), std::string("unknownMethod"));
    }

    // 坏 JSON 也要回错误而不是让进程崩掉。
    WIFIMETER_CHECK(process.send("{not json"));
    const auto garbage = process.readLine(std::chrono::seconds(5));
    WIFIMETER_CHECK(garbage.has_value());
    if (garbage)
    {
        WIFIMETER_CHECK(garbage->find("ok") != std::string::npos && garbage->find("false") != std::string::npos);
    }

    // 进程还活着，继续正常服务。
    const auto after = process.request(3, "hello");
    WIFIMETER_CHECK(after.has_value());
    WIFIMETER_CHECK(process.request(4, "shutdown").has_value());
    WIFIMETER_CHECK_EQ(process.wait(), 0);
}

void collectsAndStoresUsage()
{
    Fixture fixture;
    BackendProcess process;
    WIFIMETER_CHECK(process.start(fixture.binary, fixture.arguments()));

    // 第一次采集只建立基线。
    WIFIMETER_CHECK(process.request(1, "collectNow", "{}", std::chrono::seconds(20)).has_value());
    fixture.setCounters(8100000, 1400000);
    const auto second = process.request(2, "collectNow", "{}", std::chrono::seconds(20));
    WIFIMETER_CHECK(second.has_value());
    // 事件是在响应之后推送的，先把它们收上来再断言。
    process.drainEvents();

    // 第二次采集应当推送用量事件，数值正好是两次计数之差。
    bool sawUsage = false;
    for (const JsonValue& event : process.events)
    {
        if (event.stringOr("event") != "usage")
            continue;
        const JsonValue* networks = event.find("networks");
        if (networks == nullptr || networks->size() != 1)
            continue;
        WIFIMETER_CHECK_EQ(networks->at(0).stringOr("rxBytes"), std::string("3100000"));
        WIFIMETER_CHECK_EQ(networks->at(0).stringOr("txBytes"), std::string("500000"));
        sawUsage = true;
    }
    WIFIMETER_CHECK(sawUsage);

    // 快照里能读到记录、网络与账本。
    const auto snapshot = process.request(3, "snapshot");
    WIFIMETER_CHECK(snapshot.has_value());
    if (snapshot)
    {
        const JsonValue* result = snapshot->find("result");
        WIFIMETER_CHECK(result != nullptr);
        if (result != nullptr)
        {
            WIFIMETER_CHECK_EQ(result->stringOr("source"), std::string("backend"));
            const JsonValue* records = result->find("records");
            WIFIMETER_CHECK(records != nullptr && records->size() == 1);
            if (records != nullptr && records->size() == 1)
            {
                WIFIMETER_CHECK_EQ(records->at(0).stringOr("rxBytes"), std::string("3100000"));
                WIFIMETER_CHECK_EQ(records->at(0).stringOr("txBytes"), std::string("500000"));
            }
            const JsonValue* networks = result->find("networks");
            WIFIMETER_CHECK(networks != nullptr && networks->size() == 1);
            if (networks != nullptr && networks->size() == 1)
            {
                WIFIMETER_CHECK_EQ(networks->at(0).stringOr("ssid"), std::string("Habitat_5G"));
                WIFIMETER_CHECK_EQ(networks->at(0).find("quotaLedger")->stringOr("usedBytes"), std::string("3600000"));
            }
            const JsonValue* live = result->find("live");
            WIFIMETER_CHECK(live != nullptr);
            if (live != nullptr)
            {
                WIFIMETER_CHECK_EQ(live->stringOr("state"), std::string("connected"));
                WIFIMETER_CHECK_EQ(live->find("connections")->size(), std::size_t{1});
            }
        }
    }

    WIFIMETER_CHECK(process.request(4, "shutdown").has_value());
    WIFIMETER_CHECK_EQ(process.wait(), 0);
}

void persistsAcrossRestart()
{
    Fixture fixture;
    {
        BackendProcess process;
        WIFIMETER_CHECK(process.start(fixture.binary, fixture.arguments()));
        WIFIMETER_CHECK(process.request(1, "collectNow", "{}", std::chrono::seconds(20)).has_value());
        fixture.setCounters(6000000, 1000000);
        WIFIMETER_CHECK(process.request(2, "collectNow", "{}", std::chrono::seconds(20)).has_value());
        WIFIMETER_CHECK(process.request(3, "shutdown").has_value());
        WIFIMETER_CHECK_EQ(process.wait(), 0);
    }

    // 重开一个进程读同一个数据库：之前的记录必须还在。
    BackendProcess restarted;
    WIFIMETER_CHECK(restarted.start(fixture.binary, fixture.arguments()));
    const auto snapshot = restarted.request(1, "snapshot", "{\"from\":\"2020-01-01\",\"to\":\"2030-01-01\"}");
    WIFIMETER_CHECK(snapshot.has_value());
    if (snapshot)
    {
        const JsonValue* records = snapshot->find("result")->find("records");
        WIFIMETER_CHECK(records != nullptr && records->size() == 1);
        if (records != nullptr && records->size() == 1)
            WIFIMETER_CHECK_EQ(records->at(0).stringOr("rxBytes"), std::string("1000000"));
    }
    WIFIMETER_CHECK(restarted.request(2, "shutdown").has_value());
    WIFIMETER_CHECK_EQ(restarted.wait(), 0);
}

void updatesSettingsThroughTheProcess()
{
    Fixture fixture;
    BackendProcess process;
    WIFIMETER_CHECK(process.start(fixture.binary, fixture.arguments()));

    const auto updated = process.request(1, "updateSettings", R"({"settings":{"unit":"GiB","interval":10,"retention":365}})");
    WIFIMETER_CHECK(updated.has_value());
    if (updated)
    {
        const JsonValue* settings = updated->find("result")->find("settings");
        WIFIMETER_CHECK(settings != nullptr);
        if (settings != nullptr)
        {
            WIFIMETER_CHECK_EQ(settings->stringOr("unit"), std::string("GiB"));
            WIFIMETER_CHECK_EQ(settings->intOr("interval"), std::int64_t{10});
        }
    }

    const auto snapshot = process.request(2, "snapshot");
    WIFIMETER_CHECK(snapshot.has_value());
    if (snapshot)
        WIFIMETER_CHECK_EQ(snapshot->find("result")->find("settings")->stringOr("unit"), std::string("GiB"));

    WIFIMETER_CHECK(process.request(3, "shutdown").has_value());
    WIFIMETER_CHECK_EQ(process.wait(), 0);
}

void exitsCleanlyWhenInputCloses()
{
    Fixture fixture;
    BackendProcess process;
    WIFIMETER_CHECK(process.start(fixture.binary, fixture.arguments()));
    WIFIMETER_CHECK(process.request(1, "hello").has_value());

    // 不发 shutdown，直接关闭输入：应当正常退出（而不是挂住或被信号杀死）。
    process.closeInput();
    const auto code = process.waitForExit(std::chrono::seconds(5));
    WIFIMETER_CHECK(code.has_value());
    if (code)
        WIFIMETER_CHECK_EQ(*code, 0);
}

}  // namespace

int main()
{
    talksTheProtocol();
    collectsAndStoresUsage();
    persistsAcrossRestart();
    updatesSettingsThroughTheProcess();
    exitsCleanlyWhenInputCloses();
    return WIFIMETER_REPORT();
}
