#include "../ipc/service.h"
#include "../ipc/backup_archive.h"
#include "test_support.h"

#include <memory>

using namespace wifimeter;
using support::JsonValue;
using wifimeter::test::utcTime;

namespace
{
JsonValue json(const std::string& text)
{
    std::string error;
    return JsonValue::parse(text, error).value_or(JsonValue{});
}
class FakeNetwork : public platform::NetworkPlatform
{
public:
    platform::LinkReport wirelessLinks() override { return {}; }
    platform::SampleReport sampleWifi() override { return {}; }
    platform::DisconnectReport disconnectIfAssociated(const std::string&, const std::string&) override { return {}; }
};
class FakeApps : public platform::AppTrafficSource
{
public:
    platform::AppTrafficReport report{platform::AppCollectorState::running, "generation", {}, {}};
    int starts = 0;
    void start() override { ++starts; }
    void stop() override {}
    platform::AppTrafficReport read() override { return report; }
};
struct Harness
{
    test::TempDirectory directory{"proxy-service"};
    std::unique_ptr<storage::Store> store;
    FakeNetwork network;
    FakeApps apps;
    int proxyCalls = 0;
    platform::ProxyClientReport proxyReport;
    bool injectProxy = true;
    std::unique_ptr<ipc::BackendService> service;
    explicit Harness(bool inject = true, bool start = true) : injectProxy(inject)
    {
        storage::Status status;
        store = storage::Store::open(directory.file("meter.db"), status);
        if (store)
        {
            makeService(start);
        }
    }
    void makeService(bool start = true)
    {
        ipc::BackendService::Deps deps{*store, network, &apps};
        if (injectProxy) deps.proxySampler = [this](const platform::ProxyOptions&) { ++proxyCalls; return proxyReport; };
        service = std::make_unique<ipc::BackendService>(deps);
        if (start) service->onStart(utcTime(2026,10,1,0,0,0));
    }
    void restart()
    {
        service.reset(); store.reset();
        storage::Status status;
        store = storage::Store::open(directory.file("meter.db"),status);
        makeService();
    }
    std::int64_t count(const std::string& table)
    {
        storage::Status status;
        auto query = store->database().prepare("SELECT COUNT(*) FROM " + table,status);
        return query && query->step() ? query->columnInt64(0) : -1;
    }
    void raw(const std::string& networkKey, const std::string& day, const std::string& appId, std::uint64_t rx, std::uint64_t tx)
    {
        bool created=false;
        WIFIMETER_CHECK(store->networks().observe({networkKey,"WiFi"},"2026-10-01T00:00:00Z",created).ok);
        WIFIMETER_CHECK(store->usage().addApp({networkKey,day,appId,appId,rx,tx}).ok);
    }
    ipc::BackendService::Response call(const std::string& method, JsonValue params = JsonValue::makeObject(), core::TimePoint at = utcTime(2026,10,1,0,0,0))
    {
        ipc::Request request;
        request.method=method; request.params=std::move(params);
        return service->handle(request,at);
    }
};
void persistsProxyConfig()
{
    Harness harness;
    WIFIMETER_CHECK(harness.service != nullptr);
    if (!harness.service) return;
    const auto configured = harness.call("updateProxyConfig",json(R"({"ports":[7890,1080],"processNames":["Proxy.exe"]})"));
    WIFIMETER_CHECK(configured.ok());
    harness.restart();
    const auto snapshot = harness.call("snapshot");
    WIFIMETER_CHECK(snapshot.ok());
    WIFIMETER_CHECK(snapshot.result.has("proxy"));
    WIFIMETER_CHECK(snapshot.result.has("proxyEstimatedRecords"));
    if (const auto* config = snapshot.result.find("proxy"))
    {
        WIFIMETER_CHECK_EQ(config->find("ports")->size(),std::size_t(2));
        WIFIMETER_CHECK_EQ(config->find("processNames")->at(0).asString(),std::string("Proxy.exe"));
    }
}
platform::ProxyClientReport observed()
{
    platform::ProxyClientReport report;
    report.available=true;
    report.status=platform::ProxySampleStatus::ready;
    report.proxies={{10,"proxy.exe","Proxy"},{11,"idle.exe","Idle proxy"}};
    report.observations={{"proxy.exe","Proxy","a.exe","Client A",1,{"a-key"}},
        {"proxy.exe","Proxy","b.exe","Client B",2,{"b-key-1","b-key-2"}}};
    return report;
}
void configure(Harness& harness)
{
    WIFIMETER_CHECK(harness.call("updateProxyConfig",json(R"({"ports":[7890],"processNames":[]})")).ok());
}
void enable(Harness& harness, bool value=true)
{
    WIFIMETER_CHECK(harness.call("setAppCollection",json(value ? R"({"enabled":true})" : R"({"enabled":false})")).ok());
}
void loopbackBytesAreLiveButNotWifiUsage()
{
    Harness h;
    h.proxyReport=observed();
    configure(h); enable(h);
    const auto start=utcTime(2026,10,1,0,0,0);
    h.apps.report.samples={{"loopback", "a.exe", "Client A", "12:100", 12, 1000, 2000, true, "a-key"}};
    h.service->collectOnce(start);
    h.apps.report.samples[0].rxBytes += 600;
    h.apps.report.samples[0].txBytes += 200;
    h.service->collectOnce(start+std::chrono::seconds(2));
    const auto snapshot=h.call("snapshot").result;
    const auto* live=snapshot.find("appProcesses");
    WIFIMETER_CHECK(live && live->size()==1);
    if (live && live->size())
    {
        WIFIMETER_CHECK_EQ(live->at(0).stringOr("rxPerSecond"),std::string("300"));
        WIFIMETER_CHECK_EQ(live->at(0).stringOr("txPerSecond"),std::string("100"));
        WIFIMETER_CHECK_EQ(live->at(0).stringOr("networkId"),std::string{});
    }
    const auto* clients=snapshot.find("proxy")->find("clients");
    WIFIMETER_CHECK(clients && clients->at(0).boolOr("measurementAvailable"));
    if (clients) WIFIMETER_CHECK_EQ(clients->at(0).stringOr("rxBytes"),std::string("600"));
    h.proxyReport.observations.clear();
    h.proxyReport.detectedClients={{"a.exe","Client A","Port 7897",1,{"a-key"}}};
    configure(h);
    const auto detected=h.call("snapshot").result.find("proxy")->find("clients")->at(0);
    WIFIMETER_CHECK(!detected.boolOr("pathAvailable"));
    WIFIMETER_CHECK_EQ(detected.stringOr("rxPerSecond"),std::string("300"));
    const auto liveEvent=h.service->collectOnce(start+std::chrono::seconds(4));
    bool carriesProxy=false;
    for (const auto& item:liveEvent.items) if (item.has("proxy")) carriesProxy=true;
    WIFIMETER_CHECK(carriesProxy);
    WIFIMETER_CHECK_EQ(h.count("app_usage"),std::int64_t(0));
}
void helperResolvesOnlyMatchingCurrentConnections()
{
    Harness h;
    const std::string clientKey="9:127.0.0.1:50001>9:127.0.0.1:7897";
    const std::string serverKey="9:127.0.0.1:7897>9:127.0.0.1:50001";
    h.proxyReport.available=true;
    h.proxyReport.status=platform::ProxySampleStatus::ready;
    h.proxyReport.proxies={{10,{}, {}}};
    h.proxyReport.detectedClients={{"client.exe","Client","Port 7897",1,{clientKey},10}};
    configure(h); enable(h);
    h.apps.report.sampledAtMs=h.apps.report.loopbackSampledAtMs=1000;
    h.apps.report.samples={
        {"loopback","client.exe","Client","12:100:1",12,0,0,true,clientKey,"WindowsTcpEStats"},
        {"loopback","proxy.exe","Proxy","10:200:2",10,0,0,true,serverKey,"WindowsTcpEStats"}};
    const auto start=utcTime(2026,10,1,0,0,0);
    h.service->collectOnce(start);
    WIFIMETER_CHECK_EQ(h.count("proxy_apps"),std::int64_t(1));
    WIFIMETER_CHECK_EQ(h.count("proxy_observations"),std::int64_t(1));
    h.raw("net-a","2026-09-30","proxy.exe",17,19);
    const auto snapshot=h.call("snapshot",json(R"({"from":"2026-09-30","to":"2026-09-30"})"));
    const auto* estimates=snapshot.result.find("proxyEstimatedRecords");
    WIFIMETER_CHECK(estimates && estimates->size()==1 && estimates->at(0).boolOr("unattributed"));
    WIFIMETER_CHECK(h.store->database().exec("DELETE FROM proxy_apps; DELETE FROM proxy_observations;").ok);
    h.service->collectOnce(start+std::chrono::seconds(5));
    WIFIMETER_CHECK_EQ(h.count("proxy_observations"),std::int64_t(0));
    h.apps.report.sampledAtMs=h.apps.report.loopbackSampledAtMs=7000;
    h.apps.report.samples[1].processId=99;
    h.apps.report.samples[1].instanceId="99:200:2";
    h.service->collectOnce(start+std::chrono::seconds(10));
    WIFIMETER_CHECK_EQ(h.count("proxy_observations"),std::int64_t(0));
    h.apps.report.sampledAtMs=h.apps.report.loopbackSampledAtMs=12000;
    h.apps.report.samples[1].processId=10;
    h.apps.report.samples[1].instanceId="10:201:3";
    h.apps.report.samples.push_back(h.apps.report.samples[1]);
    h.apps.report.samples.back().instanceId="10:200:2";
    h.service->collectOnce(start+std::chrono::seconds(15));
    WIFIMETER_CHECK_EQ(h.count("proxy_observations"),std::int64_t(0));
    h.apps.report.samples.pop_back();
    h.apps.report.sampledAtMs=h.apps.report.loopbackSampledAtMs=17000;
    h.apps.report.samples[0].connectionKey="other-connection";
    h.service->collectOnce(start+std::chrono::seconds(20));
    WIFIMETER_CHECK_EQ(h.count("proxy_observations"),std::int64_t(0));
    h.apps.report.samples[0].connectionKey=clientKey;
    h.apps.report.sampledAtMs=h.apps.report.loopbackSampledAtMs=16000;
    h.service->collectOnce(start+std::chrono::seconds(25));
    WIFIMETER_CHECK_EQ(h.count("proxy_observations"),std::int64_t(0));
    h.apps.report.sampledAtMs=h.apps.report.loopbackSampledAtMs=16500;
    h.service->collectOnce(start+std::chrono::seconds(30));
    WIFIMETER_CHECK_EQ(h.count("proxy_observations"),std::int64_t(0));
    // 新 generation 可以从较小的单调时钟开始，但必须重新提供双向身份。
    h.apps.report.generation="new-helper";
    h.apps.report.sampledAtMs=h.apps.report.loopbackSampledAtMs=1000;
    h.service->collectOnce(start+std::chrono::seconds(35));
    WIFIMETER_CHECK_EQ(h.count("proxy_observations"),std::int64_t(1));
}
void estimatedUpdatesReplaceOnlyChangedDayNetworkProxyGroups()
{
    Harness h;
    configure(h); enable(h); h.proxyReport=observed();
    const auto start=utcTime(2026,10,1,0,0,0);
    h.raw("net-a","2026-10-01","proxy.exe",101,11);
    h.raw("net-b","2026-10-01","proxy.exe",30,60);
    h.raw("net-a","2026-09-30","proxy.exe",900,800);
    const auto updates = [](const ipc::BackendService::Events& events) {
        auto result=JsonValue::makeArray();
        for (const auto& item : events.items)
            if (const auto* groups=item.find("proxyEstimatedUpdates"))
                for (const auto& group : groups->items()) result.push(group);
        return result;
    };
    const auto first=updates(h.service->collectOnce(start));
    WIFIMETER_CHECK_EQ(first.size(),std::size_t(2));
    for (const auto& group : first.items())
    {
        WIFIMETER_CHECK_EQ(group.stringOr("date"),std::string("2026-10-01"));
        std::uint64_t rx=0,tx=0;
        for (const auto& row : group.find("records")->items())
        { rx+=std::stoull(row.stringOr("rxBytes")); tx+=std::stoull(row.stringOr("txBytes")); }
        WIFIMETER_CHECK_EQ(rx,group.stringOr("networkId")=="net-a" ? std::uint64_t(101) : std::uint64_t(30));
        WIFIMETER_CHECK_EQ(tx,group.stringOr("networkId")=="net-a" ? std::uint64_t(11) : std::uint64_t(60));
    }
    WIFIMETER_CHECK_EQ(updates(h.service->collectOnce(start+std::chrono::seconds(1))).size(),std::size_t(0));
    h.raw("net-a","2026-10-01","proxy.exe",9,19);
    const auto changed=updates(h.service->collectOnce(start+std::chrono::seconds(2)));
    WIFIMETER_CHECK_EQ(changed.size(),std::size_t(1));
    if (changed.size()) WIFIMETER_CHECK_EQ(changed.at(0).stringOr("networkId"),std::string("net-a"));
    h.proxyReport.observations.push_back({"proxy.exe","Proxy","new.exe","New",1,{"new-key"}});
    WIFIMETER_CHECK_EQ(updates(h.service->collectOnce(start+std::chrono::seconds(5))).size(),std::size_t(2));
    WIFIMETER_CHECK(h.store->database().exec("DELETE FROM app_usage WHERE network_key='net-a' AND day='2026-10-01';").ok);
    const auto removed=updates(h.service->collectOnce(start+std::chrono::seconds(6)));
    WIFIMETER_CHECK_EQ(removed.size(),std::size_t(1));
    if (removed.size()) WIFIMETER_CHECK_EQ(removed.at(0).find("records")->size(),std::size_t(0));
    const auto nextDay=updates(h.service->collectOnce(start+std::chrono::hours(24)));
    WIFIMETER_CHECK_EQ(nextDay.size(),std::size_t(0));
}
void samplesAtMostEveryFiveSecondsAndDeduplicatesAcrossRestarts()
{
    Harness harness;
    harness.proxyReport=observed();
    const auto start=utcTime(2026,10,1,0,0,0);
    configure(harness);
    harness.service->collectOnce(start);
    WIFIMETER_CHECK_EQ(harness.proxyCalls,1);
    enable(harness);
    harness.service->collectOnce(start);
    harness.service->collectOnce(start+std::chrono::seconds(1));
    harness.service->collectOnce(start+std::chrono::seconds(4));
    WIFIMETER_CHECK_EQ(harness.proxyCalls,2);
    harness.call("snapshot");
    WIFIMETER_CHECK_EQ(harness.proxyCalls,2);
    harness.service->collectOnce(start+std::chrono::seconds(5));
    WIFIMETER_CHECK_EQ(harness.proxyCalls,3);
    WIFIMETER_CHECK_EQ(harness.count("proxy_observations"),std::int64_t(3));
    WIFIMETER_CHECK_EQ(harness.count("proxy_apps"),std::int64_t(2));
    configure(harness);
    harness.service->collectOnce(start+std::chrono::seconds(6));
    WIFIMETER_CHECK_EQ(harness.proxyCalls,4);
    harness.restart();
    enable(harness);
    harness.service->collectOnce(start+std::chrono::seconds(10));
    WIFIMETER_CHECK_EQ(harness.count("proxy_observations"),std::int64_t(3));
    enable(harness,false);
    harness.service->collectOnce(start+std::chrono::seconds(15));
    WIFIMETER_CHECK_EQ(harness.proxyCalls,5);
    enable(harness);
    WIFIMETER_CHECK(harness.call("updateProxyConfig",json(R"({"ports":[],"processNames":[]})")).ok());
    harness.service->collectOnce(start+std::chrono::seconds(20));
    WIFIMETER_CHECK_EQ(harness.proxyCalls,5);
}
void discoversClientsOnSaveWithoutStartingByteCollection()
{
    Harness harness;
    harness.proxyReport = observed();
    auto response = harness.call("updateProxyConfig", json(R"({"ports":[7890],"processNames":[]})"));
    WIFIMETER_CHECK(response.ok());
    WIFIMETER_CHECK_EQ(harness.proxyCalls, 1);
    WIFIMETER_CHECK_EQ(harness.apps.starts, 0);
    const auto* proxy = response.result.find("proxy");
    WIFIMETER_CHECK(proxy != nullptr);
    if (!proxy) return;
    WIFIMETER_CHECK_EQ(proxy->stringOr("status"), std::string("disabled"));
    const auto* clients = proxy->find("clients");
    WIFIMETER_CHECK(clients && clients->isArray() && clients->size() == 2);
    if (!clients || clients->size() != 2) return;
    const auto& client = clients->at(0);
    WIFIMETER_CHECK_EQ(client.stringOr("appId"), std::string("a.exe"));
    WIFIMETER_CHECK_EQ(client.stringOr("name"), std::string("Client A"));
    WIFIMETER_CHECK_EQ(client.stringOr("proxyName"), std::string("Proxy"));
    WIFIMETER_CHECK_EQ(client.stringOr("proxyAppId"), std::string("proxy.exe"));
    WIFIMETER_CHECK_EQ(client.intOr("connections"), std::int64_t(1));
    WIFIMETER_CHECK_EQ(client.fields().size(), std::size_t(15));
    WIFIMETER_CHECK(client.boolOr("pathAvailable"));
    WIFIMETER_CHECK(client.find("rxBytes")->isNull() && client.find("txBytes")->isNull());
    WIFIMETER_CHECK(!client.boolOr("measurementAvailable"));
    WIFIMETER_CHECK_EQ(harness.count("proxy_observations"), std::int64_t(0));
    WIFIMETER_CHECK_EQ(harness.count("proxy_apps"), std::int64_t(0));
    const auto snapshot = harness.call("snapshot");
    WIFIMETER_CHECK(!snapshot.result.find("appCollection")->boolOr("enabled"));
    WIFIMETER_CHECK_EQ(snapshot.result.find("proxy")->find("clients")->dump(), clients->dump());
    harness.service->collectOnce(utcTime(2026,10,1,0,0,5));
    WIFIMETER_CHECK_EQ(harness.proxyCalls, 1);

    // 失败快照不能继续显示上次的客户端，也不能把不完整失败报告当成证据。
    harness.proxyReport.available = false;
    harness.proxyReport.status = platform::ProxySampleStatus::failed;
    harness.proxyReport.detail = "test TCP discovery failed";
    response = harness.call("updateProxyConfig", json(R"({"ports":[1080]})"));
    WIFIMETER_CHECK(response.ok());
    proxy = response.result.find("proxy");
    WIFIMETER_CHECK_EQ(proxy->find("clients")->size(), std::size_t(0));
    WIFIMETER_CHECK(proxy->stringOr("detail").find("test TCP discovery failed") != std::string::npos);
    WIFIMETER_CHECK_EQ(harness.proxyCalls, 2);
    harness.proxyReport = observed();
    configure(harness);
    response = harness.call("updateProxyConfig", json(R"({"ports":[]})"));
    WIFIMETER_CHECK(response.ok());
    WIFIMETER_CHECK_EQ(response.result.find("proxy")->find("clients")->size(), std::size_t(0));
    WIFIMETER_CHECK_EQ(harness.proxyCalls, 3);
    WIFIMETER_CHECK_EQ(harness.apps.starts, 0);
}

void detectedClientsNeverBecomeByteWeights()
{
    Harness harness;
    harness.proxyReport = observed();
    harness.proxyReport.detectedClients = {{"detected.exe", "Detected", "端口 7897（路径不可读）", 3}};
    const auto response = harness.call("updateProxyConfig", json(R"({"ports":[7897]})"));
    WIFIMETER_CHECK(response.ok());
    const auto* clients = response.result.find("proxy")->find("clients");
    WIFIMETER_CHECK(clients && clients->size() == 3);
    if (!clients || clients->size() != 3) return;
    const auto& detected = clients->at(2);
    WIFIMETER_CHECK_EQ(detected.stringOr("appId"), std::string("detected.exe"));
    WIFIMETER_CHECK_EQ(detected.stringOr("proxyAppId", "missing"), std::string{});
    WIFIMETER_CHECK_EQ(detected.intOr("connections"), std::int64_t(3));
    WIFIMETER_CHECK(!detected.boolOr("pathAvailable", true));
    WIFIMETER_CHECK(detected.find("rxBytes")->isNull() && detected.find("txBytes")->isNull());
    WIFIMETER_CHECK(!detected.boolOr("measurementAvailable"));
    enable(harness);
    harness.service->collectOnce(utcTime(2026,10,1,0,0,0));
    WIFIMETER_CHECK_EQ(harness.count("proxy_observations"), std::int64_t(3));
    harness.proxyReport.observations.clear();
    harness.proxyReport.proxies.clear();
    harness.service->collectOnce(utcTime(2026,10,1,0,0,5));
    WIFIMETER_CHECK_EQ(harness.count("proxy_observations"), std::int64_t(3));
    const auto snapshot = harness.call("snapshot");
    WIFIMETER_CHECK_EQ(snapshot.result.find("proxy")->find("clients")->size(), std::size_t(1));
}

void explainsCollectionAndPermissionState()
{
    Harness harness;
    configure(harness);
    auto snapshot = harness.call("snapshot");
    const auto* proxy = snapshot.result.find("proxy");
    WIFIMETER_CHECK_EQ(proxy->stringOr("status"), std::string("disabled"));
    WIFIMETER_CHECK(proxy->stringOr("detail").find("应用采集") != std::string::npos);
    enable(harness);
    harness.proxyReport = observed();
    harness.service->collectOnce(utcTime(2026,10,1,0,0,0));
    const auto calls = harness.proxyCalls;
    harness.apps.report = {platform::AppCollectorState::permission, {}, "test permission denied", {}};
    harness.service->collectOnce(utcTime(2026,10,1,0,0,5));
    snapshot = harness.call("snapshot");
    proxy = snapshot.result.find("proxy");
    WIFIMETER_CHECK(proxy->boolOr("available"));
    WIFIMETER_CHECK_EQ(proxy->stringOr("status"), std::string("disabled"));
    WIFIMETER_CHECK(proxy->stringOr("detail").find("权限") != std::string::npos);
    WIFIMETER_CHECK_EQ(harness.count("proxy_observations"), std::int64_t(3));
    WIFIMETER_CHECK_EQ(harness.proxyCalls, calls);
    harness.service->setPaused(true, utcTime(2026,10,1,0,0,6));
    snapshot = harness.call("snapshot");
    proxy = snapshot.result.find("proxy");
    WIFIMETER_CHECK_EQ(proxy->stringOr("status"), std::string("disabled"));
    WIFIMETER_CHECK(!proxy->stringOr("detail").empty());
}

void keepsRawRecordsAndSelectsTheRequestedNetworkAndDay()
{
    Harness harness;
    configure(harness); enable(harness);
    harness.proxyReport=observed();
    harness.service->collectOnce(utcTime(2026,10,1,0,0,0));
    harness.raw("net-a","2026-10-01","proxy.exe",101,11);
    harness.raw("net-a","2026-10-01","a.exe",20,30);
    harness.raw("net-b","2026-10-01","proxy.exe",300,60);
    harness.raw("net-a","2026-10-01","idle.exe",9,8);
    harness.raw("net-a","2026-10-02","proxy.exe",1000,2000);
    harness.raw("net-a","2026-09-30","proxy.exe",25,35);
    const auto params=json(R"({"networkKey":"net-a","from":"2026-10-01","to":"2026-10-01"})");
    const auto snapshot=harness.call("snapshot",params);
    WIFIMETER_CHECK(snapshot.ok());
    if (!snapshot.ok()) return;
    const auto* raw=snapshot.result.find("appRecords");
    const auto* estimated=snapshot.result.find("proxyEstimatedRecords");
    WIFIMETER_CHECK(raw && estimated);
    if (!raw || !estimated) return;
    WIFIMETER_CHECK_EQ(raw->size(),std::size_t(3));
    WIFIMETER_CHECK_EQ(estimated->size(),std::size_t(4));
    std::uint64_t rx=0,tx=0;
    for (const auto& row : estimated->items())
    {
        WIFIMETER_CHECK_EQ(row.stringOr("networkId"),std::string("net-a"));
        WIFIMETER_CHECK_EQ(row.stringOr("date"),std::string("2026-10-01"));
        WIFIMETER_CHECK(row.boolOr("estimated"));
        WIFIMETER_CHECK(row.find("rxBytes")->isString() && row.find("txBytes")->isString());
        std::uint64_t a=0,b=0;
        WIFIMETER_CHECK(core::parseDecimal(row.stringOr("rxBytes"),a) && core::parseDecimal(row.stringOr("txBytes"),b));
        rx+=a;tx+=b;
        if (row.stringOr("proxyAppId")=="idle.exe") WIFIMETER_CHECK(row.boolOr("unattributed"));
    }
    WIFIMETER_CHECK_EQ(rx,std::uint64_t(110));
    WIFIMETER_CHECK_EQ(tx,std::uint64_t(19));
    const auto rawBefore=raw->dump();
    const auto historical=harness.call("snapshot",json(R"({"networkKey":"net-a","from":"2026-09-30","to":"2026-09-30"})"));
    const auto* historicalEstimates=historical.result.find("proxyEstimatedRecords");
    WIFIMETER_CHECK(historicalEstimates && historicalEstimates->size()==1);
    if (historicalEstimates && historicalEstimates->size())
    {
        WIFIMETER_CHECK(historicalEstimates->at(0).boolOr("unattributed"));
        WIFIMETER_CHECK_EQ(historicalEstimates->at(0).stringOr("rxBytes"),std::string("25"));
    }

    harness.proxyReport.observations.clear();
    harness.service->collectOnce(utcTime(2026,10,2,0,0,0));
    const auto later=harness.call("snapshot",json(R"({"networkKey":"net-a","from":"2026-10-02","to":"2026-10-02"})"));
    WIFIMETER_CHECK(later.ok());
    const auto* noEvidence=later.result.find("proxyEstimatedRecords");
    WIFIMETER_CHECK(noEvidence && noEvidence->size()==1);
    if (noEvidence && noEvidence->size())
    {
        WIFIMETER_CHECK(noEvidence->at(0).boolOr("unattributed"));
        WIFIMETER_CHECK_EQ(noEvidence->at(0).stringOr("rxBytes"),std::string("1000"));
    }
    const auto unchanged=harness.call("snapshot",params);
    WIFIMETER_CHECK_EQ(unchanged.result.find("appRecords")->dump(),rawBefore);
    storage::Status status;
    const auto stored=harness.store->usage().appRange("net-a","2026-10-01","2026-10-01",status);
    WIFIMETER_CHECK_EQ(stored.size(),std::size_t(3));
    for (const auto& row : stored) if (row.appId=="proxy.exe") WIFIMETER_CHECK_EQ(row.rxBytes,std::uint64_t(101));
}
void validatesConfigWithoutOverwritingTheSavedValue()
{
    Harness harness;
    configure(harness);
    for (const auto* invalid : {R"({"ports":[0]})",R"({"ports":[65536]})",R"({"ports":[1.5]})",R"({"ports":["7890"]})",
        R"({"ports":[7890,7890]})",R"({"ports":true})",R"({"processNames":[""]})",R"({"processNames":["A.exe","a.EXE"]})",
        R"({"processNames":["bad\nname"]})",R"({"processNames":true})"})
    {
        const auto response=harness.call("updateProxyConfig",json(invalid));
        WIFIMETER_CHECK_EQ(response.error.code,std::string(ipc::errorCode::kInvalidParams));
    }
    for (const auto& field : {std::string("ports"),std::string("processNames")})
    {
        auto input=JsonValue::makeObject(),values=JsonValue::makeArray();
        for (int i=0;i<(field=="ports" ? 65 : 33);++i)
            values.push(field=="ports" ? JsonValue::makeInt(i+1) : JsonValue::makeString("name"+std::to_string(i)));
        input.set(field,std::move(values));
        WIFIMETER_CHECK_EQ(harness.call("updateProxyConfig",input).error.code,std::string(ipc::errorCode::kInvalidParams));
    }
    auto names=JsonValue::makeArray(); names.push(JsonValue::makeString(std::string(65,'a')));
    auto tooLong=JsonValue::makeObject();tooLong.set("processNames",names);
    WIFIMETER_CHECK_EQ(harness.call("updateProxyConfig",tooLong).error.code,std::string(ipc::errorCode::kInvalidParams));
    const auto snapshot=harness.call("snapshot");
    WIFIMETER_CHECK_EQ(snapshot.result.find("proxy")->find("ports")->at(0).asInt64(),std::int64_t(7890));
    std::string unicode; for (int i=0;i<64;++i) unicode+="代";
    names=JsonValue::makeArray();names.push(JsonValue::makeString(unicode));tooLong.set("processNames",names);
    WIFIMETER_CHECK(harness.call("updateProxyConfig",tooLong).ok());
    names=JsonValue::makeArray();names.push(JsonValue::makeString(unicode+"代"));tooLong.set("processNames",names);
    WIFIMETER_CHECK_EQ(harness.call("updateProxyConfig",tooLong).error.code,std::string(ipc::errorCode::kInvalidParams));
}
void retentionAndClearFollowTheUserSettings()
{
    Harness harness;
    configure(harness);enable(harness);harness.proxyReport=observed();
    harness.service->collectOnce(utcTime(2026,10,1,0,0,0));
    harness.service->collectOnce(utcTime(2026,10,2,0,0,0));
    WIFIMETER_CHECK_EQ(harness.count("proxy_observations"),std::int64_t(6));
    WIFIMETER_CHECK(harness.call("updateSettings",json(R"({"settings":{"retention":0}})")).ok());
    WIFIMETER_CHECK(harness.call("pruneUsage",JsonValue::makeObject(),utcTime(2026,10,2,0,0,0)).ok());
    WIFIMETER_CHECK_EQ(harness.count("proxy_observations"),std::int64_t(6));
    WIFIMETER_CHECK(harness.call("updateSettings",json(R"({"settings":{"retention":1}})")).ok());
    WIFIMETER_CHECK(harness.call("pruneUsage",JsonValue::makeObject(),utcTime(2026,10,2,0,0,0)).ok());
    WIFIMETER_CHECK_EQ(harness.count("proxy_observations"),std::int64_t(3));
    WIFIMETER_CHECK_EQ(harness.count("proxy_apps"),std::int64_t(2));
    WIFIMETER_CHECK(harness.call("clearUsage").ok());
    WIFIMETER_CHECK_EQ(harness.count("proxy_observations"),std::int64_t(0));
    WIFIMETER_CHECK_EQ(harness.count("proxy_apps"),std::int64_t(0));
    WIFIMETER_CHECK_EQ(harness.count("proxy_config"),std::int64_t(1));
}
void failedObservationDoesNotWritePartialEvidence()
{
    Harness harness;
    configure(harness); enable(harness);harness.proxyReport=observed();
    WIFIMETER_CHECK(harness.store->database().exec("CREATE TRIGGER reject_proxy_key BEFORE INSERT ON proxy_observations WHEN NEW.connection_key='b-key-1' BEGIN SELECT RAISE(ABORT,'test failure'); END;").ok);
    const auto events=harness.service->collectOnce(utcTime(2026,10,1,0,0,0));
    WIFIMETER_CHECK(events.error.code.empty());
    WIFIMETER_CHECK_EQ(harness.count("proxy_observations"),std::int64_t(0));
    WIFIMETER_CHECK_EQ(harness.count("proxy_apps"),std::int64_t(0));
    const auto snapshot=harness.call("snapshot");
    WIFIMETER_CHECK_EQ(snapshot.result.find("proxy")->stringOr("status"),std::string("failed"));
    WIFIMETER_CHECK(!snapshot.result.find("proxy")->boolOr("available"));
}
void nativeAvailabilityIsExplicit()
{
    Harness harness(false);
    const auto snapshot=harness.call("snapshot");
    WIFIMETER_CHECK(snapshot.ok());
#if !defined(_WIN32)
    WIFIMETER_CHECK_EQ(snapshot.result.find("proxy")->stringOr("status"),std::string("unsupported"));
    WIFIMETER_CHECK(!snapshot.result.find("proxy")->boolOr("available"));
#else
    WIFIMETER_CHECK_EQ(snapshot.result.find("proxy")->stringOr("status"),std::string("disabled"));
#endif
}

JsonValue restoreParams(const JsonValue& document)
{
    auto params=JsonValue::makeObject(); params.set("backup",document); return params;
}
void fullBackupRestoresProxyEvidenceWithoutOnStart()
{
    Harness empty(false,false);
    const auto emptyBackup=empty.call("backup");
    WIFIMETER_CHECK(emptyBackup.ok());
    if (emptyBackup.ok()) WIFIMETER_CHECK(emptyBackup.result.find("backup")->has("proxyConfig"));
    Harness source;
    configure(source); enable(source); source.proxyReport=observed();
    source.service->collectOnce(utcTime(2026,10,1,0,0,0));
    source.raw("net-a","2026-10-01","proxy.exe",101,11);
    source.raw("net-a","2026-10-01","a.exe",20,30);
    const auto exported=source.call("backup");
    WIFIMETER_CHECK(exported.ok());
    if (!exported.ok()) return;
    const auto document=*exported.result.find("backup");
    WIFIMETER_CHECK(document.has("proxyConfig") && document.has("proxyApps") && document.has("proxyObservations"));
    if (!document.has("proxyConfig") || !document.has("proxyApps") || !document.has("proxyObservations")) return;
    WIFIMETER_CHECK_EQ(document.find("proxyConfig")->size(),std::size_t(1));
    WIFIMETER_CHECK_EQ(document.find("proxyApps")->size(),std::size_t(2));
    WIFIMETER_CHECK_EQ(document.find("proxyObservations")->size(),std::size_t(3));
    Harness restored(true,false);
    WIFIMETER_CHECK(restored.call("restore",restoreParams(document)).ok());
    const auto roundtrip=restored.call("backup");
    WIFIMETER_CHECK(roundtrip.ok());
    for (const auto* field : {"proxyConfig","proxyApps","proxyObservations","appRecords","totalQuota"})
        WIFIMETER_CHECK_EQ(roundtrip.result.find("backup")->find(field)->dump(),document.find(field)->dump());
    const auto query=json(R"({"networkKey":"net-a","from":"2026-10-01","to":"2026-10-01"})");
    const auto before=source.call("snapshot",query),after=restored.call("snapshot",query);
    WIFIMETER_CHECK_EQ(before.result.find("proxyEstimatedRecords")->dump(),after.result.find("proxyEstimatedRecords")->dump());
    WIFIMETER_CHECK_EQ(before.result.find("appRecords")->dump(),after.result.find("appRecords")->dump());
    restored.proxyReport=observed(); enable(restored); restored.service->setPaused(false,utcTime(2026,10,1,0,0,5));
    restored.service->collectOnce(utcTime(2026,10,1,0,0,5));
    WIFIMETER_CHECK_EQ(restored.count("proxy_observations"),std::int64_t(3));

    // 所有失败都必须保留现有数据库，包括已恢复的代理配置、观测和原始应用记录。
    restored.raw("net-a","2026-10-01","keep.exe",17,19);
    WIFIMETER_CHECK(restored.call("updateProxyConfig",json(R"({"ports":[6543],"processNames":["Keep.exe"]})")).ok());
    const auto preserved=*restored.call("backup").result.find("backup");
    const auto reject=[&](const JsonValue& invalid) {
        const auto response=restored.call("restore",restoreParams(invalid));
        WIFIMETER_CHECK(!response.ok());
        const auto retained=restored.call("backup");
        WIFIMETER_CHECK(retained.ok());
        WIFIMETER_CHECK_EQ(retained.result.find("backup")->dump(),preserved.dump());
    };
    for (const auto* bad : {"not json","[0]","[65536]","[1.5]","[7890,7890]","{}"})
    {
        auto invalid=document,config=*document.find("proxyConfig");
        auto row=config.at(0); row.set("portsJson",JsonValue::makeString(bad));
        config=JsonValue::makeArray();config.push(row);invalid.set("proxyConfig",config);reject(invalid);
    }
    for (const auto* bad : {"not json",R"(["A.exe","a.EXE"])",R"([""])","[1]"})
    {
        auto invalid=document,config=*document.find("proxyConfig");
        auto row=config.at(0);row.set("processNamesJson",JsonValue::makeString(bad));
        config=JsonValue::makeArray();config.push(row);invalid.set("proxyConfig",config);reject(invalid);
    }
    for (const auto* field : {"proxyApps","proxyObservations"})
    {
        auto invalid=document,values=JsonValue::makeArray();
        auto row=document.find(field)->at(0);row.set("date",JsonValue::makeString("2026-02-30"));values.push(row);
        invalid.set(field,values);reject(invalid);
    }
    // 有效字段进入事务后，重复主键导致插入失败，同样要回滚前面的清空与恢复。
    auto duplicate=document,observations=*document.find("proxyObservations");
    observations.push(observations.at(0));duplicate.set("proxyObservations",observations);reject(duplicate);
    auto legacy=JsonValue::makeObject();
    for (const auto& field : document.fields())
        if (field.first!="proxyConfig" && field.first!="proxyApps" && field.first!="proxyObservations" && field.first!="proxyMinuteWeights") legacy.set(field.first,field.second);
    WIFIMETER_CHECK(restored.call("restore",restoreParams(legacy)).ok());
    WIFIMETER_CHECK_EQ(restored.count("proxy_config"),std::int64_t(0));
    WIFIMETER_CHECK_EQ(restored.count("proxy_apps"),std::int64_t(0));
    WIFIMETER_CHECK_EQ(restored.count("proxy_observations"),std::int64_t(0));
    const auto cleared=restored.call("snapshot",query);
    WIFIMETER_CHECK_EQ(cleared.result.find("proxy")->find("ports")->size(),std::size_t(0));
    WIFIMETER_CHECK_EQ(cleared.result.find("appRecords")->dump(),document.find("appRecords")->dump());
}
void fullBackupRestoresProxyMinuteWeights()
{
    Harness empty(false,false);
    const auto emptyBackup=empty.call("backup");
    WIFIMETER_CHECK(emptyBackup.ok());
    if (emptyBackup.ok())
    {
        const auto* weights=emptyBackup.result.find("backup")->find("proxyMinuteWeights");
        WIFIMETER_CHECK(weights && weights->isArray() && weights->size()==0);
    }

    Harness source;
    configure(source); enable(source); source.proxyReport=observed();
    source.service->collectOnce(utcTime(2026,10,1,0,0,0));
    WIFIMETER_CHECK(source.store->database().exec(
        "DELETE FROM proxy_minute_weights;"
        "INSERT INTO proxy_minute_weights(day,hour,minute,proxy_app_id,app_id,name,connections,rx_bytes,tx_bytes) VALUES"
        "('2026-10-01',0,0,'proxy.exe','a.exe','Client A',1,600,200),"
        "('2026-10-01',0,0,'proxy.exe','b.exe','Client B',2,300,50),"
        "('2026-10-01',0,7,'proxy.exe','a.exe','Client A',1,9007199254740993,9007199254740997);").ok);
    source.raw("net-a","2026-10-01","proxy.exe",990,275);
    source.raw("net-a","2026-10-01","a.exe",20,30);
    WIFIMETER_CHECK(source.store->usage().addAppMinute({"net-a","2026-10-01",0,0,"proxy.exe","Proxy",900,250}).ok);
    WIFIMETER_CHECK(source.store->usage().addAppMinute({"net-a","2026-10-01",0,7,"proxy.exe","Proxy",90,25}).ok);
    WIFIMETER_CHECK(source.store->usage().addAppMinute({"net-a","2026-10-01",0,0,"a.exe","Client A",20,30}).ok);
    const auto exported=source.call("backup");
    WIFIMETER_CHECK(exported.ok());
    if (!exported.ok()) return;
    const auto document=*exported.result.find("backup");
    const auto* weights=document.find("proxyMinuteWeights");
    WIFIMETER_CHECK(weights && weights->isArray() && weights->size()==3);
    if (!weights || !weights->isArray() || weights->size()!=3) return;
    for (const auto& row : weights->items())
        for (const auto* field : {"hour","minute","connections","rxBytes","txBytes"})
            WIFIMETER_CHECK(row.find(field) && row.find(field)->isString());
    WIFIMETER_CHECK_EQ(weights->at(2).stringOr("rxBytes"),std::string("9007199254740993"));
    WIFIMETER_CHECK_EQ(weights->at(2).stringOr("txBytes"),std::string("9007199254740997"));

    Harness restored(true,false);
    WIFIMETER_CHECK(restored.call("restore",restoreParams(document)).ok());
    WIFIMETER_CHECK_EQ(restored.count("proxy_minute_weights"),std::int64_t(3));
    const auto roundtrip=restored.call("backup");
    WIFIMETER_CHECK(roundtrip.ok());
    if (!roundtrip.ok()) return;
    for (const auto* field : {"proxyMinuteWeights","proxyConfig","proxyApps","proxyObservations","appRecords","appMinuteRecords","totalQuota"})
        WIFIMETER_CHECK_EQ(roundtrip.result.find("backup")->find(field)->dump(),document.find(field)->dump());
    const auto query=json(R"({"networkKey":"net-a","from":"2026-10-01","to":"2026-10-01","includeMinutes":true})");
    const auto before=source.call("snapshot",query),after=restored.call("snapshot",query);
    WIFIMETER_CHECK(before.ok() && after.ok());
    if (!before.ok() || !after.ok()) return;
    const auto* minutes=before.result.find("proxyEstimatedMinuteRecords");
    WIFIMETER_CHECK(minutes && minutes->size()>=3);
    if (minutes && minutes->size()>=3)
    {
        WIFIMETER_CHECK_EQ(minutes->at(0).stringOr("rxBytes"),std::string("600"));
        WIFIMETER_CHECK_EQ(minutes->at(1).stringOr("rxBytes"),std::string("300"));
    }
    for (const auto* field : {"proxyEstimatedRecords","proxyEstimatedMinuteRecords","appRecords","appMinuteRecords"})
        WIFIMETER_CHECK_EQ(after.result.find(field)->dump(),before.result.find(field)->dump());

    // 缺少可选分钟权重的旧备份仍可整体替换，不能保留目标库原来的权重。
    auto legacy=JsonValue::makeObject();
    for (const auto& field : document.fields())
        if (field.first!="proxyMinuteWeights") legacy.set(field.first,field.second);
    WIFIMETER_CHECK(restored.call("restore",restoreParams(legacy)).ok());
    WIFIMETER_CHECK_EQ(restored.count("proxy_minute_weights"),std::int64_t(0));
    const auto legacyRoundtrip=restored.call("backup");
    WIFIMETER_CHECK(legacyRoundtrip.ok());
    if (legacyRoundtrip.ok())
        for (const auto* field : {"proxyConfig","proxyApps","proxyObservations","appRecords","appMinuteRecords"})
            WIFIMETER_CHECK_EQ(legacyRoundtrip.result.find("backup")->find(field)->dump(),document.find(field)->dump());
}

void rejectsInvalidProxyMinuteWeightsBeforeReplacingData()
{
    Harness target;
    configure(target);
    target.raw("net-a","2026-10-01","keep.exe",17,19);
    WIFIMETER_CHECK(target.store->database().exec(
        "INSERT INTO proxy_minute_weights(day,hour,minute,proxy_app_id,app_id,name,connections,rx_bytes,tx_bytes) "
        "VALUES('2026-10-01',0,0,'keep-proxy.exe','keep.exe','Keep',3,17,19);").ok);
    const auto preserved=*target.call("backup").result.find("backup");
    Harness source;
    const auto base=*source.call("backup").result.find("backup");
    const auto validRow=json(R"({"date":"2026-10-01","hour":"0","minute":"7","proxyAppId":"proxy.exe","appId":"client.exe","name":"Client","connections":"2","rxBytes":"9007199254740993","txBytes":"19"})");
    const auto reject=[&](JsonValue rows) {
        auto document=base;
        document.set("proxyMinuteWeights",std::move(rows));
        // 直接校验归档，确保非法字段在开始清空事务之前就被拒绝。
        WIFIMETER_CHECK(!ipc::validateBackupRows(document).ok);
        const auto response=target.call("restore",restoreParams(document));
        WIFIMETER_CHECK_EQ(response.error.code,std::string(ipc::errorCode::kInvalidParams));
        const auto retained=target.call("backup");
        WIFIMETER_CHECK(retained.ok());
        if (retained.ok()) WIFIMETER_CHECK_EQ(retained.result.find("backup")->dump(),preserved.dump());
        WIFIMETER_CHECK_EQ(target.count("proxy_minute_weights"),std::int64_t(1));
    };
    const auto rejectRow=[&](const JsonValue& row) {
        auto rows=JsonValue::makeArray(); rows.push(row); reject(std::move(rows));
    };
    const auto rejectField=[&](const char* field,const JsonValue& value) {
        auto row=validRow; row.set(field,value); rejectRow(row);
    };
    for (const auto& value : {JsonValue::makeNull(),JsonValue::makeObject(),JsonValue::makeString("[]"),JsonValue::makeInt(1)})
    {
        reject(value);
        rejectRow(value);
    }
    for (const auto* omitted : {"date","hour","minute","proxyAppId","appId","name","connections","rxBytes","txBytes"})
    {
        auto row=JsonValue::makeObject();
        for (const auto& field : validRow.fields()) if (field.first!=omitted) row.set(field.first,field.second);
        rejectRow(row);
    }
    for (const auto* field : {"date","proxyAppId","appId","name"})
        for (const auto& value : {JsonValue::makeNull(),JsonValue::makeBool(true),JsonValue::makeInt(1),JsonValue::makeObject()})
            rejectField(field,value);
    for (const auto* field : {"proxyAppId","appId"})
        for (const auto& value : {std::string{},std::string("unknown"),std::string("proxy/unattributed"),std::string("client\0.exe",11)})
            rejectField(field,JsonValue::makeString(value));
    for (const auto* date : {"2026-02-30","2026-2-01","2026-10-01T00:00:00Z","2026-10-01x"})
        rejectField("date",JsonValue::makeString(date));
    for (const auto* field : {"hour","minute","connections"})
    {
        for (const auto& value : {JsonValue::makeNull(),JsonValue::makeBool(true),JsonValue::makeNumber(1.5),JsonValue::makeArray()})
            rejectField(field,value);
        for (const auto* value : {"-1","1.5","1e1","+1"," 1","9223372036854775808"})
            rejectField(field,JsonValue::makeString(value));
    }
    rejectField("hour",JsonValue::makeInt(24));
    rejectField("minute",JsonValue::makeInt(60));
    rejectField("connections",JsonValue::makeInt(0));
    for (const auto* field : {"rxBytes","txBytes"})
    {
        for (const auto& value : {JsonValue::makeNull(),JsonValue::makeBool(true),JsonValue::makeInt(19),JsonValue::makeNumber(1.5),JsonValue::makeObject()})
            rejectField(field,value);
        for (const auto* value : {"","-0","-1","1.5","1e1","+1"," 1","1 ","9223372036854775808","18446744073709551615"})
            rejectField(field,JsonValue::makeString(value));
    }
    auto incomplete=validRow; incomplete.set("txBytes",JsonValue::makeString("1.5"));
    auto mixed=JsonValue::makeArray(); mixed.push(validRow); mixed.push(incomplete); reject(mixed);
    auto duplicate=JsonValue::makeArray(); duplicate.push(validRow); duplicate.push(validRow); reject(duplicate);
    auto caseVariant=validRow;
    caseVariant.set("proxyAppId",JsonValue::makeString("PROXY.EXE"));
    caseVariant.set("appId",JsonValue::makeString("CLIENT.EXE"));
    duplicate=JsonValue::makeArray(); duplicate.push(validRow); duplicate.push(caseVariant); reject(duplicate);
    // 主键按整数比较，字符串的前导零不能绕过重复检查。
    auto alternateMinute=validRow; alternateMinute.set("minute",JsonValue::makeString("07"));
    duplicate=JsonValue::makeArray(); duplicate.push(validRow); duplicate.push(alternateMinute); reject(duplicate);

    auto valid=base,rows=JsonValue::makeArray(); rows.push(validRow); valid.set("proxyMinuteWeights",rows);
    WIFIMETER_CHECK(ipc::validateBackupRows(valid).ok);
    // 合法数据的插入失败也必须回滚前面的网络、应用、配置和权重替换。
    WIFIMETER_CHECK(target.store->database().exec(
        "CREATE TRIGGER reject_proxy_minute_restore BEFORE INSERT ON proxy_minute_weights "
        "BEGIN SELECT RAISE(ABORT,'test rollback'); END;").ok);
    WIFIMETER_CHECK(!target.call("restore",restoreParams(valid)).ok());
    const auto rolledBack=target.call("backup");
    WIFIMETER_CHECK(rolledBack.ok());
    if (rolledBack.ok()) WIFIMETER_CHECK_EQ(rolledBack.result.find("backup")->dump(),preserved.dump());
    WIFIMETER_CHECK_EQ(target.count("proxy_minute_weights"),std::int64_t(1));
}

void acceptsMinuteWeightIntegerBoundaries()
{
    Harness source;
    auto document=*source.call("backup").result.find("backup");
    auto rows=JsonValue::makeArray();
    rows.push(json(R"({"date":"2024-02-29","hour":23,"minute":59,"proxyAppId":"proxy.exe","appId":"client.exe","name":"","connections":1,"rxBytes":"9223372036854775807","txBytes":"000"})"));
    rows.push(json(R"({"date":"2024-02-29","hour":"0","minute":"0","proxyAppId":"proxy.exe","appId":"other.exe","name":"Other","connections":"9223372036854775807","rxBytes":"0","txBytes":"9007199254740993"})"));
    document.set("proxyMinuteWeights",rows);
    WIFIMETER_CHECK(ipc::validateBackupRows(document).ok);
    Harness restored(true,false);
    WIFIMETER_CHECK(restored.call("restore",restoreParams(document)).ok());
    WIFIMETER_CHECK_EQ(restored.count("proxy_minute_weights"),std::int64_t(2));
    const auto exported=restored.call("backup");
    WIFIMETER_CHECK(exported.ok());
    if (!exported.ok()) return;
    const auto* weights=exported.result.find("backup")->find("proxyMinuteWeights");
    WIFIMETER_CHECK(weights && weights->isArray() && weights->size()==2);
    if (!weights || !weights->isArray() || weights->size()!=2) return;
    WIFIMETER_CHECK_EQ(weights->at(0).stringOr("connections"),std::string("9223372036854775807"));
    WIFIMETER_CHECK_EQ(weights->at(1).stringOr("rxBytes"),std::string("9223372036854775807"));
    WIFIMETER_CHECK_EQ(weights->at(1).stringOr("txBytes"),std::string("0"));
}
JsonValue legacyProxyParams(const std::string& proxy=R"({"Ports":[1080],"ProcessNames":["LegacyProxy.exe"]})")
{
    auto params=JsonValue::makeObject();
    params.set("sourceId",JsonValue::makeString("legacy-proxy"));
    params.set("allowInitialSettings",JsonValue::makeBool(true));
    params.set("stateJson",JsonValue::makeString(R"({"SchemaVersion":1,"StartedAt":"2026-10-01T00:00:00Z","UpdatedAt":"2026-10-02T00:00:00Z","Networks":[{"SSID":"LegacyProxyNetwork","RxBytes":7,"TxBytes":5,"FirstSeen":"2026-10-01T00:00:00Z","LastSeen":"2026-10-02T00:00:00Z","Days":[{"Date":"2026-10-01","RxBytes":7,"TxBytes":5}]}]})"));
    params.set("settingsJson",JsonValue::makeString("{\"Proxy\":"+proxy+"}"));
    return params;
}
void migratesOnlyInitialProxySettingsInTheImportTransaction()
{
    Harness harness;
    const auto params=legacyProxyParams();
    const auto imported=harness.call("importLegacy",params);
    WIFIMETER_CHECK(imported.ok());
    WIFIMETER_CHECK(imported.result.boolOr("proxySettingsApplied"));
    const auto snapshot=harness.call("snapshot");
    WIFIMETER_CHECK(snapshot.ok());
    WIFIMETER_CHECK_EQ(snapshot.result.find("proxy")->find("ports")->size(),std::size_t(1));
    if (snapshot.result.find("proxy")->find("ports")->size())
        WIFIMETER_CHECK_EQ(snapshot.result.find("proxy")->find("ports")->at(0).asInt64(),std::int64_t(1080));
    WIFIMETER_CHECK_EQ(harness.count("proxy_observations"),std::int64_t(0));
    WIFIMETER_CHECK_EQ(harness.count("proxy_apps"),std::int64_t(0));
    WIFIMETER_CHECK_EQ(harness.count("daily_usage"),std::int64_t(1));
    const auto repeated=harness.call("importLegacy",params);
    WIFIMETER_CHECK(repeated.ok() && repeated.result.boolOr("alreadyImported") && repeated.result.boolOr("proxySettingsApplied"));
    const auto status=harness.call("migrationStatus",params);
    WIFIMETER_CHECK(status.ok() && status.result.boolOr("proxySettingsApplied"));
    storage::Status sqlStatus;
    auto archive=harness.store->database().prepare("SELECT settings_json FROM legacy_imports",sqlStatus);
    WIFIMETER_CHECK(archive && archive->step());
    if (archive) WIFIMETER_CHECK_EQ(archive->columnText(0),params.stringOr("settingsJson"));

    Harness existing;
    configure(existing);
    const auto refused=existing.call("importLegacy",params);
    WIFIMETER_CHECK_EQ(refused.error.code,std::string("LegacyInitialSettingsConflict"));
    WIFIMETER_CHECK_EQ(existing.count("daily_usage"),std::int64_t(0));
    auto archiveOnly=params;archiveOnly.set("allowInitialSettings",JsonValue::makeBool(false));
    const auto kept=existing.call("importLegacy",archiveOnly);
    WIFIMETER_CHECK(kept.ok() && !kept.result.boolOr("proxySettingsApplied"));
    WIFIMETER_CHECK_EQ(existing.call("snapshot").result.find("proxy")->find("ports")->at(0).asInt64(),std::int64_t(7890));

    Harness invalid;
    WIFIMETER_CHECK(!invalid.call("importLegacy",legacyProxyParams(R"({"Ports":[0]})")).ok());
    for (const auto* table : {"proxy_config","networks","daily_usage","legacy_imports"})
        WIFIMETER_CHECK_EQ(invalid.count(table),std::int64_t(0));
    Harness rollback;
    WIFIMETER_CHECK(rollback.store->database().exec("CREATE TRIGGER reject_proxy_archive BEFORE INSERT ON legacy_imports BEGIN SELECT RAISE(ABORT,'test rollback'); END;").ok);
    WIFIMETER_CHECK(!rollback.call("importLegacy",params).ok());
    for (const auto* table : {"proxy_config","networks","daily_usage","legacy_imports"})
        WIFIMETER_CHECK_EQ(rollback.count(table),std::int64_t(0));
}

}
void proxyClientIdentityIsExplicitInMemory()
{
    storage::Status status;
    auto store = storage::Store::open(":memory:", status);
    WIFIMETER_CHECK(store && status.ok);
    if (!store) return;
    FakeNetwork network;
    FakeApps apps;
    auto report = observed();
    report.detectedClients = {{"detected.exe", "Detected", "Unknown proxy", 1}};
    ipc::BackendService::Deps deps{*store, network, &apps};
    deps.proxySampler = [&](const platform::ProxyOptions&) { return report; };
    ipc::BackendService service(deps);
    ipc::Request request;
    request.method = "updateProxyConfig";
    request.params = json(R"({"ports":[7890],"processNames":[]})");
    const auto response = service.handle(request, utcTime(2026, 10, 1));
    WIFIMETER_CHECK(response.ok());
    if (!response.ok()) return;
    const auto* clients = response.result.find("proxy")->find("clients");
    WIFIMETER_CHECK(clients && clients->size() == 3);
    if (!clients || clients->size() != 3) return;
    WIFIMETER_CHECK_EQ(clients->at(0).stringOr("proxyAppId"), std::string("proxy.exe"));
    WIFIMETER_CHECK_EQ(clients->at(2).stringOr("proxyAppId", "missing"), std::string{});
    WIFIMETER_CHECK(!clients->at(2).boolOr("pathAvailable", true));
}

