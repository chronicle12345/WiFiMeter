// sysfs 网卡枚举测试。用临时目录构造各种组合，避免依赖运行机器的真实网卡。

#include "../platform/linux/sysfs_net.h"

#include <filesystem>
#include <string>

#include "test_support.h"

using namespace wifimeter::platform::linux;
using wifimeter::test::TempDirectory;

namespace
{

namespace fs = std::filesystem;

void createsInterface(const fs::path& root, const std::string& name, const std::string& marker, const std::string& operstate)
{
    const fs::path directory = root / name;
    fs::create_directories(directory);
    if (marker == "dir")
        fs::create_directories(directory / "wireless");
    else if (!marker.empty())
        wifimeter::test::writeFile((directory / marker).string(), "");
    if (!operstate.empty())
        wifimeter::test::writeFile((directory / "operstate").string(), operstate + "\n");
}

void listsOnlyWirelessInterfaces()
{
    TempDirectory directory("sysfs");
    const fs::path root = directory.path() / "net";
    createsInterface(root, "wlan0", "phy80211", "up");
    createsInterface(root, "wlan1", "dir", "dormant");
    createsInterface(root, "wlan2", "phy80211", "down");
    createsInterface(root, "wlan3", "phy80211", "");  // 没有 operstate 文件
    createsInterface(root, "eth0", "", "up");
    createsInterface(root, "docker0", "", "down");
    fs::create_directories(root / "lo");

    const auto interfaces = listWirelessInterfaces(root.string());
    WIFIMETER_CHECK_EQ(interfaces.size(), std::size_t{4});
    WIFIMETER_CHECK_EQ(interfaces[0].name, std::string("wlan0"));
    WIFIMETER_CHECK_EQ(interfaces[0].operstate, std::string("up"));
    WIFIMETER_CHECK_EQ(interfaces[1].operstate, std::string("dormant"));
    WIFIMETER_CHECK_EQ(interfaces[2].operstate, std::string("down"));
    WIFIMETER_CHECK_EQ(interfaces[3].operstate, std::string("unknown"));
}

void treatsDormantAsLinked()
{
    WirelessInterfaceInfo info;
    info.operstate = "up";
    WIFIMETER_CHECK(isLinkUp(info));
    info.operstate = "dormant";
    WIFIMETER_CHECK(isLinkUp(info));
    info.operstate = "down";
    WIFIMETER_CHECK(!isLinkUp(info));
    info.operstate = "unknown";
    WIFIMETER_CHECK(!isLinkUp(info));
}

void toleratesMissingDirectory()
{
    WIFIMETER_CHECK(listWirelessInterfaces("/nonexistent/sys/class/net").empty());
    WIFIMETER_CHECK(listWirelessInterfaces("").empty());
}

void readsTheLiveTree()
{
    // 真实 sysfs 至少不应抛异常；列出的条目必须都带内核接口名与链路状态。
    const auto interfaces = listWirelessInterfaces("/sys/class/net");
    for (const auto& info : interfaces)
    {
        WIFIMETER_CHECK(!info.name.empty());
        WIFIMETER_CHECK(!info.operstate.empty());
    }
}

}  // namespace

int main()
{
    listsOnlyWirelessInterfaces();
    treatsDormantAsLinked();
    toleratesMissingDirectory();
    readsTheLiveTree();
    return WIFIMETER_REPORT();
}
