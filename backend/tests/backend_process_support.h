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
#include <cstdlib>
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
    //
    // 这里收集**所有**增量事件再断言，而不是只看第一条：采集会同时产生 live 与 usage
    // 事件，出现顺序与时序有关，只认第一条会在两端表现不一致（Windows 上就出现过
    // 一条 0 增量的 usage 事件在前，导致断言读到 0）。
    WIFIMETER_CHECK(!session.events.empty());
    std::uint64_t totalRx = 0;
    std::uint64_t totalTx = 0;
    bool sawUsage = false;
    for (const JsonValue& event : session.events)
    {
        if (event.stringOr("event") != "usage")
            continue;
        const JsonValue* networks = event.find("networks");
        if (networks == nullptr || networks->size() != 1)
            continue;
        sawUsage = true;
        totalRx += std::strtoull(networks->at(0).stringOr("rxBytes", "0").c_str(), nullptr, 10);
        totalTx += std::strtoull(networks->at(0).stringOr("txBytes", "0").c_str(), nullptr, 10);

        // 增量里必须带上网络记录：首次见到某个网络时（新装的应用、换了新 Wi-Fi），
        // 界面的快照里还没有它，只推增量的话用量归属不到名字上，会出现
        // “未识别网络”且用量一直是 0，要重启应用才恢复。
        const JsonValue* network = networks->at(0).find("network");
        WIFIMETER_CHECK(network != nullptr);
        if (network != nullptr)
        {
            WIFIMETER_CHECK_EQ(network->stringOr("ssid"), std::string("Habitat_5G"));
            WIFIMETER_CHECK_EQ(network->stringOr("id"), std::string("ssid_bd012343c1e1410d"));
            WIFIMETER_CHECK(network->find("quotaLedger") != nullptr);
        }
    }
    WIFIMETER_CHECK_EQ(totalRx, std::uint64_t(3100000));
    WIFIMETER_CHECK_EQ(totalTx, std::uint64_t(500000));    WIFIMETER_CHECK(sawUsage);

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

// 切换网络：换到另一个 SSID 之后，用量必须归到新网络，旧网络不再增长。
//
// 这一条对应验收清单里“连接另一个 Wi-Fi”的手工项。网络键由 SSID 派生，因此这里
// 用假适配器换 SSID 就能走完整条链路：身份变化 → 新网络入库 → 用量归属。
inline void attributesUsageToTheNewNetworkAfterSwitching(ProcessRunner& runner, ProcessFixture& fixture)
{
    WIFIMETER_CHECK(runner.start(fixture.executable, fixture.arguments(), fixture.environment()));
    Session session(runner);

    // 第一个网络：建立基线再产生 1 MB。
    WIFIMETER_CHECK(session.request(1, "collectNow").has_value());
    fixture.setCounters(6000000, 1000000);
    WIFIMETER_CHECK(session.request(2, "collectNow").has_value());
    session.drainEvents();

    const auto first = session.request(3, "snapshot");
    WIFIMETER_CHECK(first.has_value());
    std::string firstKey;
    if (first && first->find("result") != nullptr)
    {
        const JsonValue* networks = first->find("result")->find("networks");
        if (networks != nullptr && networks->size() == 1)
            firstKey = networks->at(0).stringOr("id");
    }
    WIFIMETER_CHECK(!firstKey.empty());

    // 切换到第二个网络：身份变了，旧网卡的计数差值应当被丢弃而不是记到新网络上。
    fixture.setNetwork("Cafe_Guest", "6c1f0f2e-1111-2222-3333-444455556666");
    fixture.setCounters(20000000, 3000000);
    WIFIMETER_CHECK(session.request(4, "collectNow").has_value());
    session.drainEvents();

    // 第二次采集：在同一个身份上再产生 500 KB，才能形成新网络的用量。
    fixture.setCounters(25000000, 3500000);
    WIFIMETER_CHECK(session.request(5, "collectNow").has_value());
    session.drainEvents();

    const auto second = session.request(6, "snapshot");
    WIFIMETER_CHECK(second.has_value());
    if (second && second->find("result") != nullptr)
    {
        const JsonValue* result = second->find("result");
        const JsonValue* networks = result->find("networks");
        WIFIMETER_CHECK(networks != nullptr && networks->size() == 2);

        // 当前连接应当是新的那个网络。
        const JsonValue* connections = result->find("live")->find("connections");
        WIFIMETER_CHECK(connections != nullptr && connections->size() == 1);

        const JsonValue* records = result->find("records");
        WIFIMETER_CHECK(records != nullptr);
        if (records != nullptr)
        {
            for (std::size_t index = 0; index < records->size(); ++index)
            {
                const JsonValue& row = records->at(index);
                const std::string key = row.stringOr("networkId");
                if (key == firstKey)
                {
                    // 旧网络：只有第一次的 1 MB，切换时那个大差值不该记进来。
                    WIFIMETER_CHECK_EQ(row.stringOr("rxBytes"), std::string("1000000"));
                    WIFIMETER_CHECK_EQ(row.stringOr("txBytes"), std::string("100000"));
                }
                else
                {
                    // 新网络：切换后的第一次采样只建立基线，第二次才形成增量。
                    WIFIMETER_CHECK_EQ(row.stringOr("rxBytes"), std::string("5000000"));
                    WIFIMETER_CHECK_EQ(row.stringOr("txBytes"), std::string("500000"));
                }
            }
        }
    }

    WIFIMETER_CHECK(session.request(7, "shutdown").has_value());
    WIFIMETER_CHECK_EQ(runner.wait(), 0);
}

