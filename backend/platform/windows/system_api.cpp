#include "system_api.h"

#include <algorithm>
#include <iterator>

namespace wifimeter::platform::windows
{

NetworkIdentity identityOf(const WlanStatus& status)
{
    NetworkIdentity identity;
    identity.profileName = status.profileName;
    if (status.connected && isConnectedMode(status.mode) && status.ssid && !status.ssid->empty())
        identity.ssid = status.ssid;
    return identity;
}

std::vector<WlanStatus> associatedOnly(const std::vector<WlanStatus>& statuses)
{
    std::vector<WlanStatus> associated;
    std::copy_if(statuses.begin(), statuses.end(), std::back_inserter(associated), [](const WlanStatus& status) {
        // 用 isConnectedMode 而不是逐个比较取值：auto（自动连接首选网络）同样算已连接，
        // 漏掉它会让真机上永远没有样本。
        return status.connected && isConnectedMode(status.mode) && status.ssid.has_value() && !status.ssid->empty();
    });
    return associated;
}

const WlanStatus* findStatus(const std::vector<WlanStatus>& statuses, std::string_view interfaceId)
{
    const auto found = std::find_if(statuses.begin(), statuses.end(), [interfaceId](const WlanStatus& status) { return status.interfaceId == interfaceId; });
    return found == statuses.end() ? nullptr : &*found;
}

}  // namespace wifimeter::platform::windows
