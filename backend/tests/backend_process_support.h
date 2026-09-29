#pragma once

// 端到端的进程测试（与系统无关的部分）。
//
// 真的把 wifimeter-backend 作为子进程拉起来，按协议用管道对话：进程、协议、SQLite 落库
// 与事件推送全都是真的，只有网卡数据来自测试文件（WIFIMETER_FAKE_ADAPTER /
// WIFIMETER_FAKE_COUNTERS），因此不碰真实网络，两端也跑同一份断言。
//
// 这里负责构造测试数据与断言；启动子进程、读写管道由各平台的 main 提供
// （backend_process_test.cpp / backend_process_win_test.cpp）。

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "../support/json.h"
#include "test_support.h"

namespace wifimeter::test
{

using support::JsonValue;

// 子进程接口：各平台实现“启动、写一行、读一行、等待退出”。
class ProcessRunner
{
public:
    virtual ~ProcessRunner() = default;

    // 启动后端；arguments 不含可执行文件本身。
    virtual bool start(const std::string& executable, const std::vector<std::string>& arguments, const std::vector<std::pair<std::string, std::string>>& environment) = 0;
    virtual bool send(const std::string& line) = 0;
    virtual std::optional<std::string> readLine(std::chrono::milliseconds timeout) = 0;
    virtual void closeInput() = 0;
    virtual std::optional<int> waitForExit(std::chrono::milliseconds timeout) = 0;
    virtual int wait() = 0;
};

// 测试用的网络与计数数据。
struct ProcessFixture
{
    TempDirectory directory{"backend-process"};
    std::string executable;
    std::string adapterFile;
    std::string countersFile;
    std::string database;

    explicit ProcessFixture(std::string binary)
        : executable(std::move(binary)),
          adapterFile(directory.file("adapter.json")),
          countersFile(directory.file("counters.json")),
          database(directory.file("meter.db"))
    {
        setNetwork("Habitat_5G", "21f995e7-fe3b-41a1-ae3a-6468c6918397");
        setCounters(5000000, 900000);
    }

    void setNetwork(const std::string& ssid, const std::string& profile)
    {
        // 两端共用同一份数据：配置名与 SSID 都由这里给出。
        // Windows 侧没有配置 UUID，网络键由 SSID 派生；Linux 侧用同一份数据也能跑通，
        // 因为 platform/network_platform.h 只要求 profileUuid 可选。
        writeFile(adapterFile,
            "{\"adapters\":[{\"name\":\"wlan0\",\"description\":\"AICSemi AIC8800DC\",\"connected\":true,"
            "\"mode\":0,\"profile\":\"" + profile + "\",\"ssid\":\"" + ssid + "\",\"signal\":82,\"frequency\":5180}]}");
    }

    void setDisconnected()
    {
        writeFile(adapterFile,
            "{\"adapters\":[{\"name\":\"wlan0\",\"description\":\"AICSemi AIC8800DC\",\"connected\":false,\"mode\":2}]}");
    }

    void setCounters(std::uint64_t rx, std::uint64_t tx) const
    {
        writeFile(countersFile,
            "{\"interfaces\":[{\"name\":\"wlan0\",\"rx\":" + std::to_string(rx) + ",\"tx\":" + std::to_string(tx) + "}]}");
    }

    // 测试数据用命令行参数传入：两端一致，且不必依赖 Windows 的子进程环境块
    // （实测把自定义环境块交给 CreateProcess 时子进程读不到变量）。
    std::vector<std::pair<std::string, std::string>> environment() const
    {
        return {};
    }

    std::vector<std::string> arguments() const
    {
        return {"--db", database, "--fake-adapter", adapterFile, "--fake-counters", countersFile};
    }
};

// 一条请求-响应会话：跳过事件，按 id 配对。
class Session
{
public:
    Session(ProcessRunner& runner, std::chrono::seconds timeout = std::chrono::seconds(20))
        : runner_(runner), timeout_(timeout)
    {}

    std::optional<JsonValue> request(long long id, const std::string& method, const std::string& paramsJson = "{}")
    {
        const std::string line = "{\"id\":" + std::to_string(id) + ",\"method\":\"" + method + "\",\"params\":" + paramsJson + "}";
        if (!runner_.send(line))
            return std::nullopt;

        const auto deadline = std::chrono::steady_clock::now() + timeout_;
        while (std::chrono::steady_clock::now() < deadline)
        {
            const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now());
            const auto text = runner_.readLine(remaining);
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
        return std::nullopt;
    }

    // 读取并记录当前可读的所有事件（响应之后推送的事件要靠它收上来）。
    void drainEvents(std::chrono::milliseconds quiet = std::chrono::milliseconds(500))
    {
        while (true)
        {
            const auto text = runner_.readLine(quiet);
            if (!text)
                return;
            std::string error;
            const auto parsed = JsonValue::parse(*text, error);
            if (parsed && parsed->find("event") != nullptr)
                events.push_back(*parsed);
        }
    }

