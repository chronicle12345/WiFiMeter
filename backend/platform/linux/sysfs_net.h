#pragma once

// /sys/class/net 的枚举：找出内核认定的无线网卡及其链路状态。
// 该数据源与语言环境、NetworkManager 是否存在都无关，可作为身份识别的交叉校验。

#include <string>
#include <vector>

namespace wifimeter::platform::linux
{

struct WirelessInterfaceInfo
{
    std::string name;       // 内核接口名
    std::string operstate;  // up / dormant / down / unknown
};

// 列出无线网卡。判定依据是内核提供的 phy80211 或 wireless 目录，非无线接口不会出现。
std::vector<WirelessInterfaceInfo> listWirelessInterfaces(const std::string& sysClassNet = "/sys/class/net");

// 链路是否已建立。dormant 表示载波已建立但接口尚未就绪，同样属于已关联。
bool isLinkUp(const WirelessInterfaceInfo& info);

}  // namespace wifimeter::platform::linux