// 客户端回环字节决定各方向的份额；分钟行用当分钟权重，没有时退回当天合计。
void minuteWeightsFollowLoopbackBytesPerDirection()
{
    Harness h;
    h.proxyReport=observed();
    configure(h); enable(h);
    const auto start=utcTime(2026,10,1,0,0,0);
    h.apps.report.samples={{"loopback","a.exe","Client A","12:100",12,1000,2000,true,"a-key"},
        {"loopback","b.exe","Client B","13:100",13,500,500,true,"b-key-1"}};
    h.service->collectOnce(start);
    WIFIMETER_CHECK_EQ(h.count("proxy_minute_weights"),std::int64_t(2));
    h.apps.report.samples[0].rxBytes+=600; h.apps.report.samples[0].txBytes+=200;
    h.apps.report.samples[1].rxBytes+=300; h.apps.report.samples[1].txBytes+=50;
    h.service->collectOnce(start+std::chrono::seconds(5));
    // 同一分钟内重复采样只累加字节增量，连接数取去重后的最大值。
    h.service->collectOnce(start+std::chrono::seconds(10));
    WIFIMETER_CHECK_EQ(h.count("proxy_minute_weights"),std::int64_t(2));
    storage::Status status;
    auto stored=h.store->database().prepare("SELECT app_id,connections,rx_bytes,tx_bytes FROM proxy_minute_weights ORDER BY app_id;",status);
    WIFIMETER_CHECK(stored && stored->step());
    if (!stored) return;
    WIFIMETER_CHECK_EQ(stored->columnInt64(1),std::int64_t(1));
    WIFIMETER_CHECK_EQ(stored->columnInt64(2),std::int64_t(600));
    WIFIMETER_CHECK_EQ(stored->columnInt64(3),std::int64_t(200));
    WIFIMETER_CHECK(stored->step());
    WIFIMETER_CHECK_EQ(stored->columnInt64(1),std::int64_t(2));
    WIFIMETER_CHECK_EQ(stored->columnInt64(2),std::int64_t(300));
    WIFIMETER_CHECK_EQ(stored->columnInt64(3),std::int64_t(50));
    stored.reset();

    h.raw("net-a","2026-10-01","proxy.exe",990,275);
    WIFIMETER_CHECK(h.store->usage().addAppMinute({"net-a","2026-10-01",0,0,"proxy.exe","Proxy",900,250}).ok);
    WIFIMETER_CHECK(h.store->usage().addAppMinute({"net-a","2026-10-01",0,7,"proxy.exe","Proxy",90,25}).ok);
    const auto snapshot=h.call("snapshot",json(R"({"from":"2026-10-01","to":"2026-10-01","includeMinutes":true})"));
    WIFIMETER_CHECK(snapshot.ok());
    const auto* daily=snapshot.result.find("proxyEstimatedRecords");
    const auto* minutes=snapshot.result.find("proxyEstimatedMinuteRecords");
    WIFIMETER_CHECK(daily && daily->size()==2 && minutes && minutes->size()==4);
    if (!daily || daily->size()!=2 || !minutes || minutes->size()!=4) return;
    // 连接数是 1:2，但回环字节是 2:1（下载）和 4:1（上传）。
    WIFIMETER_CHECK_EQ(daily->at(0).stringOr("appId"),std::string("a.exe"));
    WIFIMETER_CHECK_EQ(daily->at(0).stringOr("rxBytes"),std::string("660"));
    WIFIMETER_CHECK_EQ(daily->at(0).stringOr("txBytes"),std::string("220"));
    WIFIMETER_CHECK_EQ(daily->at(1).stringOr("rxBytes"),std::string("330"));
    WIFIMETER_CHECK_EQ(daily->at(1).stringOr("txBytes"),std::string("55"));
    WIFIMETER_CHECK(!daily->at(0).has("time"));
    WIFIMETER_CHECK_EQ(minutes->at(0).stringOr("time"),std::string("00:00"));
    WIFIMETER_CHECK_EQ(minutes->at(0).stringOr("rxBytes"),std::string("600"));
    WIFIMETER_CHECK_EQ(minutes->at(0).stringOr("txBytes"),std::string("200"));
    WIFIMETER_CHECK_EQ(minutes->at(1).stringOr("rxBytes"),std::string("300"));
    WIFIMETER_CHECK_EQ(minutes->at(1).stringOr("txBytes"),std::string("50"));
    WIFIMETER_CHECK_EQ(minutes->at(2).stringOr("time"),std::string("00:07"));
    WIFIMETER_CHECK_EQ(minutes->at(2).stringOr("rxBytes"),std::string("60"));
    WIFIMETER_CHECK_EQ(minutes->at(2).stringOr("txBytes"),std::string("20"));
    WIFIMETER_CHECK_EQ(minutes->at(3).stringOr("rxBytes"),std::string("30"));
    WIFIMETER_CHECK_EQ(minutes->at(3).stringOr("txBytes"),std::string("5"));
    WIFIMETER_CHECK(!h.call("snapshot").result.find("proxyEstimatedMinuteRecords")->size());

    // 实时事件只在分组变化时携带当前分钟的估算。
    const auto updatesOf=[](const ipc::BackendService::Events& events) -> const JsonValue* {
        for (const auto& item : events.items) if (item.has("proxyEstimatedMinuteUpdates")) return item.find("proxyEstimatedMinuteUpdates");
        return nullptr;
    };
    const auto first=h.service->collectOnce(start+std::chrono::seconds(15));
    const auto* updates=updatesOf(first);
    WIFIMETER_CHECK(updates && updates->size()==1);
    if (updates && updates->size())
    {
        WIFIMETER_CHECK_EQ(updates->at(0).stringOr("time"),std::string("00:00"));
        WIFIMETER_CHECK_EQ(updates->at(0).find("records")->size(),std::size_t(2));
    }
    WIFIMETER_CHECK(updatesOf(h.service->collectOnce(start+std::chrono::seconds(20)))==nullptr);

    WIFIMETER_CHECK(h.call("clearUsage").ok());
    WIFIMETER_CHECK_EQ(h.count("proxy_minute_weights"),std::int64_t(0));
}

