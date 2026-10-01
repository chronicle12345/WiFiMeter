// 文本转换测试：Windows 的宽字符与协议使用的 UTF-8 之间必须严格往返。
//
// 用例覆盖中文、emoji（需要代理对）、落单代理项与非法 UTF-8 序列，
// 这些正是网卡描述、配置名与 SSID 里真实会出现的字符。

#include "../platform/windows/text_convert.h"

#include <cstdint>
#include <string>

#include "test_support.h"

using namespace wifimeter::platform::windows;

namespace
{

constexpr char16_t kReplacement = static_cast<char16_t>(0xFFFD);

// UTF-16 字面量的写法在 GCC 的 -fshort-wchar 与 MSVC 之间不一致，
// 因此统一用码元序列构造，避免依赖编译器对 L/u 前缀的处理。
std::u16string utf16(std::initializer_list<std::uint16_t> units)
{
    std::u16string text;
    text.reserve(units.size());
    for (const std::uint16_t unit : units)
        text.push_back(static_cast<char16_t>(unit));
    return text;
}

std::u16string ascii(const std::string& text)
{
    std::u16string result;
    result.reserve(text.size());
    for (const char character : text)
        result.push_back(static_cast<char16_t>(static_cast<unsigned char>(character)));
    return result;
}

void encodesAscii()
{
    WIFIMETER_CHECK_EQ(toUtf8(ascii("WLAN")), std::string("WLAN"));
    WIFIMETER_CHECK_EQ(fromUtf8("WLAN"), ascii("WLAN"));
}

void encodesChinese()
{
    // U+4E2D U+6587：每个码点 3 字节。
    const std::u16string text = utf16({0x4E2D, 0x6587});
    const std::string utf8 = "\xE4\xB8\xAD\xE6\x96\x87";
    WIFIMETER_CHECK_EQ(toUtf8(text), utf8);
    WIFIMETER_CHECK_EQ(fromUtf8(utf8), text);
}

void encodesSurrogatePair()
{
    // U+1F4F6（📶）：需要一对代理项，UTF-8 为 4 字节。
    const std::u16string text = utf16({0xD83D, 0xDCF6});
    const std::string utf8 = "\xF0\x9F\x93\xB6";
    WIFIMETER_CHECK_EQ(toUtf8(text), utf8);
    WIFIMETER_CHECK_EQ(fromUtf8(utf8), text);
}

void replacesLoneHighSurrogate()
{
    WIFIMETER_CHECK_EQ(toUtf8(utf16({0xD83D})), std::string("\xEF\xBF\xBD"));
}

void replacesLoneLowSurrogate()
{
    WIFIMETER_CHECK_EQ(toUtf8(utf16({0x0041, 0xDCF6, 0x0042})), std::string("A\xEF\xBF\xBD" "B"));
}

void replacesTruncatedSequence()
{
    // 三字节序列缺最后一个字节。
    WIFIMETER_CHECK_EQ(fromUtf8("\xE4\xB8"), utf16({0xFFFD}));
}

void rejectsOverlongEncoding()
{
    // 0xC0 0xAF 是 '/' 的过长编码，必须按非法处理而不是解成 '/'。
    WIFIMETER_CHECK_EQ(fromUtf8("\xC0\xAF"), utf16({0xFFFD}));
}

void rejectsEncodedSurrogate()
{
    // UTF-8 里的代理项编码（0xED 0xA0 0xBD）：0xED 与后续字节构成一个最长非法子串，
    // 整段只产生一个替换字符，而不是三个。
    WIFIMETER_CHECK_EQ(fromUtf8("\xED\xA0\xBD"), utf16({0xFFFD}));
}

void rejectsOutOfRangeCodePoint()
{
    // 0xF5 不是合法的首字节（4 字节首字节只到 0xF4），因此四个字节各是一个最长非法子串。
    WIFIMETER_CHECK_EQ(fromUtf8("\xF5\x80\x80\x80"), utf16({0xFFFD, 0xFFFD, 0xFFFD, 0xFFFD}));

    // 0xF4 0x90 0x80 0x80 编码的是 U+110000，超出 U+10FFFF：整段一个替换字符。
    WIFIMETER_CHECK_EQ(fromUtf8("\xF4\x90\x80\x80"), utf16({0xFFFD}));
}

void swallowsWholeInvalidSubstring()
{
    // 合法字符后跟一段非法序列，再跟合法字符：非法部分只占一个替换字符。
    WIFIMETER_CHECK_EQ(fromUtf8("A\xE4\xB8" "B"), utf16({0x0041, 0xFFFD, 0x0042}));
    // 0xC0 之后是合法续接字节，但整体过长；最长非法子串是这两个字节。
    WIFIMETER_CHECK_EQ(fromUtf8("\xC0\xAF" "Z"), utf16({0xFFFD, 0x005A}));
}

void keepsBytesAfterInvalidSequence()
{
    // 非法字节只影响它自己，后面的内容必须保留。
    const std::u16string converted = fromUtf8("\xFFWLAN");
    WIFIMETER_CHECK_EQ(converted.size(), std::size_t(5));
    WIFIMETER_CHECK_EQ(converted[0], kReplacement);
    WIFIMETER_CHECK_EQ(toUtf8(converted.substr(1)), std::string("WLAN"));
}

void appendUtf8ReportsConsumedBytes()
{
    std::string out;
    WIFIMETER_CHECK_EQ(appendUtf8(out, "A\xE4\xB8\xAD"), std::size_t(1));
    WIFIMETER_CHECK_EQ(out, std::string("A"));

    out.clear();
    WIFIMETER_CHECK_EQ(appendUtf8(out, "\xE4\xB8\xAD rest"), std::size_t(3));
    WIFIMETER_CHECK_EQ(out, std::string("\xE4\xB8\xAD"));

    out.clear();
    WIFIMETER_CHECK_EQ(appendUtf8(out, "\xFF"), std::size_t(1));
    WIFIMETER_CHECK_EQ(out, std::string("\xEF\xBF\xBD"));
}

void roundTripsMixedText()
{
    const std::string original = "Intel(R) Wi-Fi 6 AX201 中文 \xF0\x9F\x93\xB6";
    WIFIMETER_CHECK_EQ(toUtf8(fromUtf8(original)), original);
}

}  // namespace

