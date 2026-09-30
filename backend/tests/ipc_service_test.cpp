// 服务层测试：用假的平台实现覆盖每个协议方法，不碰真实系统也不碰真实网络。

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "../ipc/service.h"
#include "../storage/store.h"
#include "test_support.h"

using namespace wifimeter::core;
using namespace wifimeter::ipc;
using namespace wifimeter::storage;
using wifimeter::test::TempDirectory;
using wifimeter::test::utcTime;

namespace platform = wifimeter::platform;
using JsonValue = wifimeter::support::JsonValue;
using Response = BackendService::Response;

namespace
{

// 假的平台实现：想要什么状态就填什么状态。
class FakePlatform : public platform::NetworkPlatform
{
public:
    platform::LinkReport linkReport;
    platform::SampleReport sampleReport;
    platform::DisconnectReport disconnectReport;

    int sampleCount = 0;
    int disconnectCount = 0;
    std::string lastInterface;
    std::string lastSsid;

    platform::LinkReport wirelessLinks() override
    {
        return linkReport;
    }

    platform::SampleReport sampleWifi() override
    {
        ++sampleCount;
        return sampleReport;
    }

    platform::DisconnectReport disconnectIfAssociated(const std::string& interfaceId, const std::string& expectedSsid) override
    {
        ++disconnectCount;
        lastInterface = interfaceId;
        lastSsid = expectedSsid;
        return disconnectReport;
    }
};

platform::WifiLink makeLink(const std::string& interfaceId, const std::string& uuid, const std::string& ssid, int signal = 80)
{
    platform::WifiLink link;
    link.interfaceId = interfaceId;
    link.adapterAlias = "AICSemi AIC8800DC";
    link.identity.profileUuid = uuid;
    link.identity.profileName = ssid;
    link.identity.ssid = ssid;
    link.signalPercent = signal;
    link.frequencyMhz = 5180;
    link.band = platform::classifyBand(5180);
    return link;
}

platform::WifiSample makeSample(const std::string& interfaceId, const std::string& uuid, const std::string& ssid, ByteCount rx, ByteCount tx)
{
    platform::WifiSample sample;
    sample.interfaceId = interfaceId;
    sample.identity.profileUuid = uuid;
    sample.identity.ssid = ssid;
    sample.rxBytes = rx;
    sample.txBytes = tx;
    return sample;
}

struct Harness
{
    TempDirectory directory{"service"};
    std::unique_ptr<Store> store;
    FakePlatform network;
    std::unique_ptr<BackendService> service;

    explicit Harness(bool paused = false)
    {
        Status status;
        store = Store::open(directory.file("meter.db"), status);
        if (store)
            service = std::make_unique<BackendService>(BackendService::Deps{*store, network}, paused);
    }

    Response call(const std::string& method, const JsonValue& params, TimePoint now)
    {
        Request request;
        request.hasId = true;
        request.id = 1;
        request.method = method;
        request.params = params;
        return service->handle(request, now);
    }