int main(int argc, char** argv)
{
    test::useTimeZone("UTC");
    proxyClientIdentityIsExplicitInMemory();
    if (argc == 2 && std::string(argv[1]) == "--memory") return WIFIMETER_REPORT();
    loopbackBytesAreLiveButNotWifiUsage();
    helperResolvesOnlyMatchingCurrentConnections();
    estimatedUpdatesReplaceOnlyChangedDayNetworkProxyGroups();
    persistsProxyConfig();
    samplesAtMostEveryFiveSecondsAndDeduplicatesAcrossRestarts();
    discoversClientsOnSaveWithoutStartingByteCollection();
    detectedClientsNeverBecomeByteWeights();
    explainsCollectionAndPermissionState();
    keepsRawRecordsAndSelectsTheRequestedNetworkAndDay();
    minuteWeightsFollowLoopbackBytesPerDirection();
    validatesConfigWithoutOverwritingTheSavedValue();
    retentionAndClearFollowTheUserSettings();
    failedObservationDoesNotWritePartialEvidence();
    nativeAvailabilityIsExplicit();
    fullBackupRestoresProxyEvidenceWithoutOnStart();
    fullBackupRestoresProxyMinuteWeights();
    rejectsInvalidProxyMinuteWeightsBeforeReplacingData();
    acceptsMinuteWeightIntegerBoundaries();
    migratesOnlyInitialProxySettingsInTheImportTransaction();
    return WIFIMETER_REPORT();
}
