#include "../ipc/legacy_import.h"
#include "../ipc/service.h"
#include "test_support.h"
using namespace wifimeter;
using support::JsonValue;

namespace {
JsonValue request(const std::string& source="fixture")
{
    auto params=JsonValue::makeObject();
    params.set("sourceId",JsonValue::makeString(source));
    params.set("stateJson",JsonValue::makeString(R"({"SchemaVersion":1,"StartedAt":"2020-01-01T00:00:00.0000000+00:00","UpdatedAt":"2020-01-02T00:00:00Z","QuotaLedger":{"Total":{"UsedBytes":"999999999999999999999"}},"Networks":[{"SSID":"虚构Cafe","RxBytes":9007199254740993,"TxBytes":7,"FirstSeen":"2020-01-01T00:00:00Z","LastSeen":"2020-01-02T00:00:00Z","Days":[{"Date":"2020-01-01","RxBytes":9007199254740993,"TxBytes":7}]},{"SSID":"虚构cafe","RxBytes":3,"TxBytes":0,"FirstSeen":"2020-01-01T00:00:00Z","LastSeen":"2020-01-02T00:00:00Z","Days":[{"Date":"2020-01-01","RxBytes":3,"TxBytes":0}]}]})"));
    params.set("settingsJson",JsonValue::makeString(R"({"Language":"zh-CN","RetentionDays":1234,"Proxy":{"Ports":[12345]}})"));
    params.set("appUsageJson",JsonValue::makeString(R"({"SchemaVersion":1,"Records":[{"Result":{"Days":[]}}]})"));
    return params;
}
std::int64_t rows(storage::Store& store,const std::string& table)
{
    storage::Status status;
    auto stmt=store.database().prepare("SELECT COUNT(*) FROM "+table,status);
    WIFIMETER_CHECK(stmt.has_value());
    return stmt && stmt->step() ? stmt->columnInt64(0) : -1;
}
void importsAndRetries()
{
    storage::Status status;
    auto store=storage::Store::open(":memory:",status);
    WIFIMETER_CHECK(store != nullptr);
    JsonValue out; std::string code;
    auto params=request();
    params.set("stateJson",JsonValue::makeString(std::string("\xEF\xBB\xBF")+params.stringOr("stateJson")));
    WIFIMETER_CHECK(ipc::legacyMigrationStatus(*store,params,out,code));
    WIFIMETER_CHECK_EQ(out.stringOr("status"),std::string("notImported"));
    WIFIMETER_CHECK(ipc::importLegacy(*store,params,test::utcTime(2026,1,1),out,code));
    WIFIMETER_CHECK_EQ(rows(*store,"networks"),2);
    WIFIMETER_CHECK_EQ(rows(*store,"daily_usage"),2);
    WIFIMETER_CHECK_EQ(rows(*store,"hourly_usage"),0);
    const auto key=core::fallbackKeyForSsid("虚构Cafe");
    const auto daily=store->usage().dailyRange(key,"2020-01-01","2020-01-01",status);
    WIFIMETER_CHECK_EQ(daily.size(),std::size_t(1));
    if (!daily.empty()) WIFIMETER_CHECK_EQ(daily[0].rxBytes,9007199254740993ULL);
    WIFIMETER_CHECK(ipc::importLegacy(*store,params,test::utcTime(2026,1,1),out,code));
    WIFIMETER_CHECK(out.boolOr("alreadyImported"));
    WIFIMETER_CHECK_EQ(rows(*store,"daily_usage"),2);
    auto changed=params; changed.set("stateJson",JsonValue::makeString(params.stringOr("stateJson")+" "));
    WIFIMETER_CHECK(!ipc::importLegacy(*store,changed,test::utcTime(2026,1,1),out,code));
    WIFIMETER_CHECK_EQ(code,std::string("LegacySourceChanged"));
    WIFIMETER_CHECK(!ipc::importLegacy(*store,request("another"),test::utcTime(2026,1,1),out,code));
    WIFIMETER_CHECK_EQ(code,std::string("LegacyOverlap"));
    WIFIMETER_CHECK_EQ(rows(*store,"legacy_imports"),1);
    auto archive=store->database().prepare("SELECT state_json,settings_json,app_usage_json FROM legacy_imports",status);
    WIFIMETER_CHECK(archive->step());
    WIFIMETER_CHECK_EQ(archive->columnText(0),params.stringOr("stateJson"));
    WIFIMETER_CHECK_EQ(archive->columnText(1),params.stringOr("settingsJson"));
    WIFIMETER_CHECK_EQ(archive->columnText(2),params.stringOr("appUsageJson"));
    auto settings=store->settings().load(status);
    WIFIMETER_CHECK_EQ(settings.language,std::string("en"));
    WIFIMETER_CHECK_EQ(settings.retentionDays,90);
    platform::SampleReport sample;
    sample.samples.emplace_back();
    sample.samples.back().identity.ssid="虚构Cafe";
    sample.samples.back().identity.profileUuid="different-real-profile";
    WIFIMETER_CHECK(ipc::mapLegacyNetworks(store->database(),sample));
    WIFIMETER_CHECK_EQ(core::networkRefOf(sample.samples[0].identity).key,key);
    WIFIMETER_CHECK(store->usage().add(core::networkRefOf(sample.samples[0].identity),core::LocalStamp{2020,1,1,12},2,1));
    const auto continued=store->usage().dailyRange(key,"2020-01-01","2020-01-01",status);
    WIFIMETER_CHECK_EQ(continued[0].rxBytes,9007199254740995ULL);
}
void rollbackAndProtection()
{
    storage::Status status;
    auto store=storage::Store::open(":memory:",status);
    auto params=request(); JsonValue out; std::string code;
    auto text=params.stringOr("stateJson");
    const auto pos=text.find("\"RxBytes\":3");
    text.replace(pos,std::string("\"RxBytes\":3").size(),"\"RxBytes\":4");
    params.set("stateJson",JsonValue::makeString(text));
    WIFIMETER_CHECK(!ipc::importLegacy(*store,params,test::utcTime(2026,1,1),out,code));
    for (const auto* table : {"networks","daily_usage","legacy_network_keys","legacy_imports"})
        WIFIMETER_CHECK_EQ(rows(*store,table),0);
    WIFIMETER_CHECK(store->database().exec("CREATE TRIGGER reject_archive BEFORE INSERT ON legacy_imports BEGIN SELECT RAISE(ABORT,'fictional failure'); END"));
    WIFIMETER_CHECK(!ipc::importLegacy(*store,request(),test::utcTime(2026,1,1),out,code));
    WIFIMETER_CHECK_EQ(rows(*store,"daily_usage"),0);
    WIFIMETER_CHECK_EQ(rows(*store,"settings"),1);
    WIFIMETER_CHECK(store->database().exec("DROP TRIGGER reject_archive"));
    storage::NetworkRecord record; record.key="real-profile"; record.ssid="虚构Cafe"; record.alias="keep";
    WIFIMETER_CHECK(store->networks().replace(record));
    WIFIMETER_CHECK(store->usage().setDaily(record.key,"2020-01-01",12,13));
    storage::SettingsRecord settings; settings.language="en"; settings.retentionDays=36500;
    WIFIMETER_CHECK(store->settings().save(settings));
    WIFIMETER_CHECK(!ipc::importLegacy(*store,request(),test::utcTime(2026,1,1),out,code));
    WIFIMETER_CHECK_EQ(code,std::string("LegacyOverlap"));
    const auto protectedNetwork=store->networks().find(record.key,status);
    const auto protectedDays=store->usage().dailyRange(record.key,"2020-01-01","2020-01-01",status);
    WIFIMETER_CHECK_EQ(protectedNetwork->alias,std::string("keep"));
    WIFIMETER_CHECK_EQ(protectedDays[0].rxBytes,12ULL);
    WIFIMETER_CHECK_EQ(store->settings().load(status).retentionDays,36500);
    WIFIMETER_CHECK_EQ(rows(*store,"legacy_imports"),0);
}
void importsCachedDaysAndInitialSettings()
{
    storage::Status status;
    auto store=storage::Store::open(":memory:",status);
    auto params=request();
    params.set("allowInitialSettings",JsonValue::makeBool(true));
    const std::string cache=R"({"SchemaVersion":1,"Records":[{"SSID":"虚构Cafe","StartDate":"2020-01-01","EndDate":"2020-01-01","Result":{"Available":true,"MessageCode":"Available","UpdatedAt":"2020-01-02T00:00:00Z","EffectiveStart":"2020-01-01T00:00:00+00:00","EffectiveEnd":"2020-01-02T00:00:00+00:00","RequestedDays":1,"CompletedDays":1,"Rows":[],"Days":[{"Date":"2020-01-01","AppId":"fixture-app","Name":"Fixture","RxBytes":9007199254740993,"TxBytes":1,"TotalBytes":9007199254740994}]}},{"SSID":"虚构Cafe","StartDate":"2020-01-01","EndDate":"2020-01-01","Result":{"Available":true,"MessageCode":"Available","UpdatedAt":"2020-01-02T00:00:00Z","EffectiveStart":"2020-01-01T00:00:00+00:00","EffectiveEnd":"2020-01-02T00:00:00+00:00","RequestedDays":1,"CompletedDays":1,"Rows":[],"Days":[{"Date":"2020-01-01","AppId":"fixture-app","Name":"Fixture","RxBytes":9007199254740993,"TxBytes":1,"TotalBytes":9007199254740994}]}}]})";
    params.set("appUsageJson",JsonValue::makeString(cache));
    JsonValue out; std::string code;
    WIFIMETER_CHECK(ipc::importLegacy(*store,params,test::utcTime(2026,1,1),out,code));
    WIFIMETER_CHECK_EQ(rows(*store,"app_usage"),1);
    WIFIMETER_CHECK_EQ(store->settings().load(status).language,std::string("zh-CN"));
    WIFIMETER_CHECK_EQ(store->settings().load(status).retentionDays,1234);
    WIFIMETER_CHECK_EQ(out.intOr("appRecordCount"),1);
    WIFIMETER_CHECK(ipc::importLegacy(*store,params,test::utcTime(2026,1,1),out,code));
    WIFIMETER_CHECK_EQ(rows(*store,"app_usage"),1);
    WIFIMETER_CHECK(ipc::legacyMigrationStatus(*store,params,out,code));
    WIFIMETER_CHECK_EQ(out.intOr("appRecordCount"),1);
    WIFIMETER_CHECK(out.boolOr("settingsApplied"));

    const auto exerciseArchiveOnly = [&](std::string modified) {
        auto other=storage::Store::open(":memory:",status);
        auto input=request(); input.set("appUsageJson",JsonValue::makeString(modified));
        WIFIMETER_CHECK(ipc::importLegacy(*other,input,test::utcTime(2026,1,1),out,code));
        WIFIMETER_CHECK_EQ(rows(*other,"app_usage"),0);
        WIFIMETER_CHECK(out.intOr("appArchivedOnlyCount")>0);
        WIFIMETER_CHECK(out.find("warnings") && out.find("warnings")->size()>0);
        const auto warnings=out.find("warnings")->dump();
        WIFIMETER_CHECK(ipc::legacyMigrationStatus(*other,input,out,code));
        WIFIMETER_CHECK_EQ(out.find("warnings")->dump(),warnings);
    };
    auto conflict=cache;
    const auto last=conflict.rfind("9007199254740993");
    conflict.replace(last,16,"9007199254740992");
    conflict.replace(conflict.rfind("9007199254740994"),16,"9007199254740993");
    exerciseArchiveOnly(conflict);
    auto partial=cache;
    std::size_t pos=0;
    const std::string midnight="2020-01-01T00:00:00+00:00";
    while ((pos=partial.find(midnight,pos))!=std::string::npos) { partial.replace(pos,midnight.size(),"2020-01-01T12:00:00+00:00"); pos+=midnight.size(); }
    exerciseArchiveOnly(partial);

    auto existing=storage::Store::open(":memory:",status);
    storage::NetworkRecord network; network.key="fixture-existing"; network.ssid="虚构Cafe";
    WIFIMETER_CHECK(existing->networks().replace(network));
    WIFIMETER_CHECK(existing->usage().setApp({network.key,"2020-01-01","fixture-app","Keep",12,13}));
    auto input=request(); input.set("appUsageJson",JsonValue::makeString(cache));
    WIFIMETER_CHECK(ipc::importLegacy(*existing,input,test::utcTime(2026,1,1),out,code));
    const auto kept=existing->usage().appRange(network.key,"2020-01-01","2020-01-01",status);
    WIFIMETER_CHECK_EQ(kept[0].rxBytes,12ULL);
    WIFIMETER_CHECK(out.intOr("appArchivedOnlyCount")>0);

    auto protectedStore=storage::Store::open(":memory:",status);
    auto custom=protectedStore->settings().load(status); custom.retentionDays=7;
    WIFIMETER_CHECK(protectedStore->settings().save(custom));
    WIFIMETER_CHECK(!ipc::importLegacy(*protectedStore,params,test::utcTime(2026,1,1),out,code));
    WIFIMETER_CHECK_EQ(code,std::string("LegacyInitialSettingsConflict"));
    WIFIMETER_CHECK_EQ(rows(*protectedStore,"daily_usage"),0);
    WIFIMETER_CHECK_EQ(protectedStore->settings().load(status).retentionDays,7);
}

void separatesWiredIdentity()
{
    storage::Status status;
    auto store=storage::Store::open(":memory:",status);
    auto params=request("wired");
    auto raw=params.stringOr("stateJson");
    std::size_t pos=0;
    while ((pos=raw.find("虚构Cafe",pos))!=std::string::npos) { raw.replace(pos,std::string("虚构Cafe").size(),"Ethernet:fixture"); pos+=16; }
    params.set("stateJson",JsonValue::makeString(raw));
    storage::NetworkRecord wifi; wifi.key=core::fallbackKeyForSsid("Ethernet:fixture"); wifi.ssid="Ethernet:fixture"; wifi.type="wifi";
    WIFIMETER_CHECK(store->networks().replace(wifi));
    JsonValue out; std::string code;
    WIFIMETER_CHECK(ipc::importLegacy(*store,params,test::utcTime(2026,1,1),out,code));
    platform::SampleReport samples;
    samples.samples.emplace_back(); samples.samples.emplace_back();
    for (auto& sample:samples.samples) { sample.identity.ssid="Ethernet:fixture"; sample.identity.profileUuid="original-profile"; }
    samples.samples[1].identity.type="ethernet";
    WIFIMETER_CHECK(ipc::mapLegacyNetworks(store->database(),samples));
    WIFIMETER_CHECK_EQ(samples.samples[0].identity.profileUuid.value(),std::string("original-profile"));
    WIFIMETER_CHECK(samples.samples[1].identity.profileUuid.value()!="original-profile");
    WIFIMETER_CHECK(samples.samples[1].identity.profileUuid.value()!=wifi.key);
}

void initialRetentionPreventsHistoryPruning()
{
    storage::Status status;
    JsonValue out; std::string code;
    for (const int retention : {0,12,36500})
    {
        auto store=storage::Store::open(":memory:",status);
        auto input=request();
        input.set("allowInitialSettings",JsonValue::makeBool(true));
        input.set("settingsJson",JsonValue::makeString("{\"Language\":\"zh-CN\",\"RetentionDays\":"+std::to_string(retention)+"}"));
        WIFIMETER_CHECK(ipc::importLegacy(*store,input,test::utcTime(2026,1,1),out,code));
        WIFIMETER_CHECK(out.boolOr("settingsApplied"));
        WIFIMETER_CHECK_EQ(store->settings().load(status).retentionDays,retention);
        if (retention==0)
        {
            std::size_t daily=0,hourly=0;
            WIFIMETER_CHECK(store->pruneByRetention(test::utcTime(2026,1,1),daily,hourly));
            WIFIMETER_CHECK_EQ(daily,std::size_t(0));
            WIFIMETER_CHECK_EQ(rows(*store,"daily_usage"),2);
        }
    }
    for (const bool explicitFalse : {false,true})
    {
        auto store=storage::Store::open(":memory:",status);
        auto input=request();
        input.set("settingsJson",JsonValue::makeString("{\"Language\":\"zh-CN\",\"RetentionDays\":0}"));
        if (explicitFalse) input.set("allowInitialSettings",JsonValue::makeBool(false));
        WIFIMETER_CHECK(ipc::importLegacy(*store,input,test::utcTime(2026,1,1),out,code));
        WIFIMETER_CHECK(!out.boolOr("settingsApplied"));
        WIFIMETER_CHECK_EQ(store->settings().load(status).retentionDays,90);
        WIFIMETER_CHECK_EQ(store->settings().load(status).language,std::string("en"));
    }
}

void importsNetworkPoliciesAndIndependentLedgers()
{
    test::useTimeZone("UTC");
    storage::Status status; JsonValue out; std::string code;
    for (const auto& period:std::vector<std::pair<std::string,std::string>>{{"Day","2026-01-01"},{"Month","2026-01"},{"All","all"}})
    {
        auto store=storage::Store::open(":memory:",status);
        auto input=request();
        input.set("settingsJson",JsonValue::makeString("{\"Networks\":[{\"SSID\":\"虚构Cafe\",\"Alias\":\"旧备注\",\"LimitGB\":12.5,\"Period\":\""+period.first+"\",\"WarnPercent\":73,\"DisconnectAtLimit\":true}]}"));
        auto raw=input.stringOr("stateJson");
        const std::string ledgerPeriod=period.first=="All" ? "All" : period.first+":"+period.second;
        raw.insert(1,"\"QuotaLedger\":{\"Version\":1,\"Networks\":[{\"SSID\":\"虚构Cafe\",\"UsedBytes\":9007199254740995.0,\"PeriodKey\":\""+ledgerPeriod+"\"}]},");
        // request() 中的 Total 由另一模块处理；本夹具只保留本次插入的网络账本。
        const auto old=raw.find("\"QuotaLedger\":{\"Total\"");
        const auto end=raw.find(",\"Networks\":[",old);
        raw.erase(old,end-old+1);
        input.set("stateJson",JsonValue::makeString(raw));
        WIFIMETER_CHECK(ipc::importLegacy(*store,input,test::utcTime(2026,1,1),out,code));
        const auto key=core::fallbackKeyForSsid("虚构Cafe");
        const auto network=store->networks().find(key,status);
        WIFIMETER_CHECK(network.has_value());
        if (network)
        {
            WIFIMETER_CHECK_EQ(network->alias,std::string("旧备注"));
            WIFIMETER_CHECK_EQ(network->capGb,12.5);
            WIFIMETER_CHECK_EQ(network->warnPercent,73);
            WIFIMETER_CHECK(network->autoDisconnect && network->notify);
            WIFIMETER_CHECK_EQ(core::periodKeyFor(network->quotaPeriod,test::utcTime(2026,1,1)),period.second);
        }
        const auto ledger=store->networks().ledger(key,status);
        WIFIMETER_CHECK(ledger.has_value());
        if (ledger) { WIFIMETER_CHECK_EQ(ledger->usedBytes,9007199254740995ULL); WIFIMETER_CHECK_EQ(ledger->periodKey,period.second); }
        WIFIMETER_CHECK(ipc::importLegacy(*store,input,test::utcTime(2026,1,1),out,code));
        WIFIMETER_CHECK_EQ(out.intOr("ledgerCount"),1);
    }
    auto initial=storage::Store::open(":memory:",status);
    auto input=request(); auto noSettings=JsonValue::makeObject();
    noSettings.set("sourceId",*input.find("sourceId")); noSettings.set("stateJson",*input.find("stateJson"));
    noSettings.set("allowInitialSettings",JsonValue::makeBool(true));
    WIFIMETER_CHECK(ipc::importLegacy(*initial,noSettings,test::utcTime(2026,1,1),out,code));
    WIFIMETER_CHECK_EQ(initial->settings().load(status).retentionDays,0);
}

JsonValue ledgerFixture(const std::string& value,const std::string& period="All")
{
    auto input=JsonValue::makeObject(); input.set("sourceId",JsonValue::makeString("ledger-fixture"));
    input.set("stateJson",JsonValue::makeString("{\"SchemaVersion\":1,\"StartedAt\":\"2020-01-01T00:00:00Z\",\"UpdatedAt\":\"2026-01-01T00:00:00Z\",\"Networks\":[{\"SSID\":\"LedgerFixture\",\"RxBytes\":0,\"TxBytes\":0,\"FirstSeen\":\"2020-01-01T00:00:00Z\",\"LastSeen\":\"2026-01-01T00:00:00Z\",\"Days\":[]}],\"QuotaLedger\":{\"Version\":1,\"Networks\":[{\"SSID\":\"LedgerFixture\",\"PeriodKey\":\""+period+"\",\"UsedBytes\":"+value+"}]}}"));
    input.set("settingsJson",JsonValue::makeString(R"({"Networks":[{"SSID":"LedgerFixture","Alias":"Imported","LimitGB":100,"Period":"All","WarnPercent":80,"DisconnectAtLimit":true}]})"));
    return input;
}
void importsFractionalWarningThreshold()
{
    for (const auto& token : std::vector<std::string>{"85.5", "8.55e1", "\"85.5\"", "79.9999999999999999999"})
    {
        storage::Status status; JsonValue out; std::string code;
        auto store=storage::Store::open(":memory:",status);
        auto input=ledgerFixture("854");
        input.set("allowInitialSettings",JsonValue::makeBool(true));
        const std::string policy="\"LimitGB\":0.000001,\"Period\":\"All\",\"WarnPercent\":"+token;
        input.set("settingsJson",JsonValue::makeString("{\"TotalLimit\":{"+policy+"},\"Networks\":[{\"SSID\":\"LedgerFixture\","+policy+"}]}"));
        WIFIMETER_CHECK(ipc::importLegacy(*store,input,test::utcTime(2026,1,1),out,code));
        WIFIMETER_CHECK_EQ(out.intOr("networkPolicyCount"),1);
        WIFIMETER_CHECK(out.boolOr("totalQuotaApplied"));
        const auto network=store->networks().find(core::fallbackKeyForSsid("LedgerFixture"),status);
        WIFIMETER_CHECK(network.has_value());
        const double expected=token=="79.9999999999999999999" ? 80.0 : 85.5;
        if (network) {
            WIFIMETER_CHECK_EQ(network->warnPercent,expected);
            WIFIMETER_CHECK_EQ(network->warnPercents.size(),std::size_t{1});
            WIFIMETER_CHECK_EQ(network->warnPercents.front(),expected);
        }
        WIFIMETER_CHECK_EQ(store->totalQuota().load(status).settings.warnPercent,expected);
        WIFIMETER_CHECK_EQ(store->totalQuota().load(status).settings.warnPercents.size(),std::size_t{1});
    }
}

void ledgerPrecisionWarningsAndExistingProtection()
{
    storage::Status status; JsonValue out; std::string code;
    const auto key=core::fallbackKeyForSsid("LedgerFixture");
    for (const auto& token:std::vector<std::string>{"9223372036854775807.0","\"9223372036854775807\"","9.223372036854775807e18"})
    {
        auto store=storage::Store::open(":memory:",status);
        WIFIMETER_CHECK(ipc::importLegacy(*store,ledgerFixture(token),test::utcTime(2026,1,1),out,code));
        const auto ledger=store->networks().ledger(key,status);
        WIFIMETER_CHECK(ledger.has_value());
        if (ledger) WIFIMETER_CHECK_EQ(ledger->usedBytes,9223372036854775807ULL);
        WIFIMETER_CHECK_EQ(rows(*store,"daily_usage"),0);
    }
    for (const auto& input:std::vector<JsonValue>{ledgerFixture("9223372036854775808.0"),ledgerFixture("1.5"),ledgerFixture("\"unknown\""),ledgerFixture("12","Week:2026-01")})
    {
        auto store=storage::Store::open(":memory:",status);
        WIFIMETER_CHECK(ipc::importLegacy(*store,input,test::utcTime(2026,1,1),out,code));
        WIFIMETER_CHECK(!store->networks().ledger(key,status));
        WIFIMETER_CHECK(out.find("warnings") && out.find("warnings")->size()>0);
        auto archive=store->database().prepare("SELECT state_json FROM legacy_imports",status);
        WIFIMETER_CHECK(archive && archive->step());
        if (archive) WIFIMETER_CHECK_EQ(archive->columnText(0),input.stringOr("stateJson"));
    }
    for (const auto& policy:std::vector<std::string>{
        R"({"Networks":[{"SSID":"LedgerFixture","LimitGB":0.0000000011,"Period":"All"}]})",
        R"({"Networks":[{"SSID":"LedgerFixture","LimitGB":100,"WarnPercent":100.1}]})"})
    {
        auto store=storage::Store::open(":memory:",status);
        auto input=ledgerFixture("12"); input.set("settingsJson",JsonValue::makeString(policy));
        WIFIMETER_CHECK(ipc::importLegacy(*store,input,test::utcTime(2026,1,1),out,code));
        WIFIMETER_CHECK_EQ(out.intOr("networkPolicyCount"),0);
        WIFIMETER_CHECK(out.find("warnings") && out.find("warnings")->size()>0);
    }
    auto existing=storage::Store::open(":memory:",status);
    storage::NetworkRecord record; record.key=key; record.ssid="LedgerFixture"; record.alias="Keep"; record.capGb=7;
    WIFIMETER_CHECK(existing->networks().replace(record));
    WIFIMETER_CHECK(existing->networks().saveLedger({key,"all",55}));
    WIFIMETER_CHECK(ipc::importLegacy(*existing,ledgerFixture("999"),test::utcTime(2026,1,1),out,code));
    const auto keptNetwork=existing->networks().find(key,status);
    const auto keptLedger=existing->networks().ledger(key,status);
    WIFIMETER_CHECK(keptNetwork && keptLedger);
    if (keptNetwork && keptLedger)
    {
        WIFIMETER_CHECK_EQ(keptNetwork->alias,std::string("Keep"));
        WIFIMETER_CHECK_EQ(keptNetwork->capGb,7.0);
        WIFIMETER_CHECK_EQ(keptLedger->usedBytes,55ULL);
    }
    WIFIMETER_CHECK_EQ(out.intOr("networkPolicyCount"),0);
    WIFIMETER_CHECK_EQ(out.intOr("ledgerCount"),0);
    WIFIMETER_CHECK(out.find("warnings") && out.find("warnings")->size()>=2);
}

void rejectsMalformedNumbersBeforeQuoting()
{
    for (const auto& token : std::vector<std::string>{"0123","-0123","1.","1e","1e+","1e-","1.e2","--1","1..2","1e2.3","1+2","+1",".1","0x12","1E++2","-"})
    {
        for (const auto* field : {"UsedBytes","LimitGB","WarnPercent"})
        {
            storage::Status status; JsonValue out; std::string code;
            auto store=storage::Store::open(":memory:",status);
            auto input=ledgerFixture(std::string(field)=="UsedBytes" ? token : "12");
            if (std::string(field)!="UsedBytes")
                input.set("settingsJson",JsonValue::makeString("{\"Networks\":[{\"SSID\":\"LedgerFixture\",\""+std::string(field)+"\":"+token+"}]}"));
            WIFIMETER_CHECK(!ipc::importLegacy(*store,input,test::utcTime(2026,1,1),out,code));
            WIFIMETER_CHECK_EQ(code,std::string("LegacyInvalid"));
            WIFIMETER_CHECK_EQ(rows(*store,"legacy_imports"),0);
            WIFIMETER_CHECK_EQ(rows(*store,"networks"),0);
        }
    }
    // 转义后的目标 key 也必须使用同一套严格数值语法。
    for (const auto& raw : std::vector<std::string>{
        R"({"Limit\u0047B":0123})",R"({"Warn\u0050ercent":1.})",R"({"Used\u0042ytes":1e})",
        R"({"UsedBytes":12"Other":0})",R"({"UsedBytes":1 /* comment */})",
        R"({"Other":0123})",R"({"Bad\qKey":123})"})
    {
        storage::Status status; JsonValue out; std::string code;
        auto store=storage::Store::open(":memory:",status);
        auto input=ledgerFixture("12"); input.set("settingsJson",JsonValue::makeString(raw));
        WIFIMETER_CHECK(!ipc::importLegacy(*store,input,test::utcTime(2026,1,1),out,code));
        WIFIMETER_CHECK_EQ(code,std::string("LegacyInvalid"));
        WIFIMETER_CHECK_EQ(rows(*store,"legacy_imports"),0);
    }
}

void preservesEscapedKeysExactNumbersAndRawArchives()
{
    for (const auto& example : std::vector<std::pair<std::string,std::uint64_t>>{
        {"0",0},{"0.0",0},{"0e+2",0},{"1e+3",1000},{"1E-0",1},
        {"9007199254740993.000",9007199254740993ULL},
        {"9223372036854775807",9223372036854775807ULL},
        {"9.223372036854775807e+18",9223372036854775807ULL},
        {"\"9223372036854775807\"",9223372036854775807ULL}})
    {
        storage::Status status; JsonValue out; std::string code;
        auto store=storage::Store::open(":memory:",status);
        auto input=ledgerFixture(example.first);
        auto state=input.stringOr("stateJson");
        const auto key=state.find("\"UsedBytes\"");
        state.replace(key,std::string("\"UsedBytes\"").size(),R"("Used\u0042ytes")");
        state=std::string("\xEF\xBB\xBF")+state;
        const std::string settings=R"({"Description":"literal \"UsedBytes\":0123 and slash \\","OrdinaryName":"UsedBytes","Networks":[{"SSID":"LedgerFixture","Limit\u0047B":0.000000001,"Warn\u0050ercent":7.9e1,"Period":"All"}]})";
        input.set("stateJson",JsonValue::makeString(state));
        input.set("settingsJson",JsonValue::makeString(settings));
        WIFIMETER_CHECK(ipc::importLegacy(*store,input,test::utcTime(2026,1,1),out,code));
        const auto networkKey=core::fallbackKeyForSsid("LedgerFixture");
        const auto ledger=store->networks().ledger(networkKey,status);
        WIFIMETER_CHECK(ledger.has_value());
        if (ledger) WIFIMETER_CHECK_EQ(ledger->usedBytes,example.second);
        const auto network=store->networks().find(networkKey,status);
        WIFIMETER_CHECK(network.has_value());
        if (network)
        {
            WIFIMETER_CHECK_EQ(network->capGb,0.000000001);
            WIFIMETER_CHECK_EQ(network->warnPercent,79);
        }
        auto archived=store->database().prepare("SELECT state_json,settings_json FROM legacy_imports",status);
        WIFIMETER_CHECK(archived && archived->step());
        if (archived)
        {
            WIFIMETER_CHECK_EQ(archived->columnText(0),state);
            WIFIMETER_CHECK_EQ(archived->columnText(1),settings);
        }
    }
}


