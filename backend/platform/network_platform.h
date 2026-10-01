#pragma once

// 平台无关的网络采集、身份识别与控制接口。
//
// 设计约定：
//
//   * 平台层只报告事实、分类与原始诊断，不生成面向用户的句子。失败用类型化的
//     FailureKind 表达，界面文案由上层（core/ipc）决定，便于以后翻译或多处复用。
//   * 未知值用 std::optional 表达，不用 -1 或空字符串之类的哨兵值。
//   * 身份由 NetworkIdentity 描述：profileUuid 是稳定的持久键，ssid 是用户认得的
//     网络名。平台层不把它们映射成快照中的 network.id。
//   * 采样前必须确认网卡确实关联在某个网络上，采样期间身份发生变化则丢弃该样本，
//     否则会把切换网络时的流量记到错误的网络。
//
// 字节数统一为无符号 64 位累计值，对应快照中以十进制字符串表示的 rxBytes / txBytes；
// 差值计算与计数器回绕判断属于上层职责。

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace wifimeter::platform
{

// 频段分类。标签只是单位格式化，不含需要翻译的措辞。
enum class Band
{
    unknown,
    ghz2_4,
    ghz5,
    ghz6,
    ghz60,
};

Band classifyBand(int frequencyMhz);

// 频段标签，例如 "5 GHz"；未知返回空视图。
std::string_view bandLabel(Band band);

// 失败原因分类。detail 只放原始系统诊断信息（如命令的标准错误），不放界面文案。
enum class FailureKind
{
    unavailable,      // 依赖的系统服务或命令不存在
    timeout,          // 系统命令超时
    commandFailed,    // 系统命令返回失败
    malformedOutput,  // 系统输出无法解析
    inconsistent,     // 系统信息互相矛盾，或采样期间身份发生变化
    countersMissing,  // 找不到该网卡的累计计数
};

struct Failure
{
    FailureKind kind = FailureKind::unavailable;
    std::string interfaceId;  // 相关网卡；不针对具体网卡时为空
    std::string detail;       // 原始诊断信息，可为空
};

// 网络身份。未关联任何网络时 ssid 为空值。
struct NetworkIdentity
{
    std::optional<std::string> profileUuid;  // 连接配置 UUID，跨重启稳定
    std::string profileName;                 // 连接配置名称
    std::optional<std::string> ssid;         // 当前关联的网络名

    // 有线使用保留身份作为 ssid，展示名称保存在 profileName。
    std::string type = "wifi";

    bool associated() const
    {
        return ssid.has_value();
    }
};

// 物理有线身份：稳定设备标识决定键，名称变化不改变归属。
NetworkIdentity ethernetIdentity(std::string_view stableId, const std::string& name, bool connected);

// 一张网卡的当前状态；类型由 identity.type 指明。
struct WifiLink
{
    std::string interfaceId;   // 内核接口名，稳定且唯一
    std::string adapterAlias;  // 用于展示的网卡名称，取不到更好的名称时等于 interfaceId
    NetworkIdentity identity;
    std::optional<int> signalPercent;  // 0..100
    std::optional<int> frequencyMhz;
    Band band = Band::unknown;
};

struct LinkReport
{
    std::vector<WifiLink> links;    // 含未关联的网卡：identity.ssid 为空值即为未关联
    std::vector<Failure> failures;  // 空表示本轮信息完整

    bool complete() const
    {
        return failures.empty();
    }
};

// 一次采样：采样期间两次确认一致的身份，加上该网卡的累计字节数。
struct WifiSample
{
    std::string interfaceId;
    NetworkIdentity identity;
    std::uint64_t rxBytes = 0;
    std::uint64_t txBytes = 0;
};

struct SampleReport
{
    std::vector<WifiSample> samples;
    // 采样时确认过的网卡状态（含频段与信号）。它与 samples 来自同一轮身份识别，
    // 因此上层展示实时状态时不必再查一次系统。
    std::vector<WifiLink> links;
    std::vector<Failure> failures;  // 单张网卡失败不影响其他网卡的样本

    bool complete() const
    {
        return failures.empty();
    }
};

enum class DisconnectOutcome
{
    disconnected,     // 已断开，并复核确认不再关联
    notAssociated,    // 当前未关联任何网络
    ssidMismatch,     // 当前关联的不是期望的网络，已拒绝执行
    stillAssociated,  // 命令成功，但复核时仍在关联（例如随即被自动重连）
    unavailable,      // 缺少可用的系统控制通道
    commandFailed,    // 系统命令执行失败
};

struct DisconnectReport
{
    DisconnectOutcome outcome = DisconnectOutcome::commandFailed;
    std::string detail;  // 原始诊断信息，可为空
};

class NetworkPlatform
{
public:
    virtual ~NetworkPlatform() = default;

    NetworkPlatform(const NetworkPlatform&) = delete;
    NetworkPlatform& operator=(const NetworkPlatform&) = delete;

    // 读取所有无线网卡的当前状态，不改变系统状态。
    virtual LinkReport wirelessLinks() = 0;

    // 兼容旧入口名称，采样 WiFi 和物理有线网卡；调用方必须传播 identity.type。
    virtual SampleReport sampleWifi() = 0;

    // 只在 interfaceId 当前关联到 expectedSsid 时断开，并在断开后复核。
    virtual DisconnectReport disconnectIfAssociated(const std::string& interfaceId, const std::string& expectedSsid) = 0;

protected:
    NetworkPlatform() = default;
};

}  // namespace wifimeter::platform
