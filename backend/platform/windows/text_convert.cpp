#include "text_convert.h"

#include <cstddef>

namespace wifimeter::platform::windows
{
namespace
{

constexpr char32_t kReplacement = 0xFFFD;
constexpr char32_t kMaxCodePoint = 0x10FFFF;

// 把码点写成 UTF-8。码点必须已经确认有效。
void appendCodePoint(std::string& out, char32_t codePoint)
{
    if (codePoint <= 0x7F)
    {
        out.push_back(static_cast<char>(codePoint));
        return;
    }
    if (codePoint <= 0x7FF)
    {
        out.push_back(static_cast<char>(0xC0 | (codePoint >> 6)));
        out.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
        return;
    }
    if (codePoint <= 0xFFFF)
    {
        out.push_back(static_cast<char>(0xE0 | (codePoint >> 12)));
        out.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
        return;
    }
    out.push_back(static_cast<char>(0xF0 | (codePoint >> 18)));
    out.push_back(static_cast<char>(0x80 | ((codePoint >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
}

bool continuation(char value)
{
    return (static_cast<unsigned char>(value) & 0xC0) == 0x80;
}

// 解码一个 UTF-8 序列，返回消耗的字节数；非法时给出替换字符。
//
// 非法序列整段吞掉（“最长非法子串”），而不是只跳过一个字节：否则一个坏字节会变成
// 一串替换字符，用户看到的是乱码的长度而不是“这里有一个无法识别的字符”。
std::size_t decodeUtf8(std::string_view text, char32_t& codePoint)
{
    if (text.empty())
    {
        codePoint = kReplacement;
        return 1;
    }

    const unsigned char lead = static_cast<unsigned char>(text[0]);
    std::size_t length = 1;
    char32_t value = 0;
    char32_t minimum = 0;
    if (lead < 0x80)
    {
        codePoint = lead;
        return 1;
    }
    if ((lead & 0xE0) == 0xC0)
    {
        length = 2;
        value = lead & 0x1F;
        minimum = 0x80;
    }
    else if ((lead & 0xF0) == 0xE0)
    {
        length = 3;
        value = lead & 0x0F;
        minimum = 0x800;
    }
    else if ((lead & 0xF8) == 0xF0 && lead <= 0xF4)
    {
        length = 4;
        value = lead & 0x07;
        minimum = 0x10000;
    }
    else
    {
        // 0x80..0xBF 的落单续接字节，或 0xF5 以上的非法首字节。
        codePoint = kReplacement;
        return 1;
    }

    std::size_t consumed = 1;
    for (; consumed < length && consumed < text.size() && continuation(text[consumed]); ++consumed)
        value = (value << 6) | (static_cast<unsigned char>(text[consumed]) & 0x3F);

    // 过长编码（overlong）、代理项区间与超出 U+10FFFF 的值都不是合法码点。
    const bool surrogate = value >= 0xD800 && value <= 0xDFFF;
    if (consumed < length || value < minimum || surrogate || value > kMaxCodePoint)
    {
        codePoint = kReplacement;
        return consumed;
    }
    codePoint = value;
    return consumed;
}

}  // namespace

std::size_t appendUtf8(std::string& out, std::string_view text)
{
    char32_t codePoint = 0;
    const std::size_t consumed = decodeUtf8(text, codePoint);
    appendCodePoint(out, codePoint);
    return consumed;
}

std::string toUtf8(std::u16string_view text)
{
    std::string out;
    out.reserve(text.size());
    for (std::size_t index = 0; index < text.size(); ++index)
    {
        const char16_t unit = text[index];
        if (unit >= 0xD800 && unit <= 0xDBFF)
        {
            // 高代理项必须紧跟低代理项，否则是落单的半个字符。
            if (index + 1 < text.size() && text[index + 1] >= 0xDC00 && text[index + 1] <= 0xDFFF)
            {
                const char32_t codePoint = 0x10000 + ((static_cast<char32_t>(unit) - 0xD800) << 10) + (static_cast<char32_t>(text[index + 1]) - 0xDC00);
                appendCodePoint(out, codePoint);
                ++index;
                continue;
            }
            appendCodePoint(out, kReplacement);
            continue;
        }
        if (unit >= 0xDC00 && unit <= 0xDFFF)
        {
            appendCodePoint(out, kReplacement);
            continue;
        }
        appendCodePoint(out, unit);
    }
    return out;
}

std::u16string fromUtf8(std::string_view text)
{
    std::u16string out;
    out.reserve(text.size());
    std::size_t index = 0;
    while (index < text.size())
    {
        char32_t codePoint = 0;
        index += decodeUtf8(text.substr(index), codePoint);

        if (codePoint <= 0xFFFF)
        {
            out.push_back(static_cast<char16_t>(codePoint));
            continue;
        }
        const char32_t rest = codePoint - 0x10000;
        out.push_back(static_cast<char16_t>(0xD800 + (rest >> 10)));
        out.push_back(static_cast<char16_t>(0xDC00 + (rest & 0x3FF)));
    }
    return out;
}

}  // namespace wifimeter::platform::windows