void keepsExistingOverlapAndValidatesWholeSource()
{
    storage::Status status; JsonValue out; std::string code;
    for (const bool hourlyOnly : {false,true})
    {
        auto store=storage::Store::open(":memory:",status);
        storage::NetworkRecord network; network.key="existing"; network.ssid="虚构Cafe";
        WIFIMETER_CHECK(store->networks().replace(network));
        if (!hourlyOnly) WIFIMETER_CHECK(store->usage().setDaily(network.key,"2020-01-01",12,13));
        WIFIMETER_CHECK(store->usage().setHourly(network.key,"2020-01-01",8,5,6));
        auto input=request();
        auto raw=input.stringOr("stateJson");
        const auto date=raw.find("\"Date\":\"2020-01-01\"");
        raw.insert(date,"\"Date\":\"2020-01-02\",\"RxBytes\":0,\"TxBytes\":0},{");
        input.set("stateJson",JsonValue::makeString(raw));
        input.set("overlapPolicy",JsonValue::makeString("keep-existing"));
        auto bad=input;
        auto invalidRaw=raw; const auto total=invalidRaw.find("9007199254740993");
        invalidRaw.replace(total,16,"9007199254740994");
        bad.set("stateJson",JsonValue::makeString(invalidRaw));
        WIFIMETER_CHECK(!ipc::importLegacy(*store,bad,test::utcTime(2026,1,1),out,code));
        WIFIMETER_CHECK_EQ(code,std::string("LegacyInvalid"));
        WIFIMETER_CHECK_EQ(rows(*store,"daily_usage"),hourlyOnly ? 0 : 1);
        WIFIMETER_CHECK_EQ(rows(*store,"legacy_network_keys"),0);
        WIFIMETER_CHECK_EQ(rows(*store,"legacy_imports"),0);
        WIFIMETER_CHECK(store->database().exec("CREATE TRIGGER reject_archive BEFORE INSERT ON legacy_imports BEGIN SELECT RAISE(ABORT,'failure'); END"));
        WIFIMETER_CHECK(!ipc::importLegacy(*store,input,test::utcTime(2026,1,1),out,code));
        WIFIMETER_CHECK_EQ(rows(*store,"daily_usage"),hourlyOnly ? 0 : 1);
        WIFIMETER_CHECK_EQ(rows(*store,"networks"),1);
        WIFIMETER_CHECK_EQ(rows(*store,"legacy_network_keys"),0);
        WIFIMETER_CHECK_EQ(rows(*store,"legacy_imports"),0);
        WIFIMETER_CHECK(store->database().exec("DROP TRIGGER reject_archive"));
        const auto imported=ipc::importLegacy(*store,input,test::utcTime(2026,1,1),out,code);
        WIFIMETER_CHECK(imported);
        if (!imported) continue;
        WIFIMETER_CHECK_EQ(out.intOr("skippedDayCount"),1);
        WIFIMETER_CHECK_EQ(out.intOr("dailyCount"),2);
        WIFIMETER_CHECK(out.find("warnings") && out.find("warnings")->dump().find("2020-01-01")!=std::string::npos);
        const auto reportWarnings=out.find("warnings")->dump();
        const auto kept=store->usage().dailyRange(network.key,"2020-01-01","2020-01-01",status);
        WIFIMETER_CHECK_EQ(kept.size(),hourlyOnly ? std::size_t(0) : std::size_t(1));
        if (!kept.empty()) { WIFIMETER_CHECK_EQ(kept[0].rxBytes,12ULL); WIFIMETER_CHECK_EQ(kept[0].txBytes,13ULL); }
        const auto hourly=store->usage().hourlyOfDay(network.key,"2020-01-01",status);
        WIFIMETER_CHECK_EQ(hourly.size(),std::size_t(1));
        if (!hourly.empty()) { WIFIMETER_CHECK_EQ(hourly[0].rxBytes,5ULL); WIFIMETER_CHECK_EQ(hourly[0].txBytes,6ULL); }
        auto archive=store->database().prepare("SELECT state_json,settings_json,app_usage_json FROM legacy_imports",status);
        WIFIMETER_CHECK(archive && archive->step());
        if (archive) {
            WIFIMETER_CHECK_EQ(archive->columnText(0),raw);
            WIFIMETER_CHECK_EQ(archive->columnText(1),input.stringOr("settingsJson"));
            WIFIMETER_CHECK_EQ(archive->columnText(2),input.stringOr("appUsageJson"));
        }
        archive.reset();
        WIFIMETER_CHECK(ipc::importLegacy(*store,input,test::utcTime(2026,1,1),out,code));
        WIFIMETER_CHECK(out.boolOr("alreadyImported"));
        WIFIMETER_CHECK_EQ(out.intOr("skippedDayCount"),1);
        WIFIMETER_CHECK(ipc::legacyMigrationStatus(*store,input,out,code));
        WIFIMETER_CHECK_EQ(out.find("warnings")->dump(),reportWarnings);
        input.set("sourceId",JsonValue::makeString("other-source"));
        WIFIMETER_CHECK(ipc::importLegacy(*store,input,test::utcTime(2026,1,1),out,code));
        WIFIMETER_CHECK_EQ(out.intOr("dailyCount"),0);
        WIFIMETER_CHECK_EQ(out.intOr("skippedDayCount"),3);
        WIFIMETER_CHECK_EQ(rows(*store,"daily_usage"),hourlyOnly ? 2 : 3);
    }
    for (const auto& policy : {JsonValue::makeString(""),JsonValue::makeString("merge"),JsonValue::makeBool(true),JsonValue::makeInt(1),JsonValue::makeNull()})
    {
        auto store=storage::Store::open(":memory:",status);
        auto input=request(); input.set("overlapPolicy",policy);
        WIFIMETER_CHECK(!ipc::importLegacy(*store,input,test::utcTime(2026,1,1),out,code));
        WIFIMETER_CHECK_EQ(code,std::string("LegacyInvalid"));
        WIFIMETER_CHECK_EQ(rows(*store,"legacy_imports"),0);
    }
}

}
int main() { keepsExistingOverlapAndValidatesWholeSource(); importsFractionalWarningThreshold(); rejectsMalformedNumbersBeforeQuoting(); preservesEscapedKeysExactNumbersAndRawArchives(); ledgerPrecisionWarningsAndExistingProtection(); importsNetworkPoliciesAndIndependentLedgers(); initialRetentionPreventsHistoryPruning(); separatesWiredIdentity(); importsAndRetries(); rollbackAndProtection(); importsCachedDaysAndInitialSettings(); return WIFIMETER_REPORT(); }
