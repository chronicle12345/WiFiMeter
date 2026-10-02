#include "../ipc/loopback_live.h"
#include "test_support.h"
using namespace wifimeter;
int main()
{
    ipc::LoopbackLive window;
    auto at=test::utcTime(2026,10,1,0,0,0);
    platform::AppTrafficReport report{platform::AppCollectorState::running,"one",{},
        {{"loopback","client.exe","client","12:100:1",12,1000000,900000,true,"socket"},
         {"WLAN","proxy.exe","proxy","20:200",20,5000000,400000,true,{}}}};
    auto rows=window.update(report,at);
    WIFIMETER_CHECK_EQ(rows.size(),std::size_t(1));
    WIFIMETER_CHECK(rows.at(0).find("rxPerSecond")->isNull());
    WIFIMETER_CHECK_EQ(rows.at(0).stringOr("rxBytes"),std::string("0"));
    report.samples[0].rxBytes+=800; report.samples[0].txBytes+=200;
    rows=window.update(report,at+=std::chrono::seconds(2));
    WIFIMETER_CHECK_EQ(rows.at(0).stringOr("rxPerSecond"),std::string("400"));
    auto client=support::JsonValue::makeObject();client.set("appId",support::JsonValue::makeString("client.exe"));
    ipc::addProxyMeasurement(client,rows,{"socket","socket"});
    WIFIMETER_CHECK_EQ(client.stringOr("rxBytes"),std::string("800"));
    ipc::addProxyMeasurement(client,rows,{"another"});
    WIFIMETER_CHECK(!client.boolOr("measurementAvailable"));
    WIFIMETER_CHECK(client.find("rxBytes")->isNull());
    report.samples[0].rxBytes=1;report.samples[0].txBytes=1;
    rows=window.update(report,at+=std::chrono::seconds(2));
    WIFIMETER_CHECK(!rows.at(0).boolOr("measurementAvailable"));
    report.samples[0].instanceId="12:101:2";
    report.samples[0].rxBytes=90000000;
    rows=window.update(report,at+=std::chrono::seconds(2));
    WIFIMETER_CHECK_EQ(rows.at(0).stringOr("rxBytes"),std::string("0"));
    auto saved=report.samples;report.samples.clear();
    WIFIMETER_CHECK_EQ(window.update(report,at+=std::chrono::seconds(2)).size(),std::size_t(0));
    report.samples=saved;rows=window.update(report,at+=std::chrono::seconds(2));
    WIFIMETER_CHECK(!rows.at(0).boolOr("measurementAvailable"));
    window.clear();rows=window.update(report,at+=std::chrono::seconds(2));
    WIFIMETER_CHECK_EQ(rows.at(0).stringOr("rxBytes"),std::string("0"));
    report.state=platform::AppCollectorState::permission;
    WIFIMETER_CHECK_EQ(window.update(report,at).size(),std::size_t(0));
    report.state=platform::AppCollectorState::running;report.generation="two";
    WIFIMETER_CHECK(!window.update(report,at+=std::chrono::seconds(2)).at(0).boolOr("measurementAvailable"));
    const auto decoded=platform::parseAppTrafficReport(platform::serializeAppTrafficReport(report));
    WIFIMETER_CHECK_EQ(decoded.samples.at(0).connectionKey,std::string("socket"));
    const auto sourceReport=platform::parseAppTrafficReport(R"({"state":"running","generation":"native","samples":[{"interfaceId":"loopback","appId":"client.exe","name":"client","instanceId":"1:2:3","processId":1,"rxBytes":"1","txBytes":"2","connectionKey":"socket","source":"WindowsTcpEStats"}]})");
    WIFIMETER_CHECK(platform::serializeAppTrafficReport(sourceReport).find("WindowsTcpEStats")!=std::string::npos);
    // Helper responses can carry the same EStats snapshot even when requested again.
    auto snapshot = [&](long long stamp, unsigned rx) {
        return platform::parseAppTrafficReport("{\"state\":\"running\",\"generation\":\"timed\",\"sampledAtMs\":" + std::to_string(stamp + 20) +
            ",\"loopbackSampledAtMs\":" + std::to_string(stamp) +
            ",\"samples\":[{\"interfaceId\":\"loopback\",\"appId\":\"client.exe\",\"name\":\"client\",\"instanceId\":\"1:2:3\",\"processId\":1,\"rxBytes\":\"" + std::to_string(rx) + "\",\"txBytes\":\"0\",\"connectionKey\":\"socket\"}]}");
    };
    window.clear();
    window.update(snapshot(10000, 0), at);
    rows = window.update(snapshot(11250, 1000), at + std::chrono::seconds(2));
    WIFIMETER_CHECK_EQ(rows.at(0).stringOr("rxPerSecond"), std::string("800"));
    rows = window.update(snapshot(11250, 1000), at + std::chrono::milliseconds(2100));
    WIFIMETER_CHECK_EQ(rows.at(0).stringOr("rxPerSecond"), std::string("800"));
    WIFIMETER_CHECK_EQ(rows.at(0).stringOr("rxBytes"), std::string("1000"));
    rows = window.update(snapshot(12500, 2000), at + std::chrono::seconds(3));
    WIFIMETER_CHECK_EQ(rows.at(0).stringOr("rxPerSecond"), std::string("800"));
    // A new zero-delta sample really is idle; a repeated snapshot is not.
    rows = window.update(snapshot(13750, 2000), at + std::chrono::seconds(4));
    WIFIMETER_CHECK_EQ(rows.at(0).stringOr("rxPerSecond"), std::string("0"));
    rows = window.update(snapshot(13750, 2000), at + std::chrono::seconds(10));
    WIFIMETER_CHECK(!rows.at(0).boolOr("measurementAvailable"));
    WIFIMETER_CHECK(rows.at(0).find("rxPerSecond")->isNull());
    const auto timed = platform::parseAppTrafficReport(platform::serializeAppTrafficReport(snapshot(15000, 3000)));
    WIFIMETER_CHECK_EQ(timed.sampledAtMs, std::int64_t(15020));
    WIFIMETER_CHECK_EQ(timed.loopbackSampledAtMs, std::int64_t(15000));
    for (const int interval : {2, 5, 10})
    {
        window.clear();
        const auto staleAfter = std::chrono::seconds(interval * 2 > 5 ? interval * 2 : 5);
        window.update(snapshot(20000, 0), at, staleAfter);
        rows = window.update(snapshot(20000 + interval * 1000, interval * 800), at + std::chrono::seconds(interval), staleAfter);
        WIFIMETER_CHECK_EQ(rows.at(0).stringOr("rxPerSecond"), std::string("800"));
        rows = window.update(snapshot(20000 + interval * 1000, interval * 800), at + std::chrono::seconds(interval * 2), staleAfter);
        WIFIMETER_CHECK_EQ(rows.at(0).stringOr("rxPerSecond"), std::string("800"));
        // Delayed/out-of-order snapshots must not move the byte baseline backwards.
        rows = window.update(snapshot(20000, 0), at + std::chrono::seconds(interval * 2), staleAfter);
        WIFIMETER_CHECK_EQ(rows.at(0).stringOr("rxBytes"), std::to_string(interval * 800));
        rows = window.update(snapshot(20000 + interval * 1000, interval * 800), at + std::chrono::seconds(interval) + staleAfter + std::chrono::seconds(1), staleAfter);
        WIFIMETER_CHECK(!rows.at(0).boolOr("measurementAvailable"));
        auto restarted = snapshot(1000, 999999); restarted.generation = "restart";
        rows = window.update(restarted, at + std::chrono::seconds(100), staleAfter);
        WIFIMETER_CHECK(!rows.at(0).boolOr("measurementAvailable"));
        WIFIMETER_CHECK_EQ(rows.at(0).stringOr("rxBytes"), std::string("0"));
    }
    return WIFIMETER_REPORT();
}