    Response call(const std::string& method, TimePoint now)
    {
        return call(method, JsonValue::makeObject(), now);
    }
};

const std::string kUuid = "21f995e7-fe3b-41a1-ae3a-6468c6918397";

void reportsHello()
{
    Harness harness;
    WIFIMETER_CHECK(harness.service != nullptr);
    if (!harness.service)
        return;

    const Response response = harness.call(method::kHello, utcTime(2026, 9, 29, 10, 0, 0));
    WIFIMETER_CHECK(response.ok());
    WIFIMETER_CHECK_EQ(response.result.intOr("protocol"), std::int64_t{kProtocolVersion});
    WIFIMETER_CHECK_EQ(response.result.stringOr("application"), std::string("wifimeter-backend"));
    WIFIMETER_CHECK_EQ(response.result.intOr("intervalSeconds"), std::int64_t{5});
    WIFIMETER_CHECK(!response.result.boolOr("paused"));
}

void rejectsUnknownMethods()
{
    Harness harness;
    if (!harness.service)
        return;
    const Response response = harness.call("nonsense", utcTime(2026, 9, 29, 10, 0, 0));
    WIFIMETER_CHECK(!response.ok());
    WIFIMETER_CHECK_EQ(response.error.code, std::string(errorCode::kUnknownMethod));
}

void collectsUsageAndEmitsEvents()
{
    wifimeter::test::useTimeZone("UTC");
    Harness harness;
    if (!harness.service)
        return;

    const auto at = utcTime(2026, 9, 29, 10, 0, 0);
    harness.network.sampleReport.samples.push_back(makeSample("wlan0", kUuid, "Habitat_5G", 1000, 2000));
    harness.network.sampleReport.links.push_back(makeLink("wlan0", kUuid, "Habitat_5G"));

    // 第一次采样只建立基线：没有增量，也就没有记录。
    const BackendService::Events first = harness.service->collectOnce(at);
    WIFIMETER_CHECK(first.error.code.empty());
    WIFIMETER_CHECK_EQ(harness.network.sampleCount, 1);

    harness.network.sampleReport.samples[0].rxBytes = 5000;
    harness.network.sampleReport.samples[0].txBytes = 3000;
    const BackendService::Events second = harness.service->collectOnce(at + std::chrono::seconds(5));
    WIFIMETER_CHECK(second.error.code.empty());
    // 推送 live 与 usage 两类事件。
    WIFIMETER_CHECK_EQ(second.names.size(), std::size_t{2});
    if (second.names.size() == 2)
    {
        WIFIMETER_CHECK_EQ(second.names[0], std::string(event::kUsage));
        WIFIMETER_CHECK_EQ(second.names[1], std::string(event::kLive));
        const JsonValue& networks = *second.items[0].find("networks");
        WIFIMETER_CHECK_EQ(networks.size(), std::size_t{1});
        if (networks.size() == 1)
        {
            WIFIMETER_CHECK_EQ(networks.at(0).stringOr("networkId"), kUuid);
            WIFIMETER_CHECK_EQ(networks.at(0).stringOr("rxBytes"), std::string("4000"));
            WIFIMETER_CHECK_EQ(networks.at(0).stringOr("txBytes"), std::string("1000"));
        }
    }

    // 落库结果可以从快照里读回来。
    const Response snapshot = harness.call(method::kSnapshot, at + std::chrono::seconds(5));
    WIFIMETER_CHECK(snapshot.ok());
    const JsonValue* records = snapshot.result.find("records");
    WIFIMETER_CHECK(records != nullptr && records->size() == 1);
    if (records != nullptr && records->size() == 1)
    {
        WIFIMETER_CHECK_EQ(records->at(0).stringOr("rxBytes"), std::string("4000"));
        WIFIMETER_CHECK_EQ(records->at(0).stringOr("txBytes"), std::string("1000"));
        WIFIMETER_CHECK_EQ(records->at(0).stringOr("date"), std::string("2026-09-29"));
    }
    const JsonValue* networks = snapshot.result.find("networks");
    WIFIMETER_CHECK(networks != nullptr && networks->size() == 1);
    if (networks != nullptr && networks->size() == 1)
    {
        const JsonValue* ledger = networks->at(0).find("quotaLedger");
        WIFIMETER_CHECK(ledger != nullptr);
        if (ledger != nullptr)
        {
            WIFIMETER_CHECK_EQ(ledger->stringOr("usedBytes"), std::string("5000"));
            WIFIMETER_CHECK_EQ(ledger->stringOr("periodKey"), std::string("2026-09"));
        }
    }
}

void reportsLiveConnectionState()
{
    wifimeter::test::useTimeZone("UTC");
    Harness harness;
    if (!harness.service)
        return;

    const auto at = utcTime(2026, 9, 29, 10, 0, 0);
    harness.network.sampleReport.links.push_back(makeLink("wlan0", kUuid, "Habitat_5G", 82));
    harness.network.sampleReport.samples.push_back(makeSample("wlan0", kUuid, "Habitat_5G", 1000, 1000));
    harness.service->collectOnce(at);

    const Response snapshot = harness.call(method::kSnapshot, at);
    WIFIMETER_CHECK(snapshot.ok());
    const JsonValue* live = snapshot.result.find("live");
    WIFIMETER_CHECK(live != nullptr);
    if (live == nullptr)
        return;
    WIFIMETER_CHECK_EQ(live->stringOr("state"), std::string("connected"));
    WIFIMETER_CHECK_EQ(live->stringOr("collector"), std::string("running"));

    const JsonValue* connections = live->find("connections");
    WIFIMETER_CHECK(connections != nullptr && connections->size() == 1);
    if (connections != nullptr && connections->size() == 1)
    {
        WIFIMETER_CHECK_EQ(connections->at(0).stringOr("networkId"), kUuid);
        WIFIMETER_CHECK_EQ(connections->at(0).stringOr("interfaceId"), std::string("wlan0"));
        WIFIMETER_CHECK_EQ(connections->at(0).stringOr("adapterAlias"), std::string("AICSemi AIC8800DC"));
        WIFIMETER_CHECK_EQ(connections->at(0).stringOr("band"), std::string("5 GHz"));
        WIFIMETER_CHECK_EQ(connections->at(0).intOr("signal"), std::int64_t{82});
        WIFIMETER_CHECK_EQ(connections->at(0).stringOr("since"), std::string("2026-09-29T10:00:00Z"));
        // 第一次采样没有增量，速率按 0 上报。
        WIFIMETER_CHECK_EQ(connections->at(0).stringOr("rxPerSecond"), std::string("0"));
    }

    // 掉线后状态要变成 disconnected，连接列表清空。
    harness.network.sampleReport.links.clear();
    harness.network.sampleReport.samples.clear();
    harness.service->collectOnce(at + std::chrono::seconds(5));
    const Response afterSnapshot = harness.call(method::kSnapshot, at + std::chrono::seconds(5));
    const JsonValue* liveAfter = afterSnapshot.result.find("live");
    WIFIMETER_CHECK(liveAfter != nullptr);
    if (liveAfter != nullptr)
    {
        WIFIMETER_CHECK_EQ(liveAfter->stringOr("state"), std::string("disconnected"));
        WIFIMETER_CHECK_EQ(liveAfter->find("connections")->size(), std::size_t{0});
    }
}

void reportsRatesFromDeltas()
{
    wifimeter::test::useTimeZone("UTC");
    Harness harness;
    if (!harness.service)
        return;

    const auto at = utcTime(2026, 9, 29, 10, 0, 0);
    harness.network.sampleReport.samples.push_back(makeSample("wlan0", kUuid, "Habitat_5G", 0, 0));
    harness.network.sampleReport.links.push_back(makeLink("wlan0", kUuid, "Habitat_5G"));
    harness.service->collectOnce(at);

    // 5 秒内收 10 MB：速率应当是 2 MB/s。
    harness.network.sampleReport.samples[0].rxBytes = 10000000;
    harness.network.sampleReport.samples[0].txBytes = 0;
    harness.service->collectOnce(at + std::chrono::seconds(5));

    const Response snapshot = harness.call(method::kSnapshot, at + std::chrono::seconds(5));
    const JsonValue* live = snapshot.result.find("live");
    WIFIMETER_CHECK(live != nullptr);
    if (live != nullptr)
    {
        const JsonValue* connections = live->find("connections");
        WIFIMETER_CHECK(connections != nullptr && connections->size() == 1);
        if (connections != nullptr && connections->size() == 1)
            WIFIMETER_CHECK_EQ(connections->at(0).stringOr("rxPerSecond"), std::string("2000000"));
    }
}

void pauseStopsCollectionAndRecordsAGap()
{
    wifimeter::test::useTimeZone("UTC");
    Harness harness;
    if (!harness.service)
        return;

    const auto at = utcTime(2026, 9, 29, 10, 0, 0);
    harness.network.sampleReport.samples.push_back(makeSample("wlan0", kUuid, "Habitat_5G", 100, 100));
    harness.service->collectOnce(at);

    const Response paused = harness.call(method::kSetPaused, [&] {
        JsonValue params = JsonValue::makeObject();
        params.set("paused", JsonValue::makeBool(true));
        return params;
    }(), at + std::chrono::seconds(5));
    WIFIMETER_CHECK(paused.ok());
    WIFIMETER_CHECK(paused.result.boolOr("paused"));
    WIFIMETER_CHECK(harness.service->paused());

    // 暂停期间不采样。
    const int before = harness.network.sampleCount;
    const BackendService::Events events = harness.service->collectOnce(at + std::chrono::seconds(10));
    WIFIMETER_CHECK(events.items.empty());
    WIFIMETER_CHECK_EQ(harness.network.sampleCount, before);

    // 暂停区间被记成覆盖空档，恢复时闭合。
    const Response resumed = harness.call(method::kSetPaused, [&] {
        JsonValue params = JsonValue::makeObject();
        params.set("paused", JsonValue::makeBool(false));
        return params;
    }(), at + std::chrono::seconds(30));
    WIFIMETER_CHECK(resumed.ok());

    const Response snapshot = harness.call(method::kSnapshot, at + std::chrono::seconds(30));
    const JsonValue* gaps = snapshot.result.find("gaps");
    WIFIMETER_CHECK(gaps != nullptr && gaps->size() == 1);
    if (gaps != nullptr && gaps->size() == 1)
    {
        WIFIMETER_CHECK_EQ(gaps->at(0).stringOr("reason"), std::string("paused"));
        WIFIMETER_CHECK_EQ(gaps->at(0).intOr("spanSeconds"), std::int64_t{25});
    }
}

void updatesSettings()
{
    Harness harness;
    if (!harness.service)
        return;

    const auto at = utcTime(2026, 9, 29, 10, 0, 0);
    JsonValue params = JsonValue::makeObject();
    JsonValue settings = JsonValue::makeObject();
    settings.set("unit", JsonValue::makeString("GiB"));
    settings.set("interval", JsonValue::makeInt(10));
    settings.set("retention", JsonValue::makeInt(365));
    settings.set("notifications", JsonValue::makeBool(false));
    params.set("settings", std::move(settings));

    const Response response = harness.call(method::kUpdateSettings, params, at);
    WIFIMETER_CHECK(response.ok());
    const JsonValue* updated = response.result.find("settings");
    WIFIMETER_CHECK(updated != nullptr);
    if (updated != nullptr)
    {
        WIFIMETER_CHECK_EQ(updated->stringOr("unit"), std::string("GiB"));
        WIFIMETER_CHECK_EQ(updated->intOr("interval"), std::int64_t{10});
        WIFIMETER_CHECK_EQ(updated->intOr("retention"), std::int64_t{365});
        WIFIMETER_CHECK(!updated->boolOr("notifications"));
    }

    // 非法采样间隔被回退到默认值，而不是原样存进去。
    JsonValue broken = JsonValue::makeObject();
    JsonValue patch = JsonValue::makeObject();
    patch.set("interval", JsonValue::makeInt(7));
    broken.set("settings", std::move(patch));
    const Response fallback = harness.call(method::kUpdateSettings, broken, at);
    WIFIMETER_CHECK(fallback.ok());
    WIFIMETER_CHECK_EQ(fallback.result.find("settings")->intOr("interval"), std::int64_t{5});

    // 缺少 settings 对象时报参数错误。
    const Response missing = harness.call(method::kUpdateSettings, JsonValue::makeObject(), at);
    WIFIMETER_CHECK(!missing.ok());
    WIFIMETER_CHECK_EQ(missing.error.code, std::string(errorCode::kInvalidParams));
}

void updatesNetworkSettings()
{
    wifimeter::test::useTimeZone("UTC");
    Harness harness;
    if (!harness.service)
        return;

    const auto at = utcTime(2026, 9, 29, 10, 0, 0);
    harness.network.sampleReport.samples.push_back(makeSample("wlan0", kUuid, "Habitat_5G", 1, 1));
    harness.service->collectOnce(at);
    bool observed = false;
    harness.store->networks().observe(NetworkRef{kUuid, "Habitat_5G"}, "2026-09-29T10:00:00Z", observed);

    JsonValue params = JsonValue::makeObject();
    params.set("key", JsonValue::makeString(kUuid));
    params.set("alias", JsonValue::makeString("家里的 Wi-Fi"));
    params.set("capGb", JsonValue::makeNumber(120.0));
    params.set("warnPercent", JsonValue::makeInt(75));
    params.set("quotaPeriod", JsonValue::makeString("day"));
    params.set("notify", JsonValue::makeBool(true));

    const Response response = harness.call(method::kUpdateNetwork, params, at);
    WIFIMETER_CHECK(response.ok());
    const JsonValue* network = response.result.find("network");
    WIFIMETER_CHECK(network != nullptr);
    if (network != nullptr)
    {
        WIFIMETER_CHECK_EQ(network->stringOr("alias"), std::string("家里的 Wi-Fi"));
        WIFIMETER_CHECK_EQ(network->doubleOr("capGb"), 120.0);
        WIFIMETER_CHECK_EQ(network->intOr("warnPercent"), std::int64_t{75});
        WIFIMETER_CHECK_EQ(network->stringOr("quotaPeriod"), std::string("day"));
        WIFIMETER_CHECK(network->boolOr("notify"));
    }

    // 未知网络、越界参数都要被拒绝。
    JsonValue unknown = JsonValue::makeObject();
    unknown.set("key", JsonValue::makeString("nope"));
    WIFIMETER_CHECK(!harness.call(method::kUpdateNetwork, unknown, at).ok());
    WIFIMETER_CHECK_EQ(harness.call(method::kUpdateNetwork, unknown, at).error.code, std::string(errorCode::kNotFound));

    JsonValue outOfRange = JsonValue::makeObject();
    outOfRange.set("key", JsonValue::makeString(kUuid));
    outOfRange.set("warnPercent", JsonValue::makeInt(200));
    const Response bad = harness.call(method::kUpdateNetwork, outOfRange, at);
    WIFIMETER_CHECK(!bad.ok());
    WIFIMETER_CHECK_EQ(bad.error.code, std::string(errorCode::kInvalidParams));
}

void alertsOnQuotaAndDisconnectsAtLimit()
{
    wifimeter::test::useTimeZone("UTC");
    Harness harness;
    if (!harness.service)
        return;

    // 先把网络登记出来并设置 1 GB 额度、80% 提醒、超额断开。
    const auto at = utcTime(2026, 9, 29, 10, 0, 0);
    bool created = false;
    WIFIMETER_CHECK(harness.store->networks().observe(NetworkRef{kUuid, "Habitat_5G"}, "2026-09-29T10:00:00Z", created).ok);
    WIFIMETER_CHECK(harness.store->networks().updateUserSettings(kUuid, "家里", 1.0, 80, QuotaPeriod::month, true, true).ok);
    WIFIMETER_CHECK(harness.store->networks().saveLedger(QuotaLedgerRecord{kUuid, "2026-09", 850000000}).ok);

    harness.network.sampleReport.samples.push_back(makeSample("wlan0", kUuid, "Habitat_5G", 100, 100));
    harness.network.sampleReport.links.push_back(makeLink("wlan0", kUuid, "Habitat_5G"));
    harness.network.disconnectReport.outcome = platform::DisconnectOutcome::disconnected;

    const auto countAlerts = [](const BackendService::Events& events, const std::string& kind) {
        int total = 0;
        for (std::size_t index = 0; index < events.items.size(); ++index)
        {
            if (events.names[index] == event::kAlert && events.items[index].stringOr("kind") == kind)
                ++total;
        }
        return total;
    };

    // 账本已经是 85%：第一次评估就该提醒，而不是等到有增量之后。
    const BackendService::Events first = harness.service->collectOnce(at);
    WIFIMETER_CHECK_EQ(countAlerts(first, "quotaWarn"), 1);

    // 再过一次采样把用量推过额度上限：应当断开，但同一周期内不再重复提醒。
    harness.network.sampleReport.samples[0].rxBytes = 200000000;
    const BackendService::Events second = harness.service->collectOnce(at + std::chrono::seconds(5));
    WIFIMETER_CHECK_EQ(countAlerts(second, "quotaWarn"), 0);
    WIFIMETER_CHECK_EQ(countAlerts(second, "quotaDisconnect"), 1);
    WIFIMETER_CHECK_EQ(harness.network.disconnectCount, 1);
    WIFIMETER_CHECK_EQ(harness.network.lastInterface, std::string("wlan0"));
    WIFIMETER_CHECK_EQ(harness.network.lastSsid, std::string("Habitat_5G"));
}

void clearsUsageAndPauses()
{
    wifimeter::test::useTimeZone("UTC");
    Harness harness;
    if (!harness.service)
        return;

    const auto at = utcTime(2026, 9, 29, 10, 0, 0);
    harness.network.sampleReport.samples.push_back(makeSample("wlan0", kUuid, "Habitat_5G", 10, 10));
    harness.service->collectOnce(at);
    harness.network.sampleReport.samples[0].rxBytes = 500;
    harness.service->collectOnce(at + std::chrono::seconds(5));

    const Response cleared = harness.call(method::kClearUsage, at + std::chrono::seconds(5));
    WIFIMETER_CHECK(cleared.ok());
    WIFIMETER_CHECK(cleared.result.boolOr("paused"));
    WIFIMETER_CHECK(harness.service->paused());

    const Response snapshot = harness.call(method::kSnapshot, at + std::chrono::seconds(5));
    WIFIMETER_CHECK_EQ(snapshot.result.find("records")->size(), std::size_t{0});
}

void exportsUsageRows()
{
    wifimeter::test::useTimeZone("UTC");
    Harness harness;
    if (!harness.service)
        return;

    const auto at = utcTime(2026, 9, 29, 10, 0, 0);
    harness.network.sampleReport.samples.push_back(makeSample("wlan0", kUuid, "Habitat_5G", 0, 0));
    harness.service->collectOnce(at);
    harness.network.sampleReport.samples[0].rxBytes = 700;
    harness.network.sampleReport.samples[0].txBytes = 300;
    harness.service->collectOnce(at + std::chrono::seconds(5));

    JsonValue params = JsonValue::makeObject();
    params.set("from", JsonValue::makeString("2026-09-01"));
    params.set("to", JsonValue::makeString("2026-09-30"));
    const Response response = harness.call(method::kExportUsage, params, at + std::chrono::seconds(5));
    WIFIMETER_CHECK(response.ok());
    const JsonValue* records = response.result.find("records");
    WIFIMETER_CHECK(records != nullptr && records->size() == 1);
    if (records != nullptr && records->size() == 1)
    {
        WIFIMETER_CHECK_EQ(records->at(0).stringOr("ssid"), std::string("Habitat_5G"));
        WIFIMETER_CHECK_EQ(records->at(0).stringOr("rxBytes"), std::string("700"));
        WIFIMETER_CHECK_EQ(records->at(0).stringOr("txBytes"), std::string("300"));
    }
}

void backsUpAndRestores()
{
    wifimeter::test::useTimeZone("UTC");
    Harness source;
    if (!source.service)
        return;

    const auto at = utcTime(2026, 9, 29, 10, 0, 0);
    source.network.sampleReport.samples.push_back(makeSample("wlan0", kUuid, "Habitat_5G", 0, 0));
    source.service->collectOnce(at);
    source.network.sampleReport.samples[0].rxBytes = 123456;
    source.network.sampleReport.samples[0].txBytes = 654321;
    source.service->collectOnce(at + std::chrono::seconds(5));
    source.store->networks().updateUserSettings(kUuid, "家里", 50.0, 70, QuotaPeriod::day, true, true);

    const Response backup = source.call(method::kBackup, at);
    WIFIMETER_CHECK(backup.ok());
    const JsonValue* document = backup.result.find("backup");
    WIFIMETER_CHECK(document != nullptr);
    if (document == nullptr)
        return;
    WIFIMETER_CHECK_EQ(document->stringOr("backupType"), std::string("wifimeter-backend-backup"));
    WIFIMETER_CHECK_EQ(document->find("records")->size(), std::size_t{1});

    // 恢复到另一个空库：网络设置、记录与账本都要回来。
    Harness target;
    if (!target.service)
        return;
    JsonValue params = JsonValue::makeObject();
    params.set("backup", *document);
    const Response restored = target.call(method::kRestore, params, at);
    WIFIMETER_CHECK(restored.ok());
    if (!restored.ok())
        wifimeter::test::fail(__FILE__, __LINE__, restored.error.message);
    WIFIMETER_CHECK_EQ(restored.result.intOr("networks"), std::int64_t{1});
    WIFIMETER_CHECK_EQ(restored.result.intOr("records"), std::int64_t{1});
    WIFIMETER_CHECK(restored.result.boolOr("paused"));  // 恢复后暂停，避免计数差覆盖历史

    const Response snapshot = target.call(method::kSnapshot, at);
    const JsonValue* networks = snapshot.result.find("networks");
    WIFIMETER_CHECK(networks != nullptr && networks->size() == 1);
    if (networks != nullptr && networks->size() == 1)
    {
        WIFIMETER_CHECK_EQ(networks->at(0).stringOr("alias"), std::string("家里"));
        WIFIMETER_CHECK_EQ(networks->at(0).doubleOr("capGb"), 50.0);
        WIFIMETER_CHECK_EQ(networks->at(0).stringOr("quotaPeriod"), std::string("day"));
        WIFIMETER_CHECK(networks->at(0).boolOr("notify"));
        WIFIMETER_CHECK(networks->at(0).boolOr("autoDisconnect"));
    }
    const JsonValue* records = snapshot.result.find("records");
    WIFIMETER_CHECK(records != nullptr && records->size() == 1);
    if (records != nullptr && records->size() == 1)
    {
        WIFIMETER_CHECK_EQ(records->at(0).stringOr("rxBytes"), std::string("123456"));
        WIFIMETER_CHECK_EQ(records->at(0).stringOr("txBytes"), std::string("654321"));
    }
}

void rejectsForeignBackups()
{
    Harness harness;
    if (!harness.service)
        return;

    JsonValue params = JsonValue::makeObject();
    JsonValue document = JsonValue::makeObject();
    document.set("backupType", JsonValue::makeString("wifimeter-ui-demo"));
    params.set("backup", std::move(document));
    const Response response = harness.call(method::kRestore, params, utcTime(2026, 9, 29, 10, 0, 0));
    WIFIMETER_CHECK(!response.ok());
    WIFIMETER_CHECK_EQ(response.error.code, std::string(errorCode::kInvalidParams));

    const Response missing = harness.call(method::kRestore, JsonValue::makeObject(), utcTime(2026, 9, 29, 10, 0, 0));
    WIFIMETER_CHECK(!missing.ok());
}

void mapsDisconnectOutcomes()
{
    Harness harness;
    if (!harness.service)
        return;

    const auto at = utcTime(2026, 9, 29, 10, 0, 0);
    JsonValue params = JsonValue::makeObject();
    params.set("interfaceId", JsonValue::makeString("wlan0"));
    params.set("ssid", JsonValue::makeString("Habitat_5G"));

    harness.network.disconnectReport.outcome = platform::DisconnectOutcome::ssidMismatch;
    harness.network.disconnectReport.detail = "当前连接的不是目标网络";
    const Response mismatch = harness.call(method::kDisconnect, params, at);
    WIFIMETER_CHECK(mismatch.ok());
    WIFIMETER_CHECK_EQ(mismatch.result.stringOr("outcome"), std::string("ssidMismatch"));
    WIFIMETER_CHECK_EQ(mismatch.result.stringOr("detail"), std::string("当前连接的不是目标网络"));

    harness.network.disconnectReport.outcome = platform::DisconnectOutcome::disconnected;
    harness.network.disconnectReport.detail.clear();
    const Response done = harness.call(method::kDisconnect, params, at);
    WIFIMETER_CHECK(done.ok());
    WIFIMETER_CHECK_EQ(done.result.stringOr("outcome"), std::string("disconnected"));

    // 缺少参数时拒绝，不去动系统状态。
    const Response bad = harness.call(method::kDisconnect, JsonValue::makeObject(), at);
    WIFIMETER_CHECK(!bad.ok());
    WIFIMETER_CHECK_EQ(bad.error.code, std::string(errorCode::kInvalidParams));
}

void prunesUsage()
{
    wifimeter::test::useTimeZone("UTC");
    Harness harness;
    if (!harness.service)
        return;

    // 造一条很旧的记录，保留期 90 天后应当被裁掉。
    const NetworkRef home{kUuid, "Habitat_5G"};
    WIFIMETER_CHECK(harness.store->usage().add(home, localStampOf(utcTime(2025, 1, 15, 10, 0, 0)), 100, 100).ok);
    bool created = false;
    WIFIMETER_CHECK(harness.store->networks().observe(home, "2025-01-15T10:00:00Z", created).ok);

    const Response response = harness.call(method::kPruneUsage, utcTime(2026, 9, 29, 10, 0, 0));
    WIFIMETER_CHECK(response.ok());
    WIFIMETER_CHECK_EQ(response.result.intOr("removedDaily"), std::int64_t{1});
    WIFIMETER_CHECK_EQ(response.result.intOr("removedHourly"), std::int64_t{1});
}

void applicationHistorySurvivesSnapshotsAndBackups()
{
    Harness harness;
    const auto now = utcTime(2026, 9, 30, 10, 0, 0);
    bool created = false;
    WIFIMETER_CHECK(harness.store->networks().observe({kUuid, "Home"}, "2026-09-30T10:00:00Z", created).ok);
    WIFIMETER_CHECK(harness.store->usage().addApp({kUuid, "2026-09-30", "browser", "浏览器", 9007199254740993ULL, 42}).ok);
    WIFIMETER_CHECK(harness.store->usage().addApp({kUuid, "2026-09-29", "browser", "浏览器", 100, 1}).ok);
    JsonValue params = JsonValue::makeObject();
    params.set("from", JsonValue::makeString("2026-09-30"));
    params.set("to", JsonValue::makeString("2026-09-30"));
    params.set("networkKey", JsonValue::makeString(kUuid));
    auto snapshot = harness.call(method::kSnapshot, params, now);
    WIFIMETER_CHECK(snapshot.ok());
    const auto* apps = snapshot.result.find("appRecords");
    WIFIMETER_CHECK(apps && apps->size() == 1);
    if (apps && apps->size())
    {
        WIFIMETER_CHECK_EQ(apps->at(0).stringOr("rxBytes"), std::string("9007199254740993"));
        WIFIMETER_CHECK_EQ(apps->at(0).stringOr("name"), std::string("浏览器"));
    }
    WIFIMETER_CHECK(snapshot.result.find("records")->size() == 0);
    const auto backup = harness.call(method::kBackup, now);
    WIFIMETER_CHECK(backup.ok());
    const auto* document = backup.result.find("backup");
    WIFIMETER_CHECK(document && document->find("appRecords")->size() == 2);
    WIFIMETER_CHECK(harness.call(method::kClearUsage, now).ok());
    Status status;
    WIFIMETER_CHECK(harness.store->usage().appRange("", "2026-01-01", "2026-12-31", status).empty());
    JsonValue restore = JsonValue::makeObject();
    restore.set("backup", *document);
    WIFIMETER_CHECK(harness.call(method::kRestore, restore, now).ok());
    snapshot = harness.call(method::kSnapshot, params, now);
    WIFIMETER_CHECK(snapshot.result.find("appRecords")->size() == 1);

    // 无效应用记录使整个恢复回滚，原有网络与记录不能丢失。
    JsonValue broken = *document;
    JsonValue badApps = JsonValue::makeArray();
    JsonValue invalid = document->find("appRecords")->at(0);
    invalid.set("rxBytes", JsonValue::makeString("invalid"));
    badApps.push(invalid);
    broken.set("appRecords", badApps);
    restore.set("backup", broken);
    auto rejected = harness.call(method::kRestore, restore, now);
    WIFIMETER_CHECK(!rejected.ok());
    WIFIMETER_CHECK_EQ(rejected.error.code, std::string(errorCode::kInvalidParams));
    snapshot = harness.call(method::kSnapshot, params, now);
    WIFIMETER_CHECK(snapshot.result.find("appRecords")->size() == 1);
    invalid = document->find("appRecords")->at(0);
    invalid.set("networkId", JsonValue::makeString("missing"));
    badApps = JsonValue::makeArray();
    badApps.push(invalid);
    broken.set("appRecords", badApps);
    restore.set("backup", broken);
    WIFIMETER_CHECK(!harness.call(method::kRestore, restore, now).ok());

    // 旧版备份没有应用字段，仍能恢复。
    JsonValue old = JsonValue::makeObject();
    old.set("backupType", JsonValue::makeString("wifimeter-backend-backup"));
    old.set("networks", *document->find("networks"));
    old.set("records", *document->find("records"));
    restore.set("backup", old);
    WIFIMETER_CHECK(harness.call(method::kRestore, restore, now).ok());
    snapshot = harness.call(method::kSnapshot, params, now);
    WIFIMETER_CHECK(snapshot.result.find("appRecords")->size() == 0);
}

}  // namespace

int main()
{
    reportsHello();
    rejectsUnknownMethods();
    collectsUsageAndEmitsEvents();
    reportsLiveConnectionState();
    reportsRatesFromDeltas();
    pauseStopsCollectionAndRecordsAGap();
    updatesSettings();
    updatesNetworkSettings();
    alertsOnQuotaAndDisconnectsAtLimit();
    clearsUsageAndPauses();
    exportsUsageRows();
    backsUpAndRestores();
    rejectsForeignBackups();
    mapsDisconnectOutcomes();
    prunesUsage();
    applicationHistorySurvivesSnapshotsAndBackups();
    return WIFIMETER_REPORT();
}
