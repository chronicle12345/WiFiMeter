#pragma once

// Windows 平台用例共用的构造工具。
//
// 关键点：原始系统结果按 UTF-16 码元承载（见 platform/windows/interface_counters.h），
// 而 wchar_t 在 Windows 上是 16 位、在 Linux 上是 32 位。因此测试不构造 std::wstring，
// 而是先把 UTF-8 字面量解码成码点再写成 UTF-16 码元，两个平台上的结果完全一致。

#include <cstdint>
#include <initializer_list>
#include <string>
#include <string_view>

namespace wifimeter::test
{
namespace windows_support
{

// 按 UTF-8 解码后写成 UTF-16：超过 U+FFFF 的码点写成代理对，与 Windows 的报告一致。
inline std::u16string utf16(std::string_view utf8)
{
    std::u16string out;
    std::size_t index = 0;
    while (index < utf8.size())
    {
        const unsigned char lead = static_cast<unsigned char>(utf8[index]);
        std::size_t length = 1;
        char32_t codePoint = lead;
        if ((lead & 0xE0) == 0xC0)
        {
            length = 2;
            codePoint = lead & 0x1F;
        }
        else if ((lead & 0xF0) == 0xE0)
        {
            length = 3;
            codePoint = lead & 0x0F;
        }
        else if ((lead & 0xF8) == 0xF0)
        {
            length = 4;
            codePoint = lead & 0x07;
        }
        if (index + length > utf8.size())
        {
            length = 1;
            codePoint = 0xFFFD;
        }
        for (std::size_t offset = 1; offset < length; ++offset)
            codePoint = (codePoint << 6) | (static_cast<unsigned char>(utf8[index + offset]) & 0x3F);
        index += length;

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

// 按 UTF-16 码元序列构造：用于验证代理对与落单代理项这类边界。
inline std::u16string utf16Units(std::initializer_list<std::uint16_t> units)
{
    std::u16string out;
    out.reserve(units.size());
    for (const std::uint16_t unit : units)
        out.push_back(static_cast<char16_t>(unit));
    return out;
}

}  // namespace windows_support
}  // namespace wifimeter::test
