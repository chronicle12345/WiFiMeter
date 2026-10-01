#include "wifi_control.h"

#include <algorithm>

namespace wifimeter::platform::linux
{
namespace
{

// 命令输出只用于日志与排查，压成单行并限制长度。
std::string condense(std::string_view text, std::size_t limit = 200)
{
    std::string result;
    result.reserve(std::min(text.size(), limit));
    bool lastWasSpace = false;
    for (const char value : text)
    {
        if (result.size() >= limit)
            break;
        const bool space = value == '\n' || value == '\r' || value == '\t';
        if (space)
        {
            if (lastWasSpace)
                continue;
            result.push_back(' ');
            lastWasSpace = true;
            continue;
        }
        result.push_back(value);
        lastWasSpace = false;
    }
    while (!result.empty() && result.back() == ' ')
        result.pop_back();
    return result;
}

}  // namespace

DisconnectOutcome decideDisconnect(std::string_view currentSsid, std::string_view expectedSsid)
{
    if (currentSsid.empty())
        return DisconnectOutcome::notAssociated;
    if (currentSsid != expectedSsid)
        return DisconnectOutcome::ssidMismatch;
    return DisconnectOutcome::disconnected;
}

DisconnectReport requestDisconnect(const std::string& interfaceId, const Nmcli& nmcli)
{
    DisconnectReport report;
    const CommandResult command = nmcli.disconnect(interfaceId);
    if (const auto failure = commandFailure(command, interfaceId))
    {
        report.outcome = failure->kind == FailureKind::unavailable ? DisconnectOutcome::unavailable : DisconnectOutcome::commandFailed;
        report.detail = condense(failure->detail);
        return report;
    }

    report.outcome = DisconnectOutcome::disconnected;
    return report;
}

}  // namespace wifimeter::platform::linux
