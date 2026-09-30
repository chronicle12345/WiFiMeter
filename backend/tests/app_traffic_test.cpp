#include "../platform/fake_app_traffic.h"
#include "test_support.h"

namespace platform = wifimeter::platform;

int main()
{
    const std::string sample = R"({"interfaceId":"wlan0","appId":"browser","name":"浏览器","instanceId":"42:100","processId":42,"rxBytes":"18446744073709551615","txBytes":"0"})";
    const auto valid = "{\"state\":\"running\",\"generation\":\"one\",\"samples\":[" + sample + "]}";
    auto report = platform::parseAppTrafficReport(valid);
    WIFIMETER_CHECK(report.state == platform::AppCollectorState::running);
    WIFIMETER_CHECK_EQ(report.samples.size(), std::size_t{1});
    if (!report.samples.empty())
        WIFIMETER_CHECK_EQ(report.samples[0].rxBytes, std::uint64_t{18446744073709551615ULL});
    const auto roundtrip = platform::parseAppTrafficReport(platform::serializeAppTrafficReport(report));
    WIFIMETER_CHECK(roundtrip.state == platform::AppCollectorState::running);
    WIFIMETER_CHECK_EQ(roundtrip.samples.size(), std::size_t{1});
    if (!roundtrip.samples.empty())
    {
        WIFIMETER_CHECK_EQ(roundtrip.samples[0].rxBytes, std::uint64_t{18446744073709551615ULL});
        WIFIMETER_CHECK_EQ(roundtrip.samples[0].name, std::string("浏览器"));
    }
    WIFIMETER_CHECK(platform::parseAppTrafficReport("invalid").state == platform::AppCollectorState::unavailable);
    WIFIMETER_CHECK(platform::parseAppTrafficReport(R"({"state":"unknown"})").state == platform::AppCollectorState::unavailable);
    WIFIMETER_CHECK(platform::parseAppTrafficReport(R"({"state":"permission","detail":"Access denied"})").state == platform::AppCollectorState::permission);
    WIFIMETER_CHECK(platform::parseAppTrafficReport("{\"state\":\"running\",\"generation\":\"one\",\"samples\":[" + sample + "," + sample + "]}").state == platform::AppCollectorState::unavailable);
    auto numeric = valid;
    const auto position = numeric.find("\"18446744073709551615\"");
    numeric.replace(position, std::string("\"18446744073709551615\"").size(), "123");
    WIFIMETER_CHECK(platform::parseAppTrafficReport(numeric).state == platform::AppCollectorState::unavailable);

    wifimeter::test::TempDirectory directory("app-fixture");
    const auto path = directory.file("apps.json");
    wifimeter::test::writeFile(path, valid);
    platform::fake::FileAppTrafficSource source(path);
    WIFIMETER_CHECK(source.read().state == platform::AppCollectorState::disabled);
    source.start();
    WIFIMETER_CHECK(source.read().state == platform::AppCollectorState::running);
    wifimeter::test::writeFile(path, R"({"state":"permission","detail":"Access denied"})");
    WIFIMETER_CHECK(source.read().state == platform::AppCollectorState::permission);
    source.stop();
    WIFIMETER_CHECK(source.read().state == platform::AppCollectorState::disabled);
    return WIFIMETER_REPORT();
}
