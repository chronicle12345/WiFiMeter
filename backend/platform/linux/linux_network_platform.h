#pragma once

// Linux 平台实现：组合 /proc/net/dev 计数、nmcli 身份识别与断开控制。
//
// 采集语义：读取计数前后各确认一次身份，期间切换网络的样本直接丢弃；
// 单张网卡失败不影响其他网卡的样本，失败以类型化原因上报。

#include <chrono>
#include <string>
#include <vector>

#include "../network_platform.h"
#include "nmcli.h"
#include "sysfs_net.h"

namespace wifimeter::platform::linux
{

class LinuxNetworkPlatform final : public NetworkPlatform
{
public:
    struct Options
    {
        std::string procNetDevPath = "/proc/net/dev";
        std::string sysClassNet = "/sys/class/net";
        std::string nmcliExecutable = "nmcli";
        std::chrono::milliseconds commandTimeout = std::chrono::seconds(8);
    };

    LinuxNetworkPlatform();
    explicit LinuxNetworkPlatform(Options options);

    LinkReport wirelessLinks() override;
    SampleReport sampleWifi() override;
    DisconnectReport disconnectIfAssociated(const std::string& interfaceId, const std::string& expectedSsid) override;

    const Options& options() const
    {
        return options_;
    }

private:
    // 一次身份识别，附带本轮遇到的失败。
    LinkReport readLinks();

    Options options_;
    Nmcli nmcli_;
};

}  // namespace wifimeter::platform::linux
