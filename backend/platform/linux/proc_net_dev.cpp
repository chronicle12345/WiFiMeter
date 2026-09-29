#include "proc_net_dev.h"

#include <algorithm>
#include <charconv>

#include "text_file.h"

namespace wifimeter::platform::linux
{
namespace
{

// /proc/net/dev 每行形如：
//   wlan0: 12345 67 0 0 0 0 0 0 890 12 0 0 0 0 0 0
// 冒号后依次是接收 8 列与发送 8 列，接收字节是第 0 列，发送字节是第 8 列。
constexpr std::size_t kTransmitBytesIndex = 8;

bool isSpace(char value)
{
    return value == ' ' || value == '\t' || value == '\r';
}

std::string_view trim(std::string_view text)
{
    while (!text.empty() && isSpace(text.front()))
        text.remove_prefix(1);
    while (!text.empty() && isSpace(text.back()))
        text.remove_suffix(1);
    return text;
}

std::vector<std::string_view> splitFields(std::string_view text)
{
    std::vector<std::string_view> fields;
    std::size_t index = 0;
    while (index < text.size())
    {
        while (index < text.size() && isSpace(text[index]))
            ++index;
        const std::size_t begin = index;
        while (index < text.size() && !isSpace(text[index]))
            ++index;
        if (index > begin)
            fields.push_back(text.substr(begin, index - begin));
    }
    return fields;
}

bool parseBytes(std::string_view text, std::uint64_t& value)
{
    if (text.empty())
        return false;
    const char* begin = text.data();
    const char* end = begin + text.size();
    const auto parsed = std::from_chars(begin, end, value);
    return parsed.ec == std::errc{} && parsed.ptr == end;
}

}  // namespace

std::vector<InterfaceCounters> parseProcNetDev(std::string_view text)
{
    std::vector<InterfaceCounters> counters;
    std::size_t lineStart = 0;
    while (lineStart <= text.size())
    {
        const std::size_t lineEnd = text.find('\n', lineStart);
        const std::string_view line = text.substr(lineStart, lineEnd == std::string_view::npos ? std::string_view::npos : lineEnd - lineStart);
        lineStart = lineEnd == std::string_view::npos ? text.size() + 1 : lineEnd + 1;

        const std::size_t colon = line.find(':');
        if (colon == std::string_view::npos)
            continue;  // 表头行
        const std::string_view name = trim(line.substr(0, colon));
        if (name.empty())
            continue;

        const std::vector<std::string_view> fields = splitFields(line.substr(colon + 1));
        if (fields.size() <= kTransmitBytesIndex)
            continue;

        InterfaceCounters entry;
        entry.interfaceId = std::string(name);
        if (!parseBytes(fields[0], entry.rxBytes) || !parseBytes(fields[kTransmitBytesIndex], entry.txBytes))
        {
            continue;
        }

        const auto existing = std::find_if(counters.begin(), counters.end(), [&entry](const InterfaceCounters& item) { return item.interfaceId == entry.interfaceId; });
        if (existing == counters.end())
        {
            counters.push_back(std::move(entry));
        }
        else
        {
            *existing = std::move(entry);
        }
    }
    return counters;
}

std::vector<InterfaceCounters> readInterfaceCounters(const std::string& path)
{
    const std::optional<std::string> content = readTextFile(path);
    if (!content)
        return {};
    return parseProcNetDev(*content);
}

std::optional<InterfaceCounters> findInterfaceCounters(const std::vector<InterfaceCounters>& counters, std::string_view interfaceId)
{
    const auto found = std::find_if(counters.begin(), counters.end(), [interfaceId](const InterfaceCounters& item) { return item.interfaceId == interfaceId; });
    if (found == counters.end())
        return std::nullopt;
    return *found;
}

}  // namespace wifimeter::platform::linux
