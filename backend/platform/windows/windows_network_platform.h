#pragma once

// Windows 平台实现：组合 WLAN API 的状态/身份查询、IP Helper 的累计计数与断开控制。
//
// 采集语义与 Linux 实现一致：读取计数前后各确认一次身份，期间切换网络的样本直接丢弃；
// 单张网卡失败不影响其他网卡的样本，失败以类型化原因上报。
//
// 与 Linux 的差别有两点，都来自系统本身：
//
//   * 身份与计数来自两次独立的系统调用（WLAN API 与 IP Helper），因此“采样前后一致”
//     是在两侧各读一次状态再比对，而不是像 Linux 那样一次 nmcli 查询同时给身份与扫描结果；
//   * 断开是异步的：WlanDisconnect 只表示请求被接受，复核要等状态真正变成未连接，
//     因此这里按固定间隔重试，直到超时。等待函数可注入，测试无需真的睡眠。

#include <chrono>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "../network_platform.h"
#include "system_api.h"

namespace wifimeter::platform::windows
{

class WindowsNetworkPlatform final : public NetworkPlatform
{
public:
    struct Options
    {
        SystemApi* system = nullptr;  // 必须非空，生命周期由调用方保证
        std::chrono::milliseconds disconnectTimeout = std::chrono::seconds(6);
        std::chrono::milliseconds disconnectPollInterval = std::chrono::milliseconds(250);
        // 等待函数：默认真的睡眠，测试注入一个立即返回的实现。
        std::function<void(std::chrono::milliseconds)> wait = {};
    };

    explicit WindowsNetworkPlatform(Options options);

    LinkReport wirelessLinks() override;
    SampleReport sampleWifi() override;
    DisconnectReport disconnectIfAssociated(const std::string& interfaceId, const std::string& expectedSsid) override;

private:
    // 一次状态读取，附带本轮遇到的失败。
    QueryResult<std::vector<WlanStatus>> readStatuses();

    // 把状态列表转成平台链接列表；失败单独返回，便于与状态分开处理。
    LinkReport linksFrom(const std::vector<WlanStatus>& statuses);

    // 在超时时间内轮询，直到指定网卡不再关联到 expectedSsid。
    bool waitUntilDisconnected(const std::string& interfaceId, const std::string& expectedSsid);

    Options options_;
};

}  // namespace wifimeter::platform::windows
