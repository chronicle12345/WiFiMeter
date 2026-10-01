#pragma once

// 无线网卡的控制能力：断开当前连接。
//
// 断开是会改变用户网络状态的操作，因此分成三步：判定 → 执行 → 复核。
// 判定要求目标网卡当前关联的正是期望的网络，否则拒绝执行，避免在用户切换网络后误断其他网络；
// 复核确认断开确实生效。三步的编排在 LinuxNetworkPlatform 中完成。

#include <string>
#include <string_view>

#include "../network_platform.h"
#include "nmcli.h"

namespace wifimeter::platform::linux
{

// 纯判定，不执行系统命令：只有在关联到期望网络时才允许断开。
DisconnectOutcome decideDisconnect(std::string_view currentSsid, std::string_view expectedSsid);

// 执行断开命令并分类结果，不做守卫也不复核；outcome 为 disconnected 仅表示命令成功。
DisconnectReport requestDisconnect(const std::string& interfaceId, const Nmcli& nmcli);

}  // namespace wifimeter::platform::linux