// 后端必须**自己**按间隔采样，而不是只在被要求时（collectNow）才采。
//
// 这条用例是补上来的：真机上安装后界面一直显示“尚未连接 Wi-Fi”，原因是 Windows 的
// 事件循环把“stdin 有数据”判断错了——管道句柄对可读永远是 signaled，等待永远立刻返回，
// 于是循环走不到“到点采样”的分支，从不自动采样；界面就停在启动时的初始快照。
// 之前的端到端用例每一步都显式调用 collectNow，因此完全覆盖不到这条路径。
inline void samplesOnItsOwnSchedule(ProcessRunner& runner, ProcessFixture& fixture)
{
    WIFIMETER_CHECK(runner.start(fixture.executable, fixture.arguments(), fixture.environment()));
    Session session(runner, std::chrono::seconds(30));

    // 只握手，不做任何触发采样的事。
    WIFIMETER_CHECK(session.request(1, "hello").has_value());

    // 采样间隔是 5 秒；等一轮多一点，期间必须自己推送 live 事件。
    // session.events 由 drainEvents 填充，因此这里直接查它。
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(14);
    bool sawLive = false;
    while (!sawLive && std::chrono::steady_clock::now() < deadline)
    {
        session.drainEvents(std::chrono::milliseconds(1500));
        for (const JsonValue& event : session.events)
        {
            if (event.stringOr("event") == "live")
            {
                sawLive = true;
                break;
            }
        }
    }
    WIFIMETER_CHECK(sawLive);

    // 而且这次自动采样确实采到了数据：状态是已知取值，注入的假网卡必须出现。
    const auto snapshot = session.request(2, "snapshot");
    WIFIMETER_CHECK(snapshot.has_value());
    if (snapshot && snapshot->find("result") != nullptr)
    {
        const JsonValue* live = snapshot->find("result")->find("live");
        WIFIMETER_CHECK(live != nullptr);
        if (live != nullptr)
        {
            WIFIMETER_CHECK_EQ(live->stringOr("state"), std::string("connected"));
            const JsonValue* connections = live->find("connections");
            WIFIMETER_CHECK(connections != nullptr && connections->size() == 1);
            if (connections != nullptr && connections->size() == 1)
            {
                // 连接条目按网卡给出身份：网卡名与网络键必须来自注入的假网卡。
                WIFIMETER_CHECK_EQ(connections->at(0).stringOr("interfaceId"), std::string("wlan0"));
                WIFIMETER_CHECK(!connections->at(0).stringOr("networkId").empty());
                WIFIMETER_CHECK_EQ(connections->at(0).stringOr("band"), std::string("5 GHz"));
            }
        }
    }

    WIFIMETER_CHECK(session.request(3, "shutdown").has_value());
    WIFIMETER_CHECK_EQ(runner.wait(), 0);
}

