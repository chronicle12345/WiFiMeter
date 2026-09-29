#include "interface_counters.h"

#include <algorithm>

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

std::optional<InterfaceCounters> findInterfaceCounters(const std::vector<InterfaceCounters>& counters, std::string_view interfaceId)
{
    const auto found = std::find_if(counters.begin(), counters.end(), [interfaceId](const InterfaceCounters& item) { return item.interfaceId == interfaceId; });
    if (found == counters.end())
        return std::nullopt;
    return *found;
}

}  // namespace wifimeter::platform::windows
