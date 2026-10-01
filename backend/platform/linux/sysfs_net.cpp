#include "sysfs_net.h"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <system_error>

#include "text_file.h"

namespace wifimeter::platform::linux
{
namespace
{

namespace fs = std::filesystem;

bool isWireless(const fs::path& interfaceDirectory)
{
    std::error_code error;
    // phy80211 是指向 ieee80211 设备的符号链接，wireless 目录是无线扩展的旧接口。
    // 两者存在其一即说明内核把它当作无线网卡。
    return fs::exists(interfaceDirectory / "phy80211", error) || fs::exists(interfaceDirectory / "wireless", error);
}

std::string readOperState(const fs::path& interfaceDirectory)
{
    const auto content = readTextFile((interfaceDirectory / "operstate").string());
    if (!content)
        return "unknown";
    return trimLineEndings(*content);
}

}  // namespace

std::vector<WirelessInterfaceInfo> listWirelessInterfaces(const std::string& sysClassNet)
{
    std::vector<WirelessInterfaceInfo> interfaces;
    std::error_code error;
    fs::directory_iterator entries(sysClassNet, error);
    if (error)
        return interfaces;

    for (const fs::directory_entry& entry : entries)
    {
        if (error)
            break;
        if (!entry.is_directory(error) && !entry.is_symlink(error))
            continue;
        if (!isWireless(entry.path()))
            continue;

        WirelessInterfaceInfo info;
        info.name = entry.path().filename().string();
        info.operstate = readOperState(entry.path());
        interfaces.push_back(std::move(info));
    }

    std::sort(interfaces.begin(), interfaces.end(), [](const WirelessInterfaceInfo& left, const WirelessInterfaceInfo& right) { return left.name < right.name; });
    return interfaces;
}

std::vector<WifiLink> listEthernetLinks(const std::string& sysClassNet)
{
    std::vector<WifiLink> links;
    std::error_code error;
    fs::directory_iterator entries(sysClassNet, error);
    if (error)
        return links;
    for (const auto& entry : entries)
    {
        const auto path = entry.path();
        const auto read = [&](const char* file) {
            return trimLineEndings(readTextFile((path / file).string()).value_or(""));
        };
        // ARPHRD_ETHER 也包括桥接、veth 和无线，必须同时检查物理 device 与内核路径。
        if (isWireless(path) || read("type") != "1" || !fs::exists(path / "device", error))
            continue;
        const auto canonical = fs::canonical(path, error);
        if (error || std::find(canonical.begin(), canonical.end(), fs::path("virtual")) != canonical.end())
            continue;
        // Hyper-V、VirtIO、VMware 合成网卡也会暴露 device，不能按物理网卡计入。
        const auto driverPath = fs::canonical(path / "device/driver", error);
        if (!error)
        {
            const auto driver = driverPath.filename().string();
            if (driver == "hv_netvsc" || driver == "virtio_net" || driver == "vmxnet3" || driver == "vmxnet")
                continue;
        }
        auto mac = read("perm_address");
        if (mac.empty() && read("addr_assign_type") == "0")
            mac = read("address");
        std::transform(mac.begin(), mac.end(), mac.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
        bool validMac = mac.size() == 17 && mac != "00:00:00:00:00:00";
        for (std::size_t i = 0; i < mac.size() && validMac; ++i)
            validMac = i % 3 == 2 ? mac[i] == ':' : std::isxdigit(static_cast<unsigned char>(mac[i])) != 0;
        std::string stableId;
        if (validMac)
            stableId = "linux-mac:" + mac;
        else
        {
            // 地址被管理员修改时使用物理设备路径，接口重命名不会改变 device 的目标。
            const auto device = fs::canonical(path / "device", error);
            if (error)
                continue;
            stableId = "linux-device:" + device.generic_string();
        }
        WifiLink link;
        link.interfaceId = path.filename().string();
        link.adapterAlias = link.interfaceId;
        link.identity = ethernetIdentity(stableId, link.adapterAlias, readOperState(path) == "up" && read("carrier") == "1");
        links.push_back(std::move(link));
    }
    std::sort(links.begin(), links.end(), [](const WifiLink& left, const WifiLink& right) { return left.interfaceId < right.interfaceId; });
    return links;
}

bool isLinkUp(const WirelessInterfaceInfo& info)
{
    return info.operstate == "up" || info.operstate == "dormant";
}

}  // namespace wifimeter::platform::linux