    std::vector<JsonValue> events;

private:
    ProcessRunner& runner_;
    std::chrono::seconds timeout_;
};

// ---------------------------------------------------------------------------
// 用例。两个平台跑同一份断言。
// ---------------------------------------------------------------------------

inline void talksTheProtocol(ProcessRunner& runner, ProcessFixture& fixture)
{
    WIFIMETER_CHECK(runner.start(fixture.executable, fixture.arguments(), fixture.environment()));
    WIFIMETER_CHECK(runner.send(""));  // 空行应当被忽略

    Session session(runner);
    const auto hello = session.request(1, "hello");
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
    const auto unknown = session.request(2, "noSuchMethod");
    WIFIMETER_CHECK(unknown.has_value());
    if (unknown)
    {
        WIFIMETER_CHECK(!unknown->boolOr("ok"));
        const JsonValue* error = unknown->find("error");
        WIFIMETER_CHECK(error != nullptr);
        if (error != nullptr)
            WIFIMETER_CHECK_EQ(error->stringOr("code"), std::string("unknownMethod"));
    }

    // 坏 JSON 也要回错误而不是让进程崩掉。
    WIFIMETER_CHECK(runner.send("{not json"));
    const auto garbage = runner.readLine(std::chrono::seconds(10));
    WIFIMETER_CHECK(garbage.has_value());
    if (garbage)
        WIFIMETER_CHECK(garbage->find("\"ok\":false") != std::string::npos);

    // 进程还活着，继续正常服务。
    WIFIMETER_CHECK(session.request(3, "hello").has_value());
    WIFIMETER_CHECK(session.request(4, "shutdown").has_value());
    WIFIMETER_CHECK_EQ(runner.wait(), 0);
}

inline void collectsAndStoresUsage(ProcessRunner& runner, ProcessFixture& fixture)
{
    WIFIMETER_CHECK(runner.start(fixture.executable, fixture.arguments(), fixture.environment()));
    Session session(runner);

    // 第一次采集只建立基线。
    WIFIMETER_CHECK(session.request(1, "collectNow").has_value());
    fixture.setCounters(8100000, 1400000);
    WIFIMETER_CHECK(session.request(2, "collectNow").has_value());
    session.drainEvents();

    // 第二次采集应当推送用量事件，数值正好是两次计数之差。
    bool sawUsage = false;
    for (const JsonValue& event : session.events)
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
    const auto snapshot = session.request(3, "snapshot");
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
                const JsonValue* ledger = networks->at(0).find("quotaLedger");
                WIFIMETER_CHECK(ledger != nullptr);
                if (ledger != nullptr)
                    WIFIMETER_CHECK_EQ(ledger->stringOr("usedBytes"), std::string("3600000"));
            }

            const JsonValue* live = result->find("live");
            WIFIMETER_CHECK(live != nullptr);
            if (live != nullptr)
            {
                WIFIMETER_CHECK_EQ(live->stringOr("state"), std::string("connected"));
                const JsonValue* connections = live->find("connections");
                WIFIMETER_CHECK(connections != nullptr && connections->size() == 1);
                if (connections != nullptr && connections->size() == 1)
                {
                    // 采集层给出的展示名与频段要一路传到快照。
                    WIFIMETER_CHECK_EQ(connections->at(0).stringOr("adapterAlias"), std::string("AICSemi AIC8800DC"));
                    WIFIMETER_CHECK_EQ(connections->at(0).stringOr("band"), std::string("5 GHz"));
                }
            }
        }
    }

    WIFIMETER_CHECK(session.request(4, "shutdown").has_value());
    WIFIMETER_CHECK_EQ(runner.wait(), 0);
}

inline void persistsAcrossRestart(ProcessRunner& runner, ProcessFixture& fixture)
{
    {
        WIFIMETER_CHECK(runner.start(fixture.executable, fixture.arguments(), fixture.environment()));
        Session session(runner);
        WIFIMETER_CHECK(session.request(1, "collectNow").has_value());
        fixture.setCounters(6000000, 1000000);
        WIFIMETER_CHECK(session.request(2, "collectNow").has_value());
        WIFIMETER_CHECK(session.request(3, "shutdown").has_value());
        WIFIMETER_CHECK_EQ(runner.wait(), 0);
    }

    // 重开一个进程读同一个数据库：之前的记录必须还在。
    WIFIMETER_CHECK(runner.start(fixture.executable, fixture.arguments(), fixture.environment()));
    Session session(runner);
    const auto snapshot = session.request(1, "snapshot", "{\"from\":\"2020-01-01\",\"to\":\"2030-01-01\"}");
    WIFIMETER_CHECK(snapshot.has_value());
    if (snapshot)
    {
        const JsonValue* result = snapshot->find("result");
        const JsonValue* records = result == nullptr ? nullptr : result->find("records");
        WIFIMETER_CHECK(records != nullptr && records->size() == 1);
        if (records != nullptr && records->size() == 1)
            WIFIMETER_CHECK_EQ(records->at(0).stringOr("rxBytes"), std::string("1000000"));
    }
    WIFIMETER_CHECK(session.request(2, "shutdown").has_value());
    WIFIMETER_CHECK_EQ(runner.wait(), 0);
}