// 完整备份 → 清空 → 恢复：备份是界面「完整备份」用的格式，
// 两端都要能原样往返（含中文备注、额度、小时明细与覆盖空档）。
inline void exportsAndRestoresABackup(ProcessRunner& runner, ProcessFixture& fixture)
{
    WIFIMETER_CHECK(runner.start(fixture.executable, fixture.arguments(), fixture.environment()));
    Session session(runner);

    // 先造出一点可备份的数据：一轮基线 + 一轮增量，再改一个中文备注与额度。
    WIFIMETER_CHECK(session.request(1, "collectNow").has_value());
    fixture.setCounters(9500000, 1800000);
    WIFIMETER_CHECK(session.request(2, "collectNow").has_value());

    const auto snapshot = session.request(3, "snapshot");
    WIFIMETER_CHECK(snapshot.has_value());
    std::string networkKey;
    if (snapshot && snapshot->find("result") != nullptr)
    {
        const JsonValue* networks = snapshot->find("result")->find("networks");
        if (networks != nullptr && networks->size() == 1)
            networkKey = networks->at(0).stringOr("id");
    }
    WIFIMETER_CHECK(!networkKey.empty());

    // 参数是平铺的：{key, alias, capGb, warnPercent, ...}，没有 patch 包装。
    const std::string update = "{\"key\":\"" + networkKey + "\",\"alias\":\"家里的 Wi-Fi\",\"capGb\":2.5,\"warnPercent\":80}";
    const auto updated = session.request(4, "updateNetwork", update);
    WIFIMETER_CHECK(updated.has_value());

    // 取备份。
    const auto backup = session.request(5, "backup");
    WIFIMETER_CHECK(backup.has_value());
    std::string backupJson;
    if (backup && backup->find("result") != nullptr)
    {
        const JsonValue* document = backup->find("result")->find("backup");
        WIFIMETER_CHECK(document != nullptr);
        if (document != nullptr)
        {
            WIFIMETER_CHECK_EQ(document->stringOr("backupType"), std::string("wifimeter-backend-backup"));
            const JsonValue* records = document->find("records");
            WIFIMETER_CHECK(records != nullptr && records->size() == 1);
            if (records != nullptr && records->size() == 1)
            {
                WIFIMETER_CHECK_EQ(records->at(0).stringOr("rxBytes"), std::string("4500000"));
                WIFIMETER_CHECK_EQ(records->at(0).stringOr("txBytes"), std::string("900000"));
            }
            const JsonValue* networks = document->find("networks");
            WIFIMETER_CHECK(networks != nullptr && networks->size() == 1);
            if (networks != nullptr && networks->size() == 1)
            {
                // 中文备注必须原样出现在备份里（UTF-8 一路到文件）。
                WIFIMETER_CHECK_EQ(networks->at(0).stringOr("alias"), std::string("家里的 Wi-Fi"));
                WIFIMETER_CHECK_EQ(networks->at(0).doubleOr("capGb"), 2.5);
            }
            backupJson = document->dump();
        }
    }
    WIFIMETER_CHECK(!backupJson.empty());

    // 清空记录，确认真的空了。
    WIFIMETER_CHECK(session.request(6, "clearUsage").has_value());
    const auto cleared = session.request(7, "snapshot");
    WIFIMETER_CHECK(cleared.has_value());
    if (cleared && cleared->find("result") != nullptr)
    {
        const JsonValue* records = cleared->find("result")->find("records");
        WIFIMETER_CHECK(records != nullptr && records->size() == 0);
    }

    // 恢复：记录与备注都要回来。
    const auto restored = session.request(8, "restore", "{\"backup\":" + backupJson + "}");
    WIFIMETER_CHECK(restored.has_value());
    if (restored)
        WIFIMETER_CHECK(restored->boolOr("ok"));

    const auto after = session.request(9, "snapshot");
    WIFIMETER_CHECK(after.has_value());
    if (after && after->find("result") != nullptr)
    {
        const JsonValue* result = after->find("result");
        const JsonValue* records = result->find("records");
        WIFIMETER_CHECK(records != nullptr && records->size() == 1);
        if (records != nullptr && records->size() == 1)
        {
            WIFIMETER_CHECK_EQ(records->at(0).stringOr("rxBytes"), std::string("4500000"));
            WIFIMETER_CHECK_EQ(records->at(0).stringOr("txBytes"), std::string("900000"));
        }
        const JsonValue* networks = result->find("networks");
        WIFIMETER_CHECK(networks != nullptr && networks->size() == 1);
        if (networks != nullptr && networks->size() == 1)
        {
            WIFIMETER_CHECK_EQ(networks->at(0).stringOr("alias"), std::string("家里的 Wi-Fi"));
            WIFIMETER_CHECK_EQ(networks->at(0).doubleOr("capGb"), 2.5);
        }
    }

    WIFIMETER_CHECK(session.request(10, "shutdown").has_value());
    WIFIMETER_CHECK_EQ(runner.wait(), 0);
}

