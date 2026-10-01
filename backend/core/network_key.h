#pragma once

// 网络身份到稳定键的映射。
//
// 快照要求 network.id 匹配 ^[-a-zA-Z0-9_]+$（apps/desktop/renderer/data/model.js），
// 而 SSID 可以包含空格、中文与冒号，因此不能直接用作键。
//
// 取键策略：优先使用连接配置 UUID——它跨重启稳定、天然符合字符集要求，也不受 SSID
// 改名影响；只有在拿不到配置 UUID（例如连接由外部管理）时才退回由 SSID 派生的散列键。
// 代价是：用户删除并重建 Wi-Fi 配置后，历史会分成两条记录；上层可以按 ssid 归并显示。

#include <string>
#include <string_view>

#include "../platform/network_platform.h"

namespace wifimeter::core
{

struct NetworkRef
{
    std::string key;   // 稳定键，符合快照对 network.id 的字符集约束
    std::string ssid;  // 用户可见的网络名，可为空
    std::string type = "wifi";  // wifi / ethernet，随采样传播到用量和存储

    bool valid() const
    {
        return !key.empty();
    }
};

// 由平台身份推导网络引用；无法确定身份时返回 key 为空的结果。
NetworkRef networkRefOf(const platform::NetworkIdentity& identity);

// 判断字符串能否直接作为快照中的 network.id 使用。
bool isValidNetworkKey(std::string_view key);

// 仅由 SSID 派生键：ssid_ 加 FNV-1a 64 位散列的十六进制。SSID 为空时返回空字符串。
std::string fallbackKeyForSsid(std::string_view ssid);

}  // namespace wifimeter::core
