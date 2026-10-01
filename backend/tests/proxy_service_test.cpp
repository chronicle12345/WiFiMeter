#include "../ipc/service.h"
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
    void start() override {}
    void stop() override {}
    platform::AppTrafficReport read() override { return {platform::AppCollectorState::running, "generation", {}, {}}; }
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
    void raw(const std::string& network, const std::string& day, const std::string& appId, std::uint64_t rx, std::uint64_t tx)
    {
        bool created=false;
        WIFIMETER_CHECK(store->networks().observe({network,"WiFi"},"2026-10-01T00:00:00Z",created).ok);
        WIFIMETER_CHECK(store->usage().addApp({network,day,appId,appId,rx,tx}).ok);
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
void samplesAtMostEveryFiveSecondsAndDeduplicatesAcrossRestarts()
{
    Harness harness;
    harness.proxyReport=observed();
    const auto start=utcTime(2026,10,1,0,0,0);
    configure(harness);
    harness.service->collectOnce(start);
    WIFIMETER_CHECK_EQ(harness.proxyCalls,0);
    enable(harness);
    harness.service->collectOnce(start);
    harness.service->collectOnce(start+std::chrono::seconds(1));
    harness.service->collectOnce(start+std::chrono::seconds(4));
    WIFIMETER_CHECK_EQ(harness.proxyCalls,1);
    harness.call("snapshot");
    WIFIMETER_CHECK_EQ(harness.proxyCalls,1);
    harness.service->collectOnce(start+std::chrono::seconds(5));
    WIFIMETER_CHECK_EQ(harness.proxyCalls,2);
    WIFIMETER_CHECK_EQ(harness.count("proxy_observations"),std::int64_t(3));
    WIFIMETER_CHECK_EQ(harness.count("proxy_apps"),std::int64_t(2));
    configure(harness);
    harness.service->collectOnce(start+std::chrono::seconds(6));
    WIFIMETER_CHECK_EQ(harness.proxyCalls,2);
    harness.restart();
    enable(harness);
    harness.service->collectOnce(start+std::chrono::seconds(10));
    WIFIMETER_CHECK_EQ(harness.count("proxy_observations"),std::int64_t(3));
    enable(harness,false);
    harness.service->collectOnce(start+std::chrono::seconds(15));
    WIFIMETER_CHECK_EQ(harness.proxyCalls,3);
    enable(harness);
    WIFIMETER_CHECK(harness.call("updateProxyConfig",json(R"({"ports":[],"processNames":[]})")).ok());
    harness.service->collectOnce(start+std::chrono::seconds(20));
    WIFIMETER_CHECK_EQ(harness.proxyCalls,3);
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
        if (field.first!="proxyConfig" && field.first!="proxyApps" && field.first!="proxyObservations") legacy.set(field.first,field.second);
    WIFIMETER_CHECK(restored.call("restore",restoreParams(legacy)).ok());
    WIFIMETER_CHECK_EQ(restored.count("proxy_config"),std::int64_t(0));
    WIFIMETER_CHECK_EQ(restored.count("proxy_apps"),std::int64_t(0));
    WIFIMETER_CHECK_EQ(restored.count("proxy_observations"),std::int64_t(0));
    const auto cleared=restored.call("snapshot",query);
    WIFIMETER_CHECK_EQ(cleared.result.find("proxy")->find("ports")->size(),std::size_t(0));
    WIFIMETER_CHECK_EQ(cleared.result.find("appRecords")->dump(),document.find("appRecords")->dump());
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
int main()
{
    test::useTimeZone("UTC");
    persistsProxyConfig();
    samplesAtMostEveryFiveSecondsAndDeduplicatesAcrossRestarts();
    keepsRawRecordsAndSelectsTheRequestedNetworkAndDay();
    validatesConfigWithoutOverwritingTheSavedValue();
    retentionAndClearFollowTheUserSettings();
    failedObservationDoesNotWritePartialEvidence();
    nativeAvailabilityIsExplicit();
    fullBackupRestoresProxyEvidenceWithoutOnStart();
    migratesOnlyInitialProxySettingsInTheImportTransaction();
    return WIFIMETER_REPORT();
}
