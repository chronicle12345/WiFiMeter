#pragma once

// 累计字节数的读取入口。
//
// 默认读系统数据源（Linux 是 /proc/net/dev，Windows 是 IP Helper）；如果设置了环境变量
// WIFIMETER_FAKE_COUNTERS，则改读一个 JSON 文件。这条通道是给自动测试用的：
//
//   * 两端用同一份计数数据，端到端测试（真子进程 + 真协议 + 真 SQLite）不必碰真实网卡；
//   * 文件每次采样都重新读取，因此测试可以在两次采样之间改数字来制造增量；
//   * 只有显式设置环境变量时才生效，正式运行不受影响。
//
// JSON 形状与 WIFIMETER_FAKE_ADAPTER 同构：{"interfaces":[{"name":"wlan0","rx":1,"tx":2}]}。

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace wifimeter::platform
{

// 一张网卡的累计计数。两端各自的平台类型都转换到这个形状后再交给编排层。
struct CounterReading
{
    std::string interfaceId;
    std::uint64_t rxBytes = 0;
    std::uint64_t txBytes = 0;
};

namespace fake
{

// 环境变量名：分别指向包含网卡状态与计数的 JSON 文件。
inline constexpr const char* kCountersVariable = "WIFIMETER_FAKE_COUNTERS";
inline constexpr const char* kAdapterVariable = "WIFIMETER_FAKE_ADAPTER";

// 读取文本的来源。默认从文件读。
using TextSource = std::function<std::optional<std::string>(const std::string& path)>;

// 解析计数 JSON；无法解析时返回空值（调用方按“读不到”处理）。
std::optional<std::vector<CounterReading>> parseCounters(std::string_view text);

// 按 id 在列表里查找计数。
std::optional<CounterReading> findCounters(const std::vector<CounterReading>& counters, std::string_view interfaceId);

// 测试用数据源的路径。由 main 在启动时从环境变量读一次并保存，平台侧只问这里要路径，
// 因此“怎么传进来”与“怎么用”是分开的（Windows 的子进程环境块很容易踩坑，
// 也可以改成命令行参数传入，平台代码不用动）。
void configureFromEnvironment();
void setAdapterPath(std::string path);
void setCountersPath(std::string path);
const std::string& adapterPath();
const std::string& countersPath();

// 测试用数据源是否已启用。
bool countersOverrideActive();
bool adapterOverrideActive();

// 读取被覆盖的计数；返回空值表示不可用（此时调用方应给出失败）。
std::optional<std::vector<CounterReading>> readOverriddenCounters();
std::optional<std::vector<CounterReading>> readOverriddenCounters(const TextSource& source);

// 读取文本文件，供平台实现复用（Windows 上没有 shell，只能读文件）。
std::optional<std::string> readTextFile(const std::string& path);

}  // namespace fake
}  // namespace wifimeter::platform
