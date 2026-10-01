#pragma once

// 最小 JSON 实现：协议与备份文件都用 JSON，而系统里没有任何 JSON 库可用。
//
// 为什么不 vendor 一个单头文件库：这个仓库的依赖一直只有系统库，而这里需要的只是
// 一个值类型、解析与序列化；自己实现能把数字与字符串的边界行为控制住，并单独测透。
//
// 约定：
//   * 字节数一律用十进制字符串表示（见 byte_count.h），不走 JSON 数字——JS 的 Number
//     只有 53 位精度，直接传数字会悄悄丢精度。
//   * 对象保持插入顺序，输出稳定，便于比对与人工查看。
//   * 解析有嵌套深度上限，遇到畸形输入返回错误而不是崩溃。

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace wifimeter::support
{

class JsonValue
{
public:
    enum class Type
    {
        null,
        boolean,
        number,
        string,
        array,
        object,
    };

    JsonValue() = default;

    static JsonValue makeNull();
    static JsonValue makeBool(bool value);
    static JsonValue makeNumber(double value);
    static JsonValue makeInt(std::int64_t value);
    static JsonValue makeString(std::string value);
    static JsonValue makeArray();
    static JsonValue makeObject();

    Type type() const
    {
        return type_;
    }
    bool isNull() const
    {
        return type_ == Type::null;
    }
    bool isBool() const
    {
        return type_ == Type::boolean;
    }
    bool isNumber() const
    {
        return type_ == Type::number;
    }
    bool isString() const
    {
        return type_ == Type::string;
    }
    bool isArray() const
    {
        return type_ == Type::array;
    }
    bool isObject() const
    {
        return type_ == Type::object;
    }

    bool asBool(bool fallback = false) const;
    double asDouble(double fallback = 0.0) const;
    std::int64_t asInt64(std::int64_t fallback = 0) const;
    // 只在 isString 时返回内容，否则返回空串。
    std::string asString(std::string fallback = {}) const;

    // 数组操作；不是数组时 push 无效、size 为 0。
    void push(JsonValue value);
    std::size_t size() const;
    const JsonValue& at(std::size_t index) const;

    // 对象操作；不是对象时 set 无效。
    void set(std::string key, JsonValue value);
    bool has(std::string_view key) const;
    // 取字段；不存在时返回空值指针，调用方自行决定默认值。
    const JsonValue* find(std::string_view key) const;
    // 便捷取值：字段不存在或类型不符时返回给定的默认值。
    std::string stringOr(std::string_view key, std::string fallback = {}) const;
    bool boolOr(std::string_view key, bool fallback = false) const;
    std::int64_t intOr(std::string_view key, std::int64_t fallback = 0) const;
    double doubleOr(std::string_view key, double fallback = 0.0) const;
    const std::vector<std::pair<std::string, JsonValue>>& fields() const
    {
        return fields_;
    }
    const std::vector<JsonValue>& items() const
    {
        return items_;
    }

    // 紧凑输出，用于按行传输的协议。
    std::string dump() const;
    // 缩进输出，用于备份文件。
    std::string dump(int indent) const;

    // 解析 JSON 文本；失败时 error 说明位置与原因。
    static std::optional<JsonValue> parse(std::string_view text, std::string& error);

private:
    void dumpTo(std::string& out, int indent, int depth) const;

    Type type_ = Type::null;
    bool boolean_ = false;
    bool integer_ = false;  // 数字是否为整数，决定输出时是否带小数点
    double number_ = 0.0;
    std::int64_t integerValue_ = 0;
    std::string string_;
    std::vector<JsonValue> items_;
    std::vector<std::pair<std::string, JsonValue>> fields_;
};

// 当前协议与备份文件使用的 JSON 结构版本。
inline constexpr int kJsonDepthLimit = 64;

}  // namespace wifimeter::support