inline void handlesDisconnectedAndReconnected(ProcessRunner& runner, ProcessFixture& fixture)
{
    WIFIMETER_CHECK(runner.start(fixture.executable, fixture.arguments(), fixture.environment()));
    Session session(runner);

    // 断开 Wi-Fi：状态要变成 disconnected，且不产生样本（未关联不是错误）。
    fixture.setDisconnected();
    WIFIMETER_CHECK(session.request(1, "collectNow").has_value());
    const auto offline = session.request(2, "snapshot");
    WIFIMETER_CHECK(offline.has_value());
    if (offline)
    {
        const JsonValue* live = offline->find("result")->find("live");
        WIFIMETER_CHECK(live != nullptr);
        if (live != nullptr)
        {
            WIFIMETER_CHECK_EQ(live->stringOr("state"), std::string("disconnected"));
            WIFIMETER_CHECK_EQ(live->stringOr("collector"), std::string("running"));
        }
    }

    // 重新连上：从新的基线开始，之前的记录不被破坏。
    fixture.setNetwork("Habitat_5G", "21f995e7-fe3b-41a1-ae3a-6468c6918397");
    fixture.setCounters(9000000, 1500000);
    WIFIMETER_CHECK(session.request(3, "collectNow").has_value());
    fixture.setCounters(9100000, 1600000);
    WIFIMETER_CHECK(session.request(4, "collectNow").has_value());
    session.drainEvents();

    const auto back = session.request(5, "snapshot");
    WIFIMETER_CHECK(back.has_value());
    if (back)
    {
        const JsonValue* live = back->find("result")->find("live");
        WIFIMETER_CHECK(live != nullptr);
        if (live != nullptr)
            WIFIMETER_CHECK_EQ(live->stringOr("state"), std::string("connected"));
    }

    WIFIMETER_CHECK(session.request(6, "shutdown").has_value());
    WIFIMETER_CHECK_EQ(runner.wait(), 0);
}

inline void updatesSettingsThroughTheProcess(ProcessRunner& runner, ProcessFixture& fixture)
{
    WIFIMETER_CHECK(runner.start(fixture.executable, fixture.arguments(), fixture.environment()));
    Session session(runner);

    const auto updated = session.request(1, "updateSettings", R"({"settings":{"unit":"GiB","interval":10,"retention":365}})");
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

    const auto snapshot = session.request(2, "snapshot");
    WIFIMETER_CHECK(snapshot.has_value());
    if (snapshot)
        WIFIMETER_CHECK_EQ(snapshot->find("result")->find("settings")->stringOr("unit"), std::string("GiB"));

    WIFIMETER_CHECK(session.request(3, "shutdown").has_value());
    WIFIMETER_CHECK_EQ(runner.wait(), 0);
}

inline void exitsCleanlyWhenInputCloses(ProcessRunner& runner, ProcessFixture& fixture)
{
    WIFIMETER_CHECK(runner.start(fixture.executable, fixture.arguments(), fixture.environment()));
    Session session(runner);
    WIFIMETER_CHECK(session.request(1, "hello").has_value());

    // 不发 shutdown，直接关闭输入：应当正常退出（而不是挂住或被信号杀死）。
    runner.closeInput();
    const auto code = runner.waitForExit(std::chrono::seconds(10));
    WIFIMETER_CHECK(code.has_value());
    if (code)
        WIFIMETER_CHECK_EQ(*code, 0);
}

// 两个平台共用的入口：各自的 main 只需要提供 ProcessRunner 实现。
inline int runAllProcessTests(ProcessRunner& runner, const std::string& executable)
{
    ProcessFixture fixture(executable);
    talksTheProtocol(runner, fixture);

    ProcessFixture usage(executable);
    collectsAndStoresUsage(runner, usage);

    ProcessFixture restart(executable);
    persistsAcrossRestart(runner, restart);

    ProcessFixture reconnect(executable);
    handlesDisconnectedAndReconnected(runner, reconnect);

    ProcessFixture settings(executable);
    updatesSettingsThroughTheProcess(runner, settings);

    ProcessFixture closing(executable);
    exitsCleanlyWhenInputCloses(runner, closing);

    return WIFIMETER_REPORT();
}

}  // namespace wifimeter::test
