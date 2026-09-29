#pragma once

// Windows 平台实现：组合 WLAN API 的状态/身份查询、IP Helper 的累计计数与断开控制。
//
// 采样时序不在这里：它由 platform/sampling.cpp 统一实现，Linux 与 Windows 调用同一份代码
// （见 LinkSource）。本类只负责“从系统取数据”，因此与 Linux 的差别只剩数据来源本身：
//
//   * 身份与计数来自两次独立的系统调用（WLAN API 与 IP Helper）；
//   * 断开是异步的：WlanDisconnect 只表示请求被接受，复核要等状态真正变成未连接，
//     因此按固定间隔轮询直到超时。等待函数可注入，测试无需真的睡眠。
//
// 另外支持测试用数据源：设置了 WIFIMETER_FAKE_ADAPTER / WIFIMETER_FAKE_COUNTERS 时，
// 数据改从 JSON 文件读取，用于两端共用的端到端测试。

#include <chrono>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "../network_platform.h"
#include "../sampling.h"
#include "system_api.h"

namespace wifimeter::platform::windows
{

class WindowsNetworkPlatform final : public NetworkPlatform, public LinkSource
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

    // LinkSource：数据来源。设置了测试用环境变量时改从 JSON 读取。
    LinkReadResult readLinks() override;
    CounterReadResult readCounters() override;
    DisconnectOutcome requestDisconnect(const std::string& interfaceId, std::string& detail) override;

private:
    // 一次状态读取，附带本轮遇到的失败。
    QueryResult<std::vector<WlanStatus>> readStatuses();

    // 把状态列表转成平台链接列表；失败单独返回，便于与状态分开处理。
    LinkReport linksFrom(const std::vector<WlanStatus>& statuses);

    // 在超时时间内轮询，直到指定网卡不再关联到 expectedSsid。
    bool waitUntilDisconnected(const std::string& interfaceId, const std::string& expectedSsid);

    // 测试数据源是否启用。
    bool fakeAdapterActive() const;
    bool fakeCountersActive() const;

    Options options_;
};

}  // namespace wifimeter::platform::windows
