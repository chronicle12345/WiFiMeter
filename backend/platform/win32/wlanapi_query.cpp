#include "wlanapi_query.h"

#include <algorithm>
#include <vector>

#include <netioapi.h>
#include <iphlpapi.h>

#include "../windows/text_convert.h"

namespace wifimeter::platform::windows
{
namespace
{

// WLAN API 与 IP Helper 都通过返回码报告错误，不用 GetLastError 之外的机制。
std::string errorDetail(const char* call, std::uint32_t code)
{
    return std::string(call) + " 失败，错误码 " + std::to_string(code);
}

// 会话失效与 WLAN 服务未启动都属于“依赖不可用”：前者重新打开会话即可恢复，
// 后者在服务启动前重试也不会成功，两种都按 unavailable 上报。
bool isUnavailable(std::uint32_t code)
{
    return code == ERROR_INVALID_HANDLE || code == ERROR_SERVICE_NOT_ACTIVE;
}

// 把定长的 WCHAR 数组转成 u16string，按第一个 NUL 截断。
std::u16string fromWideBuffer(const WCHAR* text, std::size_t capacity)
{
    std::size_t length = 0;
    while (length < capacity && text[length] != L'\0')
        ++length;
    return std::u16string(reinterpret_cast<const char16_t*>(text), length);
}

std::string utf8Of(const WCHAR* text, std::size_t capacity)
{
    return toUtf8(fromWideBuffer(text, capacity));
}

}  // namespace

Win32System::~Win32System()
{
    dropHandle();
}

void Win32System::dropHandle()
{
    if (handle_ != nullptr)
    {
        WlanCloseHandle(handle_, nullptr);
        handle_ = nullptr;
    }
}

std::uint32_t Win32System::ensureHandle()
{
    if (handle_ != nullptr)
        return ERROR_SUCCESS;

    DWORD negotiated = 0;
    HANDLE opened = nullptr;
    // 客户端版本 2：Windows Vista 及以上，才有 wlan_intf_opcode_current_connection 的完整属性。
    const DWORD code = WlanOpenHandle(2, nullptr, &negotiated, &opened);
    if (code != ERROR_SUCCESS)
    {
        handle_ = nullptr;
        return code;
    }
    handle_ = opened;
    negotiatedVersion_ = negotiated;
    return ERROR_SUCCESS;
}

std::string Win32System::aliasOf(const GUID& interfaceGuid) const
{
    NET_LUID luid{};
    if (ConvertInterfaceGuidToLuid(&interfaceGuid, &luid) != NO_ERROR)
        return {};

    wchar_t alias[IF_MAX_STRING_SIZE + 1] = {};
    // ConvertInterfaceLuidToAlias 的长度单位是字符数。
    if (ConvertInterfaceLuidToAlias(&luid, alias, IF_MAX_STRING_SIZE + 1) != NO_ERROR)
        return {};
    return utf8Of(alias, IF_MAX_STRING_SIZE + 1);
}

std::optional<int> Win32System::channelFrequency(const GUID& interfaceGuid) const
{
    // 当前信道。并非所有驱动都支持这个查询，因此失败或返回 0 都只当作“未知”，
    // 不生成失败记录：它只是展示信息，不影响计数与归属。
    DWORD size = 0;
    PVOID data = nullptr;
    WLAN_OPCODE_VALUE_TYPE valueType{};
    if (WlanQueryInterface(handle_, &interfaceGuid, wlan_intf_opcode_channel_number, nullptr, &size, &data, &valueType) != ERROR_SUCCESS)
    {
        if (data != nullptr)
            WlanFreeMemory(data);
        return std::nullopt;
    }
    std::optional<int> frequency;
    if (data != nullptr && size >= sizeof(ULONG))
        frequency = frequencyFromChannel(static_cast<int>(*static_cast<const ULONG*>(data)));
    if (data != nullptr)
        WlanFreeMemory(data);
    return frequency;
}

bool Win32System::connectionAttributes(const GUID& interfaceGuid, WLAN_CONNECTION_ATTRIBUTES& attributes) const
{
    DWORD size = 0;
    PVOID data = nullptr;
    WLAN_OPCODE_VALUE_TYPE valueType{};
    const DWORD code = WlanQueryInterface(handle_, &interfaceGuid, wlan_intf_opcode_current_connection, nullptr, &size, &data, &valueType);
    if (code != ERROR_SUCCESS || data == nullptr || size < sizeof(WLAN_CONNECTION_ATTRIBUTES))
    {
        if (data != nullptr)
            WlanFreeMemory(data);
        return false;
    }
    attributes = *static_cast<const WLAN_CONNECTION_ATTRIBUTES*>(data);
    WlanFreeMemory(data);
    return true;
}

QueryResult<std::vector<WlanStatus>> Win32System::wlanStatuses()
{
    std::uint32_t code = ensureHandle();
    if (code != ERROR_SUCCESS)
    {
        // WlanOpenHandle 失败通常意味着 WLAN 服务没在运行。
        dropHandle();
        return QueryResult<std::vector<WlanStatus>>::failed(FailureKind::unavailable, errorDetail("WlanOpenHandle", code));
    }

    PWLAN_INTERFACE_INFO_LIST list = nullptr;
    code = WlanEnumInterfaces(handle_, nullptr, &list);
    if (code != ERROR_SUCCESS || list == nullptr)
    {
        dropHandle();
        return QueryResult<std::vector<WlanStatus>>::failed(isUnavailable(code) ? FailureKind::unavailable : FailureKind::commandFailed, errorDetail("WlanEnumInterfaces", code));
    }

    QueryResult<std::vector<WlanStatus>> result;
    std::vector<WlanStatus>& statuses = result.value.emplace();
    statuses.reserve(list->dwNumberOfItems);
    for (DWORD index = 0; index < list->dwNumberOfItems; ++index)
    {
        const WLAN_INTERFACE_INFO& info = list->InterfaceInfo[index];

        WlanStatus status;
        status.interfaceId = aliasOf(info.InterfaceGuid);
        const std::string description = utf8Of(info.strInterfaceDescription, WLAN_MAX_NAME_LENGTH);
        if (status.interfaceId.empty())
        {
            // 拿不到别名（适配器刚被移除等）时用描述兜底，至少让上层看到“有这张网卡”。
            // 但这意味着身份与 IP Helper 的别名对不上，采样会缺计数，因此要上报失败，
            // 不能安静地降级成一个看起来正常的网卡。
            status.interfaceId = description;
            result.addFailure(FailureKind::inconsistent, "无法取得网卡的接口别名，已退回驱动描述。", status.interfaceId);
        }
        // 展示名称用驱动描述（例如 "MediaTek Wi-Fi 6E MT7922 ..."），与 Linux 侧的
        // 厂商 + 产品名对应；接口标识保持别名，因为两侧的计数都用别名做键。
        status.adapterAlias = adapterAliasFrom(description, status.interfaceId);

        WLAN_CONNECTION_ATTRIBUTES attributes{};
        if (connectionAttributes(info.InterfaceGuid, attributes))
        {
            status.connected = attributes.isState == wlan_interface_state_connected;
            status.mode = connectionModeFrom(static_cast<std::uint32_t>(attributes.wlanConnectionMode));
            status.profileName = utf8Of(attributes.strProfileName, WLAN_MAX_NAME_LENGTH);

            const DOT11_SSID& ssid = attributes.wlanAssociationAttributes.dot11Ssid;
            if (ssid.uSSIDLength > 0 && ssid.uSSIDLength <= DOT11_SSID_MAX_LENGTH)
            {
                // SSID 是原始字节串：直接按 UTF-8 解释，绝不经过宽字符。
                // 曾经把它当成 UTF-16 码元（reinterpret_cast 到 char16_t）来读，
                // 实测在真机上会把 "CMCC-mKm3-5G" 变成一串乱码，网络身份随之损坏。
                status.ssid = toUtf8Bytes(std::string_view(reinterpret_cast<const char*>(ssid.ucSSID), ssid.uSSIDLength));
            }

            if (status.connected)
            {
                status.signalPercent = attributes.wlanAssociationAttributes.wlanSignalQuality > 100 ? std::optional<int>{} : std::optional<int>{static_cast<int>(attributes.wlanAssociationAttributes.wlanSignalQuality)};
                status.frequencyMhz = channelFrequency(info.InterfaceGuid);
            }
        }
        else if (info.isState != wlan_interface_state_connected)
        {
            // 网卡本来就没连上：查不到连接属性是正常现象，不产生失败记录。
            status.connected = false;
            status.mode = ConnectionMode::discoverySecure;
        }
        else
        {
            // 枚举说已连接，但连接属性查不到：这是异常，不能安静地当成“未关联”，
            // 否则界面会显示成没连 Wi-Fi，用户看不出是查询失败。
            status.connected = false;
            status.mode = ConnectionMode::discoverySecure;
            result.addFailure(FailureKind::inconsistent, "网卡报告已连接，但无法读取连接属性。", status.interfaceId);
        }

        statuses.push_back(std::move(status));
    }

    WlanFreeMemory(list);
    return result;
}

DisconnectCommand Win32System::requestDisconnect(const std::string& interfaceId)
{
    DisconnectCommand command;

    const std::uint32_t code = ensureHandle();
    if (code != ERROR_SUCCESS)
    {
        dropHandle();
        command.failureKind = FailureKind::unavailable;
        command.detail = errorDetail("WlanOpenHandle", code);
        return command;
    }

    PWLAN_INTERFACE_INFO_LIST list = nullptr;
    const DWORD enumerated = WlanEnumInterfaces(handle_, nullptr, &list);
    if (enumerated != ERROR_SUCCESS || list == nullptr)
    {
        command.failureKind = isUnavailable(enumerated) ? FailureKind::unavailable : FailureKind::commandFailed;
        command.detail = errorDetail("WlanEnumInterfaces", enumerated);
        return command;
    }

    bool found = false;
    DWORD result = ERROR_NOT_FOUND;
    for (DWORD index = 0; index < list->dwNumberOfItems; ++index)
    {
        const WLAN_INTERFACE_INFO& info = list->InterfaceInfo[index];
        if (aliasOf(info.InterfaceGuid) != interfaceId)
            continue;
        found = true;
        result = WlanDisconnect(handle_, &info.InterfaceGuid, nullptr);
        break;
    }
    WlanFreeMemory(list);

    if (!found)
    {
        // 目标网卡已经不在列表里：等价于“已经不关联”，由编排层复核后按结果分类。
        command.failureKind = FailureKind::unavailable;
        command.detail = "WLAN 适配器不在当前接口列表中。";
        return command;
    }

    if (result == ERROR_SUCCESS)
    {
        command.accepted = true;
        return command;
    }

    if (isUnavailable(result))
        dropHandle();
    command.failureKind = isUnavailable(result) ? FailureKind::unavailable : FailureKind::commandFailed;
    command.detail = errorDetail("WlanDisconnect", result);
    return command;
}

QueryResult<std::vector<InterfaceCounters>> Win32System::interfaceCounters()
{
    PMIB_IF_TABLE2 table = nullptr;
    const NETIO_STATUS status = GetIfTable2(&table);
    if (status != NO_ERROR || table == nullptr)
        return QueryResult<std::vector<InterfaceCounters>>::failed(FailureKind::commandFailed, errorDetail("GetIfTable2", static_cast<std::uint32_t>(status)));

    std::vector<RawInterfaceRow> rows;
    rows.reserve(table->NumEntries);
    for (ULONG index = 0; index < table->NumEntries; ++index)
    {
        const MIB_IF_ROW2& row = table->Table[index];
        RawInterfaceRow converted;
        converted.alias = fromWideBuffer(row.Alias, IF_MAX_STRING_SIZE + 1);
        converted.description = fromWideBuffer(row.Description, IF_MAX_STRING_SIZE + 1);
        converted.index = row.InterfaceIndex;
        converted.type = static_cast<std::uint32_t>(row.Type);
        converted.rxBytes = row.InOctets;
        converted.txBytes = row.OutOctets;
        rows.push_back(std::move(converted));
    }

    FreeMibTable(table);
    return QueryResult<std::vector<InterfaceCounters>>::success(countersFromRows(rows));
}

}  // namespace wifimeter::platform::windows
