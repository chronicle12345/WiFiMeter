#pragma once

// NetworkManager 命令行接口的封装与输出解析。
//
// 为什么不直接用系统语言环境下的可读文本：nmcli 的状态文字与是否列（如
// "connected"/"已连接"、"yes"/"否"）会随语言环境变化，而连接名与 SSID 是原样输出的
// UTF-8 用户数据。强制 LC_ALL=C 会把用户数据里的非 ASCII 字符替换成 "?"
// （实测 "有线连接 1" 变成 "???? 1"），因此这里保留调用方的语言环境，
// 只解析与语言环境无关的部分：ASCII 字段名、状态码数字、SSID 原文匹配。

#include <chrono>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "../network_platform.h"

namespace wifimeter::platform::linux
{

struct CommandResult
{
    bool started = false;  // 可执行文件是否成功启动
    bool timedOut = false;
    int exitCode = -1;
    std::string output;  // 标准输出
    std::string error;   // 标准错误，用于诊断
};

// 直接 spawn，不经过 shell；超时后终止子进程。
CommandResult runCommand(const std::vector<std::string>& argv, std::chrono::milliseconds timeout = std::chrono::seconds(8));

// 把命令结果映射为类型化失败；命令成功时返回空值。
std::optional<Failure> commandFailure(const CommandResult& result, std::string interfaceId = {});

// nmcli 的 terse 输出用反斜杠转义 ":" 与 "\"，例如 BSSID 会写成 42\:4A\:97\:E4\:D2\:27。
std::string unescapeTerse(std::string_view value);

// 按未转义的冒号切分，并还原转义。
std::vector<std::string> splitTerseFields(std::string_view line);

// 按第一个未转义的冒号切成字段名与取值。
std::pair<std::string, std::string> splitTersePair(std::string_view line);

// 解析成组的 "键:值" 输出（nmcli dev show 用空行分组）。
std::vector<std::map<std::string, std::string>> parseTerseBlocks(std::string_view output);

// 取以数字开头的取值，例如 "30（已断开）" 得到 30；无法解析时返回 -1。
int parseLeadingInt(std::string_view value);

struct DeviceStatus
{
    std::string device;
    std::string type;    // wifi / ethernet / bridge ...
    int stateCode = -1;  // 100 表示已激活
    std::string connection;
    std::string connectionUuid;
    std::string vendor;               // 例：Intel Corporation
    std::string product;              // 例：Ethernet Connection (2) I219-V
    std::optional<std::string> ssid;  // 仅已激活的无线网卡能取到时填充
};

// 解析 nmcli -t -f GENERAL.* dev show 的输出。
std::vector<DeviceStatus> parseDeviceStatus(std::string_view output);

// 由厂商与产品名组合展示名称；信息不足时返回空字符串。
std::string adapterAliasFrom(const std::string& vendor, const std::string& product);

struct WifiBss
{
    std::string ssid;
    std::optional<int> signalPercent;  // 0..100
    std::optional<int> frequencyMhz;
};

// 解析 nmcli -t -f IN-USE,SSID,SIGNAL,FREQ dev wifi list 的输出。
std::vector<WifiBss> parseWifiList(std::string_view output);

// 按 SSID 精确匹配；同名接入点取信号最强者。空 SSID 不参与匹配。
std::optional<WifiBss> findBssBySsid(const std::vector<WifiBss>& list, std::string_view ssid);

// nmcli 查询入口。所有查询都通过独立子进程执行，失败以 Failure 上报。
class Nmcli
{
public:
    explicit Nmcli(std::string executable = "nmcli", std::chrono::milliseconds timeout = std::chrono::seconds(8));

    const std::string& executable() const
    {
        return executable_;
    }
    std::chrono::milliseconds timeout() const
    {
        return timeout_;
    }

    struct DevicesResult
    {
        std::vector<DeviceStatus> devices;
        std::optional<Failure> failure;  // 有值表示本轮查询失败
        bool ok() const
        {
            return !failure.has_value();
        }
    };
    // 查询所有网卡状态，并为已激活的无线网卡补全 SSID。
    DevicesResult devices() const;

    struct WifiListResult
    {
        std::vector<WifiBss> list;
        std::optional<Failure> failure;
        bool ok() const
        {
            return !failure.has_value();
        }
    };
    WifiListResult wifiList(const std::string& interfaceId) const;

    // 由连接配置 UUID 读取 802-11-wireless.ssid；查不到返回空值。
    std::optional<std::string> ssidForUuid(const std::string& uuid) const;

    // 断开指定网卡。调用方负责先用身份识别确认目标网络。
    CommandResult disconnect(const std::string& interfaceId) const;

private:
    std::string executable_;
    std::chrono::milliseconds timeout_;
};

}  // namespace wifimeter::platform::linux
