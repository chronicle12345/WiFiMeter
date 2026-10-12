#pragma once

// 测试用数据源：从环境变量指向的 JSON 文件读取网卡状态与计数。
//
//   WIFIMETER_FAKE_ADAPTER  → {"adapters":[{"name":"wlan0","description":"AICSemi AIC8800DC",
//                              "connected":true,"profile":"Home","ssid":"Home",
//                              "signal":82,"frequency":5180}]}
//   WIFIMETER_FAKE_COUNTERS → {"interfaces":[{"name":"wlan0","rx":5000000,"tx":900000}]}
//
// 有线测试数据使用 type=ethernet 和 stableId（GUID 或 Linux 设备身份），不需要 ssid。
// 两个文件每次调用都重新读取，因此测试可以在两次采样之间改内容（制造增量、切换网络）。
// 只有显式设置环境变量时才生效：正式运行完全走系统数据源。
//
// 这条通道让真实子进程、协议和 SQLite 的端到端测试在 Linux 与 Windows 上使用同一份
// 序列。Windows 没有 nmcli 之类的命令行可以替换，由平台层直接读取测试文件。

#include <optional>
#include <string>
#include <vector>

#include "network_platform.h"

namespace wifimeter::platform::fake
{

// 测试数据里的一个网卡。
struct FakeAdapter
{
    std::string name;
    std::string description;
    bool connected = false;
    std::string profileName;
    std::optional<std::string> ssid;
    std::optional<int> signalPercent;
    std::optional<int> frequencyMhz;
    std::string type = "wifi";
    std::string stableId;
};

// 解析网卡 JSON；无法解析时返回空值。
std::optional<std::vector<FakeAdapter>> parseAdapters(std::string_view text);

// 把测试数据转换成平台无关的链路状态。
std::vector<WifiLink> linksFromAdapters(const std::vector<FakeAdapter>& adapters);

// 测试数据源是否启用。
bool adapterOverrideActive();

// 读取测试数据；未启用或读不到时返回空值。
std::optional<std::vector<FakeAdapter>> readOverriddenAdapters();

}  // namespace wifimeter::platform::fake
