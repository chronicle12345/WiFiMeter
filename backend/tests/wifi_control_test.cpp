// 断开控制测试：纯判定分支，以及执行断开时的结果分类。

#include "../platform/linux/wifi_control.h"

#include <filesystem>
#include <string>

#include "test_support.h"

using namespace wifimeter::platform;
using namespace wifimeter::platform::linux;
using wifimeter::test::TempDirectory;

namespace
{

void decidesOnlyForTheExpectedNetwork()
{
    WIFIMETER_CHECK(decideDisconnect("", "Home") == DisconnectOutcome::notAssociated);
    WIFIMETER_CHECK(decideDisconnect("Home", "") == DisconnectOutcome::ssidMismatch);
    WIFIMETER_CHECK(decideDisconnect("Other", "Home") == DisconnectOutcome::ssidMismatch);
    WIFIMETER_CHECK(decideDisconnect("Home", "Home") == DisconnectOutcome::disconnected);
    // SSID 区分大小写，大小写不同视为不同网络。
    WIFIMETER_CHECK(decideDisconnect("home", "Home") == DisconnectOutcome::ssidMismatch);
}

void reportsMissingCommand()
{
    TempDirectory directory("control-missing");
    const DisconnectReport report = requestDisconnect("wlan0", Nmcli(directory.file("no-such-nmcli")));
    WIFIMETER_CHECK(report.outcome == DisconnectOutcome::unavailable);
    WIFIMETER_CHECK(!report.detail.empty());
}

void reportsCommandFailureWithDiagnostics()
{
    TempDirectory directory("control-failing");
    const std::string failing = directory.file("failing-nmcli");
    wifimeter::test::writeFile(failing, "#!/bin/sh\necho 'Error: not authorized' >&2\nexit 1\n", true);

    const DisconnectReport report = requestDisconnect("wlan0", Nmcli(failing));
    WIFIMETER_CHECK(report.outcome == DisconnectOutcome::commandFailed);
    // 系统错误诊断信息被压成单行，便于写日志。
    WIFIMETER_CHECK(report.detail.find("not authorized") != std::string::npos);
    WIFIMETER_CHECK(report.detail.find('\n') == std::string::npos);
}

void issuesTheDisconnectCommand()
{
    TempDirectory directory("control-ok");
    const std::string log = directory.file("calls.log");
    const std::string script = directory.file("nmcli");
    wifimeter::test::writeFile(script, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"" + log + "\"\nexit 0\n", true);

    const DisconnectReport report = requestDisconnect("wlan0", Nmcli(script));
    WIFIMETER_CHECK(report.outcome == DisconnectOutcome::disconnected);
    WIFIMETER_CHECK(report.detail.empty());
    WIFIMETER_CHECK(wifimeter::test::readFile(log).find("dev disconnect wlan0") != std::string::npos);
}

}  // namespace

int main()
{
    decidesOnlyForTheExpectedNetwork();
    reportsMissingCommand();
    reportsCommandFailureWithDiagnostics();
    issuesTheDisconnectCommand();
    return WIFIMETER_REPORT();
}
