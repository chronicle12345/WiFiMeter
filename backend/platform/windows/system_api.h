#pragma once

// Windows 采集层从系统读取数据的边界。
//
// 平台编排（windows_network_platform.*）只依赖这个接口，因此可以在 Linux 开发机上用
// 构造的数据验证“采样前后各确认一次身份”“断开后复核”“超时后放弃”等全部判断逻辑；
// 真正调用 Win32 的实现放在 wlanapi_query.*，那里只剩“取数据、搬字段”的机械代码。
//
// 约定与 platform/network_platform.h 一致：只报告事实与类型化失败，不生成界面文案。

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "../network_platform.h"
#include "interface_counters.h"
#include "wlan.h"

namespace wifimeter::platform::windows
{

// 一次查询的结果：要么拿到数据，要么拿到类型化失败。
// 不用异常：后端是长驻进程，异常会把“某个 API 暂时不可用”升级成进程级故障。
template <typename T>
struct QueryResult
{
    std::optional<T> value;
    // 逐条失败：单张网卡的失败不能覆盖另一张的，也不能让整体结果变成“不可用”。
    std::vector<Failure> failures;

    bool ok() const
    {
        return value.has_value();
    }

    static QueryResult success(T data)
    {
        QueryResult result;
        result.value = std::move(data);
        return result;
    }

    static QueryResult failed(FailureKind kind, std::string detail = {}, std::string interfaceId = {})
    {
        QueryResult result;
        result.failures.push_back(Failure{kind, std::move(interfaceId), std::move(detail)});
        return result;
    }

    void addFailure(FailureKind kind, std::string detail = {}, std::string interfaceId = {})
    {
        failures.push_back(Failure{kind, std::move(interfaceId), std::move(detail)});
    }
};

// 网卡的当前状态与身份，来自一次 WLAN 查询。
struct WlanStatus
{
    std::string interfaceId;
    std::string adapterAlias;  // 展示名称，取不到更好的名称时等于 interfaceId
    bool connected = false;
    ConnectionMode mode = ConnectionMode::discoverySecure;
    std::string profileName;
    std::optional<std::string> ssid;
    std::optional<int> signalPercent;
    std::optional<int> frequencyMhz;  // 2.4 GHz 信道可从信道号推出；其余频段留空
};

// 由状态导出身份。profileUuid 留空：Windows 的配置名不满足快照 network.id 的字符集，
// 由 core/network_key 统一退回按 SSID 散列取键。
NetworkIdentity identityOf(const WlanStatus& status);

// 只保留已关联网卡的状态；未关联的网卡不产生样本，也**不算失败**。
std::vector<WlanStatus> associatedOnly(const std::vector<WlanStatus>& statuses);

// 按网卡名称查找状态，找不到返回空值。
const WlanStatus* findStatus(const std::vector<WlanStatus>& statuses, std::string_view interfaceId);

// 一次断开请求的结果。
struct DisconnectCommand
{
    bool accepted = false;             // 系统接受了断开请求
    FailureKind failureKind = FailureKind::unavailable;
    std::string detail;  // 原始诊断信息，可为空
};

// 系统查询接口。实现见 wlanapi_query.*（Windows）与测试里的假实现。
class SystemApi
{
public:
    virtual ~SystemApi() = default;

    SystemApi(const SystemApi&) = delete;
    SystemApi& operator=(const SystemApi&) = delete;

    // 读取所有无线网卡的状态。
    virtual QueryResult<std::vector<WlanStatus>> wlanStatuses() = 0;

    // 请求断开指定网卡；不做守卫也不复核。
    virtual DisconnectCommand requestDisconnect(const std::string& interfaceId) = 0;

    // 读取所有网卡的累计字节数（含非无线网卡）。
    virtual QueryResult<std::vector<InterfaceCounters>> interfaceCounters() = 0;

protected:
    SystemApi() = default;
};

}  // namespace wifimeter::platform::windows
