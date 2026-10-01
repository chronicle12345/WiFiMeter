#include "interface_counters.h"

#include <algorithm>
#include <cctype>
#include <set>

#include "text_convert.h"

namespace wifimeter::platform::windows
{

std::string toInterfaceId(std::u16string_view alias, std::size_t index)
{
    const std::string name = toUtf8(alias);
    if (!name.empty())
        return name;
    // 名称缺失时用接口索引兜底，保证列表与查找用的是同一个键。
    return "if" + std::to_string(index);
}

std::vector<InterfaceCounters> countersFromRows(const std::vector<RawInterfaceRow>& rows)
{
    std::vector<InterfaceCounters> counters;
    counters.reserve(rows.size());
    for (const RawInterfaceRow& row : rows)
    {
        InterfaceCounters entry;
        entry.interfaceId = toInterfaceId(row.alias, row.index);
        entry.rxBytes = row.rxBytes;
        entry.txBytes = row.txBytes;
        counters.push_back(std::move(entry));
    }
    return counters;
}

std::vector<InterfaceCounters> wifiCountersFromRows(const std::vector<RawInterfaceRow>& rows)
{
    std::vector<InterfaceCounters> counters;
    counters.reserve(rows.size());
    for (const RawInterfaceRow& row : rows)
    {
        if (row.type != kIeee80211InterfaceType)
            continue;
        InterfaceCounters entry;
        entry.interfaceId = toInterfaceId(row.alias, row.index);
        entry.rxBytes = row.rxBytes;
        entry.txBytes = row.txBytes;
        counters.push_back(std::move(entry));
    }
    return counters;
}

std::vector<WifiLink> ethernetLinksFromRows(const std::vector<RawInterfaceRow>& rows)
{
    std::vector<WifiLink> links;
    std::set<std::string> seen;
    for (const auto& row : rows)
    {
        if (row.type != 6 || !row.hardware || row.guid.empty())
            continue;
        std::string description = toUtf8(row.alias) + " " + toUtf8(row.description);
        std::transform(description.begin(), description.end(), description.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
        if (description.find("vethernet") != std::string::npos || description.find("virtual") != std::string::npos ||
            description.find("vmware") != std::string::npos || description.find("hyper-v") != std::string::npos)
            continue;
        std::string guid = row.guid;
        if (guid.size() == 38 && guid.front() == '{' && guid.back() == '}')
            guid = guid.substr(1, 36);
        std::transform(guid.begin(), guid.end(), guid.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
        if (!seen.insert(guid).second)
            continue;
        WifiLink link;
        link.interfaceId = toInterfaceId(row.alias, row.index);
        link.adapterAlias = toUtf8(row.alias);
        if (link.adapterAlias.empty())
            link.adapterAlias = link.interfaceId;
        link.identity = ethernetIdentity(guid, link.adapterAlias, row.up);
        links.push_back(std::move(link));
    }
    return links;
}

std::optional<InterfaceCounters> findInterfaceCounters(const std::vector<InterfaceCounters>& counters, std::string_view interfaceId)
{
    const auto found = std::find_if(counters.begin(), counters.end(), [interfaceId](const InterfaceCounters& item) { return item.interfaceId == interfaceId; });
    if (found == counters.end())
        return std::nullopt;
    return *found;
}

}  // namespace wifimeter::platform::windows