// toUtf16：Windows 的宽字符 API 需要它；含中文的用户名与路径必须能正确转换。
void convertsUtf8ToWide()
{
    // "C:\Users\dev\meter.db" 共 21 个字符。
    const std::wstring ascii = toUtf16("C:\\Users\\dev\\meter.db");
    WIFIMETER_CHECK_EQ(ascii.size(), std::size_t(21));

    // 中文路径：库里要求每个字符都保留，不能按代码页降级。
    // "C:\用户\数据\meter.db"：3 个分隔符 + 4 个汉字 + 9 个 ASCII = 16 个字符，
    // 但 UTF-16 下每个汉字是 1 个码元，所以总数是 16。
    const std::wstring chinese = toUtf16("C:\\用户\\数据\\meter.db");
    WIFIMETER_CHECK_EQ(chinese.size(), std::size_t(17));

    WIFIMETER_CHECK(toUtf16("").empty());

    // emoji 在 UTF-16 里是代理对：4 字节 UTF-8 → 2 个码元。
    const std::string emojiBytes = std::string("a") + "\xF0\x9F\x93\xA1" + "b";
    const std::wstring emoji = toUtf16(emojiBytes);
    WIFIMETER_CHECK_EQ(emoji.size(), std::size_t(4));

    // 非法序列写成 U+FFFD，而不是丢弃整串。
    const std::string brokenBytes = std::string("a") + "\xFF" + "b";
    const std::wstring broken = toUtf16(brokenBytes);
    WIFIMETER_CHECK_EQ(broken.size(), std::size_t(3));
}

int main()
{
    encodesAscii();
    encodesChinese();
    encodesSurrogatePair();
    replacesLoneHighSurrogate();
    replacesLoneLowSurrogate();
    replacesTruncatedSequence();
    rejectsOverlongEncoding();
    rejectsEncodedSurrogate();
    rejectsOutOfRangeCodePoint();
    swallowsWholeInvalidSubstring();
    keepsBytesAfterInvalidSequence();
    appendUtf8ReportsConsumedBytes();
    roundTripsMixedText();
    convertsUtf8ToWide();
    return WIFIMETER_REPORT();
}
