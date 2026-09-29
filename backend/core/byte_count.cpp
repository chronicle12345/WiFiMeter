#include "byte_count.h"

#include <charconv>

namespace wifimeter::core
{

std::string decimalString(ByteCount value)
{
    return std::to_string(value);
}

bool parseDecimal(std::string_view text, ByteCount& value)
{
    if (text.empty() || text.size() > 20)
        return false;
    // 快照格式不允许前导零，只有 "0" 本身以 0 开头。
    if (text.size() > 1 && text.front() == '0')
        return false;
    for (const char character : text)
    {
        if (character < '0' || character > '9')
            return false;
    }

    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), value);
    return parsed.ec == std::errc{} && parsed.ptr == text.data() + text.size();
}

}  // namespace wifimeter::core
