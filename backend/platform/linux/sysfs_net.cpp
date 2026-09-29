#include "sysfs_net.h"

#include <algorithm>
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

bool isLinkUp(const WirelessInterfaceInfo& info)
{
    return info.operstate == "up" || info.operstate == "dormant";
}

}  // namespace wifimeter::platform::linux
