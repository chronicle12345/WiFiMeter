// 可在 Windows 上用伪 sysfs 验证 Linux 网卡枚举，不替代 Linux 真机验证。
#include "../platform/linux/sysfs_net.h"
#include "test_support.h"

using namespace wifimeter::platform;
namespace fs = std::filesystem;

int main()
{
    wifimeter::test::TempDirectory directory{"ethernet-sysfs"};
    const auto root = directory.file("net");
    const auto add = [&](const std::string& name, bool physical, bool wireless, const std::string& state) {
        const auto path = fs::path(root) / name;
        fs::create_directories(path);
        if (physical) fs::create_directories(path / "device");
        if (wireless) fs::create_directories(path / "wireless");
        wifimeter::test::writeFile((path / "type").string(), "1\n");
        wifimeter::test::writeFile((path / "operstate").string(), state + "\n");
        wifimeter::test::writeFile((path / "carrier").string(), "1\n");
        wifimeter::test::writeFile((path / "address").string(), "00:11:22:aa:bb:cc\n");
        wifimeter::test::writeFile((path / "addr_assign_type").string(), "0\n");
    };
    add("eth0", true, false, "up");
    add("wlan0", true, true, "up");
    add("veth0", false, false, "up");
    add("br0", false, false, "up");
    add("tun0", false, false, "up");
    add("lo", true, false, "up");
    wifimeter::test::writeFile((fs::path(root) / "lo/type").string(), "772\n");
    auto links = wifimeter::platform::linux::listEthernetLinks(root);
    WIFIMETER_CHECK_EQ(links.size(), std::size_t(1));
    if (links.size() == 1)
    {
        WIFIMETER_CHECK_EQ(links[0].identity.type, std::string("ethernet"));
        WIFIMETER_CHECK(links[0].identity.associated());
        WIFIMETER_CHECK(!links[0].signalPercent);
        const auto key = links[0].identity.profileUuid;
        // 提供永久地址时，当前 MAC 改变不会影响身份。
        wifimeter::test::writeFile((fs::path(root) / "eth0/perm_address").string(), "00:11:22:aa:bb:cc\n");
        wifimeter::test::writeFile((fs::path(root) / "eth0/address").string(), "02:99:88:77:66:55\n");
        wifimeter::test::writeFile((fs::path(root) / "eth0/addr_assign_type").string(), "3\n");
        WIFIMETER_CHECK(wifimeter::platform::linux::listEthernetLinks(root)[0].identity.profileUuid == key);
        fs::rename(fs::path(root) / "eth0", fs::path(root) / "enp1s0");
        links = wifimeter::platform::linux::listEthernetLinks(root);
        WIFIMETER_CHECK(links[0].identity.profileUuid == key);
        wifimeter::test::writeFile((fs::path(root) / "enp1s0/carrier").string(), "0\n");
        links = wifimeter::platform::linux::listEthernetLinks(root);
        WIFIMETER_CHECK(!links[0].identity.associated());
        WIFIMETER_CHECK(links[0].identity.profileUuid == key);
        fs::remove_all(fs::path(root) / "enp1s0");
        WIFIMETER_CHECK(wifimeter::platform::linux::listEthernetLinks(root).empty());
    }
    // 没有永久地址时以物理设备路径归属，当前 MAC 变化不改变键。
    add("eth2", true, false, "up");
    wifimeter::test::writeFile((fs::path(root) / "eth2/addr_assign_type").string(), "3\n");
    const auto fallback = wifimeter::platform::linux::listEthernetLinks(root)[0].identity.profileUuid;
    wifimeter::test::writeFile((fs::path(root) / "eth2/address").string(), "02:aa:bb:cc:dd:ee\n");
    WIFIMETER_CHECK(wifimeter::platform::linux::listEthernetLinks(root)[0].identity.profileUuid == fallback);
#if !defined(_WIN32)
    // 真实 sysfs 的 device 是符号链接，改接口名不改变目标设备路径。
    const auto device = directory.file("devices/pci0000:00/0000:00:01.0");
    fs::create_directories(device);
    fs::remove(fs::path(root) / "eth2/device");
    fs::create_directory_symlink(device, fs::path(root) / "eth2/device");
    const auto deviceKey = wifimeter::platform::linux::listEthernetLinks(root)[0].identity.profileUuid;
    fs::rename(fs::path(root) / "eth2", fs::path(root) / "enp2s0");
    WIFIMETER_CHECK(wifimeter::platform::linux::listEthernetLinks(root)[0].identity.profileUuid == deviceKey);
    // 虚拟机合成网卡也有 device，按其驱动排除。
    const auto virtualDriver = directory.file("drivers/hv_netvsc");
    fs::create_directories(virtualDriver);
    fs::create_directory_symlink(virtualDriver, fs::path(device) / "driver");
    WIFIMETER_CHECK(wifimeter::platform::linux::listEthernetLinks(root).empty());
    fs::remove(fs::path(device) / "driver");
    // 即使伪装出 device，内核 virtual 路径仍需排除。
    const auto virtualPath = fs::path(directory.file("devices/virtual/net/veth9"));
    fs::create_directories(virtualPath / "device");
    wifimeter::test::writeFile((virtualPath / "type").string(), "1\n");
    fs::create_directory_symlink(virtualPath, fs::path(root) / "veth9");
    WIFIMETER_CHECK_EQ(wifimeter::platform::linux::listEthernetLinks(root).size(), std::size_t(1));
#endif
    return WIFIMETER_REPORT();
}
