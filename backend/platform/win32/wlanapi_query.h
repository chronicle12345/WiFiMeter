#pragma once

// Windows 系统调用实现：WLAN API 提供无线状态与身份，IP Helper 提供累计计数。
//
// 这个文件是平台层唯一直接调用 Win32 的地方，只在目标系统为 Windows 时构建。
// 所有字段的搬运与判断都在 system_api.h / wlan.h 里，因此这里尽量只做三件事：
//
//   1. 打开 WLAN 会话并在服务重启后重新打开（长时间运行的后端会遇到服务重启）；
//   2. 把系统结构搬进 RawWlanInterface / RawInterfaceRow；
//   3. 把 Win32 错误码分类成 FailureKind，原始错误码放进 detail 供排查。
//
// 为什么同时用两套 API：WLAN API 只说“WLAN 适配器”，它的 GUID 与 IP Helper 的接口名
// 不是同一套标识，而计数只有 IP Helper 才有。两者用 NET_LUID 关联（先由 GUID 求 LUID，
// 再由 LUID 求别名），因此 interfaceId 在两侧是同一个字符串。

#include "system_api.h"

#if !defined(_WIN32)
#error "wlanapi_query.h 只能在 Windows 目标上构建。"
#endif

#include <cstdint>
#include <optional>
#include <string>

#include <winsock2.h>
#include <ws2ipdef.h>
#include <windows.h>
#include <wlanapi.h>

namespace wifimeter::platform::windows
{

class Win32System final : public SystemApi
{
public:
    Win32System() = default;
    ~Win32System() override;

    Win32System(const Win32System&) = delete;
    Win32System& operator=(const Win32System&) = delete;

    QueryResult<std::vector<WlanStatus>> wlanStatuses() override;
    DisconnectCommand requestDisconnect(const std::string& interfaceId) override;
    QueryResult<std::vector<InterfaceCounters>> interfaceCounters() override;
    QueryResult<std::optional<std::string>> currentProfileName(const std::string& interfaceId) override;

private:
    // 打开 WLAN 会话；失败时返回错误码，detail 由调用方补充。
    std::uint32_t ensureHandle();

    // 会话失效（WLAN 服务重启）时关闭，下次调用重新打开。
    void dropHandle();

    // GUID → 接口别名（与 IP Helper 的 Alias 一致）；失败返回空串。
    std::string aliasOf(const GUID& interfaceGuid) const;

    // 读取单张网卡的当前连接属性；未连接或读取失败时返回空值。
    bool connectionAttributes(const GUID& interfaceGuid, WLAN_CONNECTION_ATTRIBUTES& attributes) const;

    // 当前信道对应的频率；驱动不支持该查询时返回空值。
    std::optional<int> channelFrequency(const GUID& interfaceGuid) const;

    HANDLE handle_ = nullptr;
    std::uint32_t negotiatedVersion_ = 0;
};

}  // namespace wifimeter::platform::windows
