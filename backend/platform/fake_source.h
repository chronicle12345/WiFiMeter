#pragma once

// 测试用数据源：从环境变量指向的 JSON 文件读取网卡状态与计数。
//
//   WIFIMETER_FAKE_ADAPTER  → {"adapters":[{"name":"wlan0","description":"AICSemi AIC8800DC",
//                              "connected":true,"mode":0,"profile":"Home","ssid":"Home",
//                              "signal":82,"frequency":5180,"channel":36}]}
//   WIFIMETER_FAKE_COUNTERS → {"interfaces":[{"name":"wlan0","rx":5000000,"tx":900000}]}
//
// 两个文件每次调用都重新读取，因此测试可以在两次采样之间改内容（制造增量、切换网络）。
// 只有显式设置环境变量时才生效：正式运行完全走系统数据源。
//
// 这条通道让“真子进程 + 真协议 + 真 SQLite”的端到端测试在 Linux 与 Windows 上跑同一份
// 序列——Windows 没有 nmcli 之类的命令行可以替换，只能由平台层自己读文件。

#include <optional>
#include <string>
#include <vector>

#include "network_platform.h"
#include "sampling.h"

namespace wifimeter::platform::fake
{

// 测试数据里的一个网卡。
struct FakeAdapter
{
    std::string name;
    std::string description;
    bool connected = false;
    // 平台无关的连接模式：0 按配置连接、1 临时配置、2/3 扫描中、4 自动连接。
    // 两端都会映射到各自的类型（Windows 直接就是 WLAN_CONNECTION_MODE）。
    std::uint32_t mode = 0;
    std::string profileName;
    std::optional<std::string> ssid;
    std::optional<int> signalPercent;
    std::optional<int> frequencyMhz;
    std::optional<int> channel;
};

// 解析网卡 JSON；无法解析时返回空值。
std::optional<std::vector<FakeAdapter>> parseAdapters(std::string_view text);

// 把测试数据转换成平台无关的链路状态。
std::vector<WifiLink> linksFromAdapters(const std::vector<FakeAdapter>& adapters);

// 按 id 查找。
std::optional<FakeAdapter> findAdapter(const std::vector<FakeAdapter>& adapters, std::string_view name);

// 测试数据源是否启用。
bool adapterOverrideActive();

// 读取测试数据；未启用或读不到时返回空值。
std::optional<std::vector<FakeAdapter>> readOverriddenAdapters();

// 直接用测试数据实现的链路数据源：端到端测试用它替换系统实现。
class FakeLinkSource final : public LinkSource
{
public:
    FakeLinkSource() = default;

    // 断开请求的结果由测试决定：默认成功，便于验证复核逻辑。
    bool acceptDisconnect = true;

    LinkReadResult readLinks() override;
    CounterReadResult readCounters() override;
    DisconnectOutcome requestDisconnect(const std::string& interfaceId, std::string& detail) override;
};

}  // namespace wifimeter::platform::fake
