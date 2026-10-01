#include "json.h"

#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace wifimeter::support
{
namespace
{

const JsonValue& nullValue()
{
    static const JsonValue value;
    return value;
}

void appendUtf8(std::string& out, std::uint32_t code)
{
    if (code <= 0x7F)
    {
        out.push_back(static_cast<char>(code));
    }
    else if (code <= 0x7FF)
    {
        out.push_back(static_cast<char>(0xC0 | (code >> 6)));
        out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    }
    else if (code <= 0xFFFF)
    {
        out.push_back(static_cast<char>(0xE0 | (code >> 12)));
        out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    }
    else
    {
        out.push_back(static_cast<char>(0xF0 | (code >> 18)));
        out.push_back(static_cast<char>(0x80 | ((code >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    }
}

void escapeInto(std::string& out, std::string_view text)
{
    out.push_back('"');
    for (const char character : text)
    {
        const unsigned char byte = static_cast<unsigned char>(character);
        switch (character)
        {
            case '"':
                out += "\\\"";
                continue;
            case '\\':
                out += "\\\\";
                continue;
            case '\n':
                out += "\\n";
                continue;
            case '\r':
                out += "\\r";
                continue;
            case '\t':
                out += "\\t";
                continue;
            case '\b':
                out += "\\b";
                continue;
            case '\f':
                out += "\\f";
                continue;
            default:
                break;
        }
        if (byte < 0x20)
        {
            char buffer[8] = {};
            std::snprintf(buffer, sizeof(buffer), "\\u%04x", byte);
            out += buffer;
            continue;
        }
        // UTF-8 原样输出：JSON 允许直接包含多字节字符，界面也按 UTF-8 读取。
        out.push_back(character);
    }
    out.push_back('"');
}

// 递归下降解析器。所有失败都带上位置，便于定位协议问题。
class Parser
{
public:
    Parser(std::string_view text)
        : text_(text)
    {}

    bool parse(JsonValue& value, std::string& error)
    {
        skipWhitespace();
        if (!parseValue(value, 0))
        {
            error = error_;
            return false;
        }
        skipWhitespace();
        if (index_ != text_.size())
        {
            error = at("JSON 结尾有多余内容");
            return false;
        }
        return true;
    }

private:
    std::string at(const std::string& message) const
    {
        return "位置 " + std::to_string(index_) + "：" + message;
    }

    bool fail(const std::string& message)
    {
        if (error_.empty())
            error_ = at(message);
        return false;
    }

    void skipWhitespace()
    {
        while (index_ < text_.size())
        {
            const char character = text_[index_];
            if (character == ' ' || character == '\t' || character == '\n' || character == '\r')
            {
                ++index_;
                continue;
            }
            break;
        }
    }

    bool literal(std::string_view expected)
    {
        if (text_.compare(index_, expected.size(), expected) != 0)
            return false;
        index_ += expected.size();
        return true;
    }

    bool parseValue(JsonValue& value, int depth)
    {
        if (depth > kJsonDepthLimit)
            return fail("嵌套层级超出上限");
        if (index_ >= text_.size())
            return fail("内容意外结束");

        switch (text_[index_])
        {
            case 'n':
                if (!literal("null"))
                    return fail("无效的字面量");
                value = JsonValue::makeNull();
                return true;
            case 't':
                if (!literal("true"))
                    return fail("无效的字面量");
                value = JsonValue::makeBool(true);
                return true;
            case 'f':
                if (!literal("false"))
                    return fail("无效的字面量");
                value = JsonValue::makeBool(false);
                return true;
            case '"':
            {
                std::string text;
                if (!parseString(text))
                    return false;
                value = JsonValue::makeString(std::move(text));
                return true;
            }
            case '[':
                return parseArray(value, depth);
            case '{':
                return parseObject(value, depth);
            default:
                return parseNumber(value);
        }
    }

    bool parseString(std::string& out)
    {
        if (text_[index_] != '"')
            return fail("字符串缺少引号");
        ++index_;
        out.clear();
        while (index_ < text_.size())
        {
            const char character = text_[index_++];
            if (character == '"')
                return true;
            if (character != '\\')
            {
                if (static_cast<unsigned char>(character) < 0x20)
                    return fail("字符串中出现未转义的控制字符");
                out.push_back(character);
                continue;
            }
            if (index_ >= text_.size())
                return fail("转义序列不完整");
            const char escaped = text_[index_++];
            switch (escaped)
            {
                case '"':
                    out.push_back('"');
                    break;
                case '\\':
                    out.push_back('\\');
                    break;
                case '/':
                    out.push_back('/');
                    break;
                case 'b':
                    out.push_back('\b');
                    break;
                case 'f':
                    out.push_back('\f');
                    break;
                case 'n':
                    out.push_back('\n');
                    break;
                case 'r':
                    out.push_back('\r');
                    break;
                case 't':
                    out.push_back('\t');
                    break;
                case 'u':
                {
                    std::uint32_t code = 0;
                    if (!parseHex4(code))
                        return false;
                    // 代理对：高位后面必须跟一个低位代理。
                    if (code >= 0xD800 && code <= 0xDBFF)
                    {
                        if (index_ + 1 >= text_.size() || text_[index_] != '\\' || text_[index_ + 1] != 'u')
                            return fail("缺少低位代理");
                        index_ += 2;
                        std::uint32_t low = 0;
                        if (!parseHex4(low))
                            return false;
                        if (low < 0xDC00 || low > 0xDFFF)
                            return fail("低位代理无效");
                        code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                    }
                    else if (code >= 0xDC00 && code <= 0xDFFF)
                    {
                        return fail("孤立的低位代理");
                    }
                    appendUtf8(out, code);
                    break;
                }
                default:
                    return fail("未知的转义字符");
            }
        }
        return fail("字符串没有结束引号");
    }

    bool parseHex4(std::uint32_t& code)
    {
        if (index_ + 4 > text_.size())
            return fail("\\u 转义不完整");
        code = 0;
        for (int i = 0; i < 4; ++i)
        {
            const char character = text_[index_++];
            code <<= 4;
            if (character >= '0' && character <= '9')
                code |= static_cast<std::uint32_t>(character - '0');
            else if (character >= 'a' && character <= 'f')
                code |= static_cast<std::uint32_t>(character - 'a' + 10);
            else if (character >= 'A' && character <= 'F')
                code |= static_cast<std::uint32_t>(character - 'A' + 10);
            else
                return fail("\\u 转义含非十六进制字符");
        }
        return true;
    }

    bool parseArray(JsonValue& value, int depth)
    {
        ++index_;  // '['
        value = JsonValue::makeArray();
        skipWhitespace();
        if (index_ < text_.size() && text_[index_] == ']')
        {
            ++index_;
            return true;
        }
        while (true)
        {
            JsonValue item;
            skipWhitespace();
            if (!parseValue(item, depth + 1))
                return false;
            value.push(std::move(item));
            skipWhitespace();
            if (index_ >= text_.size())
                return fail("数组没有结束括号");
            if (text_[index_] == ',')
            {
                ++index_;
                continue;
            }
            if (text_[index_] == ']')
            {
                ++index_;
                return true;
            }
            return fail("数组中缺少逗号或结束括号");
        }
    }

    bool parseObject(JsonValue& value, int depth)
    {
        ++index_;  // '{'
        value = JsonValue::makeObject();
        skipWhitespace();
        if (index_ < text_.size() && text_[index_] == '}')
        {
            ++index_;
            return true;
        }
        while (true)
        {
            skipWhitespace();
            if (index_ >= text_.size() || text_[index_] != '"')
                return fail("对象的键必须是字符串");
            std::string key;
            if (!parseString(key))
                return false;
            skipWhitespace();
            if (index_ >= text_.size() || text_[index_] != ':')
                return fail("对象的键后面缺少冒号");
            ++index_;
            skipWhitespace();
            JsonValue item;
            if (!parseValue(item, depth + 1))
                return false;
            value.set(std::move(key), std::move(item));
            skipWhitespace();
            if (index_ >= text_.size())
                return fail("对象没有结束括号");
            if (text_[index_] == ',')
            {
                ++index_;
                continue;
            }
            if (text_[index_] == '}')
            {
                ++index_;
                return true;
            }
            return fail("对象中缺少逗号或结束括号");
        }
    }

    bool parseNumber(JsonValue& value)
    {
        const std::size_t begin = index_;
        if (index_ < text_.size() && text_[index_] == '-')
            ++index_;  // JSON 只允许负号，不接受 '+'

        // 整数部分：单独的 0，或 [1-9][0-9]*；不接受前导零。
        bool digits = false;
        if (index_ < text_.size() && text_[index_] == '0')
        {
            ++index_;
            digits = true;
            if (index_ < text_.size() && text_[index_] >= '0' && text_[index_] <= '9')
                return fail("数字不接受前导零");
        }
        else
        {
            while (index_ < text_.size() && text_[index_] >= '0' && text_[index_] <= '9')
            {
                ++index_;
                digits = true;
            }
        }

        bool integral = true;
        if (index_ < text_.size() && text_[index_] == '.')
        {
            integral = false;
            ++index_;
            const std::size_t fractionBegin = index_;
            while (index_ < text_.size() && text_[index_] >= '0' && text_[index_] <= '9')
                ++index_;
            if (index_ == fractionBegin)
                return fail("小数点后缺少数字");
        }
        if (index_ < text_.size() && (text_[index_] == 'e' || text_[index_] == 'E'))
        {
            integral = false;
            ++index_;
            if (index_ < text_.size() && (text_[index_] == '-' || text_[index_] == '+'))
                ++index_;
            const std::size_t exponentBegin = index_;
            while (index_ < text_.size() && text_[index_] >= '0' && text_[index_] <= '9')
                ++index_;
            if (index_ == exponentBegin)
                return fail("指数部分缺少数字");
        }
        if (!digits)
            return fail("不是有效的 JSON 取值");

        const std::string token(text_.substr(begin, index_ - begin));
        if (integral)
        {
            errno = 0;
            char* end = nullptr;
            const long long parsed = std::strtoll(token.c_str(), &end, 10);
            // 超出 64 位整数范围时退回浮点，避免静默回绕。
            if (errno == 0 && end != nullptr && *end == '\0')
            {
                value = JsonValue::makeInt(static_cast<std::int64_t>(parsed));
                return true;
            }
        }
        value = JsonValue::makeNumber(std::strtod(token.c_str(), nullptr));
        return true;
    }

    std::string_view text_;
    std::size_t index_ = 0;
    std::string error_;
};

}  // namespace

JsonValue JsonValue::makeNull()
{
    return JsonValue{};
}

JsonValue JsonValue::makeBool(bool value)
{
    JsonValue result;
    result.type_ = Type::boolean;
    result.boolean_ = value;
    return result;
}

JsonValue JsonValue::makeNumber(double value)
{
    JsonValue result;
    result.type_ = Type::number;
    result.number_ = value;
    return result;
}

JsonValue JsonValue::makeInt(std::int64_t value)
{
    JsonValue result;
    result.type_ = Type::number;
    result.integer_ = true;
    result.integerValue_ = value;
    result.number_ = static_cast<double>(value);
    return result;
}

JsonValue JsonValue::makeString(std::string value)
{
    JsonValue result;
    result.type_ = Type::string;
    result.string_ = std::move(value);
    return result;
}

JsonValue JsonValue::makeArray()
{
    JsonValue result;
    result.type_ = Type::array;
    return result;
}

JsonValue JsonValue::makeObject()
{
    JsonValue result;
    result.type_ = Type::object;
    return result;
}

bool JsonValue::asBool(bool fallback) const
{
    return type_ == Type::boolean ? boolean_ : fallback;
}

double JsonValue::asDouble(double fallback) const
{
    if (type_ != Type::number)
        return fallback;
    return integer_ ? static_cast<double>(integerValue_) : number_;
}

std::int64_t JsonValue::asInt64(std::int64_t fallback) const
{
    if (type_ != Type::number)
        return fallback;
    if (integer_)
        return integerValue_;
    return static_cast<std::int64_t>(number_);
}

std::string JsonValue::asString(std::string fallback) const
{
    return type_ == Type::string ? string_ : std::move(fallback);
}

void JsonValue::push(JsonValue value)
{
    if (type_ != Type::array)
        return;
    items_.push_back(std::move(value));
}

std::size_t JsonValue::size() const
{
    if (type_ == Type::array)
        return items_.size();
    if (type_ == Type::object)
        return fields_.size();
    return 0;
}

const JsonValue& JsonValue::at(std::size_t index) const
{
    if (type_ != Type::array || index >= items_.size())
        return nullValue();
    return items_[index];
}

void JsonValue::set(std::string key, JsonValue value)
{
    if (type_ != Type::object)
        return;
    for (auto& field : fields_)
    {
        if (field.first == key)
        {
            field.second = std::move(value);
            return;
        }
    }
    fields_.emplace_back(std::move(key), std::move(value));
}

bool JsonValue::has(std::string_view key) const
{
    return find(key) != nullptr;
}

const JsonValue* JsonValue::find(std::string_view key) const
{
    if (type_ != Type::object)
        return nullptr;
    for (const auto& field : fields_)
    {
        if (field.first == key)
            return &field.second;
    }
    return nullptr;
}

std::string JsonValue::stringOr(std::string_view key, std::string fallback) const
{
    const JsonValue* value = find(key);
    if (value == nullptr || !value->isString())
        return fallback;
    return value->asString();
}

bool JsonValue::boolOr(std::string_view key, bool fallback) const
{
    const JsonValue* value = find(key);
    if (value == nullptr || !value->isBool())
        return fallback;
    return value->asBool();
}

std::int64_t JsonValue::intOr(std::string_view key, std::int64_t fallback) const
{
    const JsonValue* value = find(key);
    if (value == nullptr || !value->isNumber())
        return fallback;
    return value->asInt64();
}

double JsonValue::doubleOr(std::string_view key, double fallback) const
{
    const JsonValue* value = find(key);
    if (value == nullptr || !value->isNumber())
        return fallback;
    return value->asDouble();
}

void JsonValue::dumpTo(std::string& out, int indent, int depth) const
{
    const bool pretty = indent > 0;
    const std::string pad = pretty ? std::string(static_cast<std::size_t>(indent * (depth + 1)), ' ') : std::string();
    const std::string padEnd = pretty ? std::string(static_cast<std::size_t>(indent * depth), ' ') : std::string();

    switch (type_)
    {
        case Type::null:
            out += "null";
            return;
        case Type::boolean:
            out += boolean_ ? "true" : "false";
            return;
        case Type::number:
        {
            char buffer[32] = {};
            if (integer_)
            {
                std::snprintf(buffer, sizeof(buffer), "%lld", static_cast<long long>(integerValue_));
            }
            else if (std::isfinite(number_))
            {
                // %.17g 保证往返不丢精度；整数形式的浮点去掉多余的 .0。
                std::snprintf(buffer, sizeof(buffer), "%.17g", number_);
            }
            else
            {
                out += "null";  // NaN 与 Infinity 不是合法 JSON
                return;
            }
            out += buffer;
            return;
        }
        case Type::string:
            escapeInto(out, string_);
            return;
        case Type::array:
            break;
        case Type::object:
            break;
    }

    if (type_ == Type::array)
    {
        if (items_.empty())
        {
            out += "[]";
            return;
        }
        out.push_back('[');
        for (std::size_t index = 0; index < items_.size(); ++index)
        {
            if (index > 0)
                out.push_back(',');
            if (pretty)
            {
                out.push_back('\n');
                out += pad;
            }
            items_[index].dumpTo(out, indent, depth + 1);
        }
        if (pretty)
        {
            out.push_back('\n');
            out += padEnd;
        }
        out.push_back(']');
        return;
    }

    if (fields_.empty())
    {
        out += "{}";
        return;
    }
    out.push_back('{');
    for (std::size_t index = 0; index < fields_.size(); ++index)
    {
        if (index > 0)
            out.push_back(',');
        if (pretty)
        {
            out.push_back('\n');
            out += pad;
        }
        escapeInto(out, fields_[index].first);
        out.push_back(':');
        if (pretty)
            out.push_back(' ');
        fields_[index].second.dumpTo(out, indent, depth + 1);
    }
    if (pretty)
    {
        out.push_back('\n');
        out += padEnd;
    }
    out.push_back('}');
}

std::string JsonValue::dump() const
{
    std::string out;
    dumpTo(out, 0, 0);
    return out;
}

std::string JsonValue::dump(int indent) const
{
    std::string out;
    dumpTo(out, indent, 0);
    return out;
}

std::optional<JsonValue> JsonValue::parse(std::string_view text, std::string& error)
{
    JsonValue value;
    Parser parser(text);
    if (!parser.parse(value, error))
        return std::nullopt;
    error.clear();
    return value;
}

}  // namespace wifimeter::support
