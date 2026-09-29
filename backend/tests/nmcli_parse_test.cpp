// nmcli 输出解析与命令执行测试。样本取自真实的 nmcli 1.36 输出，包含中文状态文字与被转义的冒号。

#include <chrono>
#include <string>

#include "../platform/linux/nmcli.h"
#include "test_support.h"

using namespace wifimeter::platform;
using namespace wifimeter::platform::linux;

namespace
{

// 真实输出：状态文字随语言环境变化，字段名与冒号后的状态码不变。
const char* kDeviceShow =
    "GENERAL.DEVICE:enp0s31f6\n"
    "GENERAL.TYPE:ethernet\n"
    "GENERAL.STATE:100 (connected)\n"
    "GENERAL.CONNECTION:有线连接 1\n"
    "GENERAL.CON-UUID:69347f76-ae7a-3596-a642-2d6bff737f76\n"
    "GENERAL.VENDOR:Intel Corporation\n"
    "GENERAL.PRODUCT:Ethernet Connection (2) I219-V\n"
    "\n"
    "GENERAL.DEVICE:wlx90de80299b57\n"
    "GENERAL.TYPE:wifi\n"
    "GENERAL.STATE:30（已断开）\n"
    "GENERAL.CONNECTION:\n"
    "GENERAL.CON-UUID:\n"
    "GENERAL.VENDOR:AICSemi\n"
    "GENERAL.PRODUCT:AIC8800DC\n"
    "\n"
    "GENERAL.DEVICE:wlan0\n"
    "GENERAL.TYPE:wifi\n"
    "GENERAL.STATE:100 (connected)\n"
    "GENERAL.CONNECTION:家里的 Wi\\:Fi\n"
    "GENERAL.CON-UUID:4b1f5f60-0000-4a00-9000-abcdefabcdef\n"
    "GENERAL.VENDOR:\n"
    "GENERAL.PRODUCT:\n"
    "\n";

// 真实输出的 BSSID 列把冒号转义成 \:，列数不能因此错位。
const char* kWifiList =
    " :HUAWEI-test1:100:2412 MHz:42\\:4A\\:97\\:E4\\:D2\\:27\n"
    " :indemind:100:2437 MHz:4C\\:49\\:68\\:05\\:00\\:45\n"
    " ::100:2437 MHz:4E\\:49\\:68\\:55\\:00\\:45\n"
    "*:MyNet:77:5180 MHz:AA\\:BB\\:CC\\:DD\\:EE\\:FF\n";

void unescapesTerseValues()
{
    WIFIMETER_CHECK_EQ(unescapeTerse("42\\:4A\\:97\\:E4\\:D2\\:27"), std::string("42:4A:97:E4:D2:27"));
    WIFIMETER_CHECK_EQ(unescapeTerse("plain"), std::string("plain"));
    WIFIMETER_CHECK_EQ(unescapeTerse("back\\\\slash"), std::string("back\\slash"));
    // 未转义的反斜杠与结尾反斜杠保持原样。
    WIFIMETER_CHECK_EQ(unescapeTerse("a\\b"), std::string("a\\b"));
    WIFIMETER_CHECK_EQ(unescapeTerse("tail\\"), std::string("tail\\"));
}

void splitsTerseFields()
{
    const auto fields = splitTerseFields(" :HUAWEI-test1:100:2412 MHz:42\\:4A\\:97\\:E4\\:D2\\:27");
    WIFIMETER_CHECK_EQ(fields.size(), std::size_t{5});
    WIFIMETER_CHECK_EQ(fields[0], std::string(" "));
    WIFIMETER_CHECK_EQ(fields[1], std::string("HUAWEI-test1"));
    WIFIMETER_CHECK_EQ(fields[2], std::string("100"));
    WIFIMETER_CHECK_EQ(fields[3], std::string("2412 MHz"));
    WIFIMETER_CHECK_EQ(fields[4], std::string("42:4A:97:E4:D2:27"));

    const auto empty = splitTerseFields("");
    WIFIMETER_CHECK_EQ(empty.size(), std::size_t{1});
}

void splitsTersePairs()
{
    const auto state = splitTersePair("GENERAL.STATE:30（已断开）");
    WIFIMETER_CHECK_EQ(state.first, std::string("GENERAL.STATE"));
    WIFIMETER_CHECK_EQ(state.second, std::string("30（已断开）"));

    const auto escaped = splitTersePair("GENERAL.CONNECTION:Home\\:WiFi");
    WIFIMETER_CHECK_EQ(escaped.first, std::string("GENERAL.CONNECTION"));
    WIFIMETER_CHECK_EQ(escaped.second, std::string("Home:WiFi"));

    const auto emptyValue = splitTersePair("GENERAL.CONNECTION:");
    WIFIMETER_CHECK_EQ(emptyValue.second, std::string(""));
}

void readsLeadingIntegers()
{
    WIFIMETER_CHECK_EQ(parseLeadingInt("100 (connected)"), 100);
    WIFIMETER_CHECK_EQ(parseLeadingInt("30（已断开）"), 30);
    WIFIMETER_CHECK_EQ(parseLeadingInt("2412 MHz"), 2412);
    WIFIMETER_CHECK_EQ(parseLeadingInt("  7 "), 7);
    WIFIMETER_CHECK_EQ(parseLeadingInt(""), -1);
    WIFIMETER_CHECK_EQ(parseLeadingInt("-"), -1);
    WIFIMETER_CHECK_EQ(parseLeadingInt("--5"), -1);
    WIFIMETER_CHECK_EQ(parseLeadingInt("未知"), -1);
}

void parsesDeviceStatus()
{
    const auto devices = parseDeviceStatus(kDeviceShow);
    WIFIMETER_CHECK_EQ(devices.size(), std::size_t{3});

    WIFIMETER_CHECK_EQ(devices[0].device, std::string("enp0s31f6"));
    WIFIMETER_CHECK_EQ(devices[0].type, std::string("ethernet"));
    WIFIMETER_CHECK_EQ(devices[0].stateCode, 100);
    // 连接名是 UTF-8 用户数据，不能被语言环境改写。
    WIFIMETER_CHECK_EQ(devices[0].connection, std::string("有线连接 1"));
    WIFIMETER_CHECK_EQ(devices[0].connectionUuid, std::string("69347f76-ae7a-3596-a642-2d6bff737f76"));
    WIFIMETER_CHECK_EQ(devices[0].vendor, std::string("Intel Corporation"));
    WIFIMETER_CHECK_EQ(devices[0].product, std::string("Ethernet Connection (2) I219-V"));
    // 解析阶段不解析 SSID，由查询层补全。
    WIFIMETER_CHECK(!devices[0].ssid.has_value());

    WIFIMETER_CHECK_EQ(devices[1].device, std::string("wlx90de80299b57"));
    WIFIMETER_CHECK_EQ(devices[1].type, std::string("wifi"));
    WIFIMETER_CHECK_EQ(devices[1].stateCode, 30);
    WIFIMETER_CHECK_EQ(devices[1].connection, std::string(""));

    WIFIMETER_CHECK_EQ(devices[2].connection, std::string("家里的 Wi:Fi"));
    WIFIMETER_CHECK_EQ(devices[2].vendor, std::string(""));

    WIFIMETER_CHECK(parseDeviceStatus("").empty());
}

void buildsAdapterAliases()
{
    WIFIMETER_CHECK_EQ(adapterAliasFrom("Intel Corporation", "Ethernet Connection (2) I219-V"), std::string("Intel Corporation Ethernet Connection (2) I219-V"));
    WIFIMETER_CHECK_EQ(adapterAliasFrom("AICSemi", "AIC8800DC"), std::string("AICSemi AIC8800DC"));
    WIFIMETER_CHECK_EQ(adapterAliasFrom("", "AIC8800DC"), std::string("AIC8800DC"));
    WIFIMETER_CHECK_EQ(adapterAliasFrom("Intel", ""), std::string("Intel"));
    WIFIMETER_CHECK_EQ(adapterAliasFrom("", ""), std::string(""));
    // 产品名已包含厂商时不重复拼接。
    WIFIMETER_CHECK_EQ(adapterAliasFrom("Intel", "Intel Wi-Fi 6 AX200"), std::string("Intel Wi-Fi 6 AX200"));
}

void parsesWifiList()
{
    const auto list = parseWifiList(kWifiList);
    WIFIMETER_CHECK_EQ(list.size(), std::size_t{4});
    WIFIMETER_CHECK_EQ(list[0].ssid, std::string("HUAWEI-test1"));
    WIFIMETER_CHECK_EQ(list[0].signalPercent.value_or(-1), 100);
    WIFIMETER_CHECK_EQ(list[0].frequencyMhz.value_or(-1), 2412);
    // 隐藏网络没有 SSID，仍应保留记录。
    WIFIMETER_CHECK_EQ(list[2].ssid, std::string(""));
    WIFIMETER_CHECK_EQ(list[3].ssid, std::string("MyNet"));
    WIFIMETER_CHECK_EQ(list[3].frequencyMhz.value_or(-1), 5180);

    // 列数不足的行被跳过；无法解析的数值留空而不是当作 0。
    WIFIMETER_CHECK(parseWifiList(" :OnlySsid:50\n").empty());
    WIFIMETER_CHECK(parseWifiList("").empty());
    const auto unknownNumbers = parseWifiList(" :MyNet:--:unknown\n");
    WIFIMETER_CHECK_EQ(unknownNumbers.size(), std::size_t{1});
    WIFIMETER_CHECK(!unknownNumbers[0].signalPercent.has_value());
    WIFIMETER_CHECK(!unknownNumbers[0].frequencyMhz.has_value());
}

void matchesBssBySsid()
{
    const auto list = parseWifiList(kWifiList);
    const auto found = findBssBySsid(list, "MyNet");
    WIFIMETER_CHECK(found.has_value());
    WIFIMETER_CHECK_EQ(found->signalPercent.value_or(-1), 77);

    const auto missing = findBssBySsid(list, "NotThere");
    WIFIMETER_CHECK(!missing.has_value());
    // 空 SSID 不参与匹配，避免命中隐藏网络。
    WIFIMETER_CHECK(!findBssBySsid(list, "").has_value());

    const std::vector<WifiBss> duplicates = {{"Same", 10, 2412}, {"Same", 90, 2437}};
    const auto strongest = findBssBySsid(duplicates, "Same");
    WIFIMETER_CHECK(strongest.has_value());
    WIFIMETER_CHECK_EQ(strongest->signalPercent.value_or(-1), 90);
}

void classifiesBands()
{
    WIFIMETER_CHECK(classifyBand(2412) == Band::ghz2_4);
    WIFIMETER_CHECK(classifyBand(2484) == Band::ghz2_4);
    WIFIMETER_CHECK(classifyBand(5180) == Band::ghz5);
    WIFIMETER_CHECK(classifyBand(5895) == Band::ghz5);
    WIFIMETER_CHECK(classifyBand(5955) == Band::ghz6);
    WIFIMETER_CHECK(classifyBand(60480) == Band::ghz60);
    // 5 GHz 与 6 GHz 之间的间隔不予归类。
    WIFIMETER_CHECK(classifyBand(5910) == Band::unknown);
    WIFIMETER_CHECK(classifyBand(0) == Band::unknown);

    WIFIMETER_CHECK_EQ(std::string(bandLabel(Band::ghz2_4)), std::string("2.4 GHz"));
    WIFIMETER_CHECK_EQ(std::string(bandLabel(Band::ghz5)), std::string("5 GHz"));
    WIFIMETER_CHECK_EQ(std::string(bandLabel(Band::ghz6)), std::string("6 GHz"));
    WIFIMETER_CHECK_EQ(std::string(bandLabel(Band::ghz60)), std::string("60 GHz"));
    WIFIMETER_CHECK_EQ(std::string(bandLabel(Band::unknown)), std::string(""));
}

void classifiesCommandFailures()
{
    CommandResult notStarted;
    notStarted.error = "No such file or directory";
    const auto missing = commandFailure(notStarted, "wlan0");
    WIFIMETER_CHECK(missing.has_value());
    WIFIMETER_CHECK(missing->kind == FailureKind::unavailable);
    WIFIMETER_CHECK_EQ(missing->interfaceId, std::string("wlan0"));
    WIFIMETER_CHECK_EQ(missing->detail, std::string("No such file or directory"));

    CommandResult slow;
    slow.started = true;
    slow.timedOut = true;
    const auto timedOut = commandFailure(slow);
    WIFIMETER_CHECK(timedOut.has_value());
    WIFIMETER_CHECK(timedOut->kind == FailureKind::timeout);

    CommandResult failed;
    failed.started = true;
    failed.exitCode = 1;
    failed.error = "Error: not authorized";
    const auto commandFailed = commandFailure(failed);
    WIFIMETER_CHECK(commandFailed.has_value());
    WIFIMETER_CHECK(commandFailed->kind == FailureKind::commandFailed);
    WIFIMETER_CHECK_EQ(commandFailed->detail, std::string("Error: not authorized"));

    CommandResult succeeded;
    succeeded.started = true;
    succeeded.exitCode = 0;
    WIFIMETER_CHECK(!commandFailure(succeeded).has_value());
}

void runsCommandsWithoutShellAndReportsFailures()
{
    wifimeter::test::TempDirectory directory("run-command");

    // 参数中的元字符不会被 shell 解释：这里应当原样输出。
    const std::string echo = directory.file("echoer");
    wifimeter::test::writeFile(echo, "#!/bin/sh\nprintf '%s\\n' \"$*\"\n", true);
    const CommandResult echoed = runCommand({echo, "a; echo injected", "$HOME", "|"}, std::chrono::seconds(5));
    WIFIMETER_CHECK(echoed.started);
    WIFIMETER_CHECK_EQ(echoed.exitCode, 0);
    WIFIMETER_CHECK_EQ(echoed.output, std::string("a; echo injected $HOME |\n"));

    const CommandResult missing = runCommand({directory.file("no-such-program")}, std::chrono::seconds(5));
    WIFIMETER_CHECK(!missing.started);
    WIFIMETER_CHECK(!missing.error.empty());

    const std::string failing = directory.file("failing");
    wifimeter::test::writeFile(failing, "#!/bin/sh\necho 'boom' >&2\nexit 3\n", true);
    const CommandResult failed = runCommand({failing}, std::chrono::seconds(5));
    WIFIMETER_CHECK(failed.started);
    WIFIMETER_CHECK_EQ(failed.exitCode, 3);
    WIFIMETER_CHECK(failed.error.find("boom") != std::string::npos);
    WIFIMETER_CHECK(failed.output.empty());

    const CommandResult empty = runCommand({}, std::chrono::seconds(5));
    WIFIMETER_CHECK(!empty.started);
}

void readsLargeOutputAndStopsOnTimeout()
{
    wifimeter::test::TempDirectory directory("run-command-limits");

    // 输出远大于管道缓冲区：必须持续读取，否则子进程会写阻塞而超时。
    const std::string verbose = directory.file("verbose");
    wifimeter::test::writeFile(verbose, "#!/bin/sh\nyes x | head -c 400000\n", true);
    const CommandResult large = runCommand({verbose}, std::chrono::seconds(20));
    WIFIMETER_CHECK(large.started);
    WIFIMETER_CHECK(!large.timedOut);
    WIFIMETER_CHECK_EQ(large.output.size(), std::size_t{400000});

    const std::string slow = directory.file("slow");
    wifimeter::test::writeFile(slow, "#!/bin/sh\nsleep 30\n", true);
    const auto startedAt = std::chrono::steady_clock::now();
    const CommandResult timedOut = runCommand({slow}, std::chrono::milliseconds(300));
    const auto elapsed = std::chrono::steady_clock::now() - startedAt;
    WIFIMETER_CHECK(timedOut.started);
    WIFIMETER_CHECK(timedOut.timedOut);
    WIFIMETER_CHECK(elapsed < std::chrono::seconds(5));
}

}  // namespace

int main()
{
    unescapesTerseValues();
    splitsTerseFields();
    splitsTersePairs();
    readsLeadingIntegers();
    parsesDeviceStatus();
    buildsAdapterAliases();
    parsesWifiList();
    matchesBssBySsid();
    classifiesBands();
    classifiesCommandFailures();
    runsCommandsWithoutShellAndReportsFailures();
    readsLargeOutputAndStopsOnTimeout();
    return WIFIMETER_REPORT();
}