// 流量导出：界面「导出数据」用的路径，要能在给定区间与网络范围内给出记录，
// 并且带上 SSID 与备注（表格里要显示可读的网络名）。
inline void exportsUsageRecords(ProcessRunner& runner, ProcessFixture& fixture)
{
    WIFIMETER_CHECK(runner.start(fixture.executable, fixture.arguments(), fixture.environment()));
    Session session(runner);

    // 一轮基线 + 一轮增量。
    WIFIMETER_CHECK(session.request(1, "collectNow").has_value());
    fixture.setCounters(7000000, 1200000);
    WIFIMETER_CHECK(session.request(2, "collectNow").has_value());
    session.drainEvents();

    // 先取网络键与今天，便于按区间查询。
    std::string networkKey;
    std::string today;
    const auto snapshot = session.request(3, "snapshot");
    if (snapshot && snapshot->find("result") != nullptr)
    {
        const JsonValue* result = snapshot->find("result");
        const JsonValue* networks = result->find("networks");
        if (networks != nullptr && networks->size() == 1)
            networkKey = networks->at(0).stringOr("id");
        const JsonValue* range = result->find("range");
        if (range != nullptr)
            today = range->stringOr("to");
    }
    WIFIMETER_CHECK(!networkKey.empty());
    WIFIMETER_CHECK(!today.empty());

    // 给网络起个中文备注，导出里应当带上它。
    WIFIMETER_CHECK(session.request(4, "updateNetwork", "{\"key\":\"" + networkKey + "\",\"alias\":\"书房 Wi-Fi\"}").has_value());

    // 默认区间（近一年）导出。
    const auto exported = session.request(5, "exportUsage", "{}");
    WIFIMETER_CHECK(exported.has_value());
    if (exported && exported->find("result") != nullptr)
    {
        const JsonValue* result = exported->find("result");
        const JsonValue* records = result->find("records");
        WIFIMETER_CHECK(records != nullptr && records->size() == 1);
        if (records != nullptr && records->size() == 1)
        {
            const JsonValue& entry = records->at(0);
            WIFIMETER_CHECK_EQ(entry.stringOr("networkId"), networkKey);
            WIFIMETER_CHECK_EQ(entry.stringOr("ssid"), std::string("Habitat_5G"));
            WIFIMETER_CHECK_EQ(entry.stringOr("alias"), std::string("书房 Wi-Fi"));
            WIFIMETER_CHECK_EQ(entry.stringOr("rxBytes"), std::string("2000000"));
            WIFIMETER_CHECK_EQ(entry.stringOr("txBytes"), std::string("300000"));
            WIFIMETER_CHECK_EQ(entry.stringOr("date"), today);
        }
    }

    // 按网络范围过滤：换一个不存在的键应当没有记录。
    const auto filtered = session.request(6, "exportUsage", R"({"networkKey":"ssid_does_not_exist"})");
    WIFIMETER_CHECK(filtered.has_value());
    if (filtered && filtered->find("result") != nullptr)
    {
        const JsonValue* records = filtered->find("result")->find("records");
        WIFIMETER_CHECK(records != nullptr && records->size() == 0);
    }

    // 区间之外（过去的一天）也应当为空，而不是把数据算进来。
    const auto outside = session.request(7, "exportUsage", R"({"from":"2020-01-01","to":"2020-01-02"})");
    WIFIMETER_CHECK(outside.has_value());
    if (outside && outside->find("result") != nullptr)
    {
        const JsonValue* records = outside->find("result")->find("records");
        WIFIMETER_CHECK(records != nullptr && records->size() == 0);
    }

    WIFIMETER_CHECK(session.request(8, "shutdown").has_value());
    WIFIMETER_CHECK_EQ(runner.wait(), 0);
}

// 备份文件的标记不对时必须拒绝，而不是把流量导出当成完整备份写进去。
inline void refusesAForeignBackup(ProcessRunner& runner, ProcessFixture& fixture)
{
    WIFIMETER_CHECK(runner.start(fixture.executable, fixture.arguments(), fixture.environment()));
    Session session(runner);

    const auto rejected = session.request(1, "restore", R"({"backup":{"backupType":"usage-export","records":[]}})");
    WIFIMETER_CHECK(rejected.has_value());
    if (rejected)
    {
        WIFIMETER_CHECK(!rejected->boolOr("ok"));
        const JsonValue* error = rejected->find("error");
        WIFIMETER_CHECK(error != nullptr);
        if (error != nullptr)
            WIFIMETER_CHECK_EQ(error->stringOr("code"), std::string("invalidParams"));
    }

    WIFIMETER_CHECK(session.request(2, "shutdown").has_value());
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

    ProcessFixture backup(executable);
    exportsAndRestoresABackup(runner, backup);

    ProcessFixture foreign(executable);
    refusesAForeignBackup(runner, foreign);

    ProcessFixture exportFixture(executable);
    exportsUsageRecords(runner, exportFixture);

    ProcessFixture schedule(executable);
    samplesOnItsOwnSchedule(runner, schedule);

    ProcessFixture switching(executable);
    attributesUsageToTheNewNetworkAfterSwitching(runner, switching);

    return WIFIMETER_REPORT();
}

}  // namespace wifimeter::test
