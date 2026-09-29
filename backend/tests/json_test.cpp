// JSON 解析与序列化测试。协议与备份文件都依赖它，因此覆盖转义、代理对、数字边界与畸形输入。

#include "../support/json.h"

#include <string>

#include "test_support.h"

using wifimeter::support::JsonValue;

namespace
{

std::string roundTrip(const JsonValue& value)
{
    return value.dump();
}

void buildsAndDumpsValues()
{
    WIFIMETER_CHECK_EQ(JsonValue::makeNull().dump(), std::string("null"));
    WIFIMETER_CHECK_EQ(JsonValue::makeBool(true).dump(), std::string("true"));
    WIFIMETER_CHECK_EQ(JsonValue::makeBool(false).dump(), std::string("false"));
    WIFIMETER_CHECK_EQ(JsonValue::makeInt(42).dump(), std::string("42"));
    WIFIMETER_CHECK_EQ(JsonValue::makeInt(-7).dump(), std::string("-7"));
    WIFIMETER_CHECK_EQ(JsonValue::makeString("hi").dump(), std::string("\"hi\""));
    WIFIMETER_CHECK_EQ(JsonValue::makeArray().dump(), std::string("[]"));
    WIFIMETER_CHECK_EQ(JsonValue::makeObject().dump(), std::string("{}"));
}

void escapesControlCharactersAndQuotes()
{
    WIFIMETER_CHECK_EQ(JsonValue::makeString("a\"b").dump(), std::string("\"a\\\"b\""));
    WIFIMETER_CHECK_EQ(JsonValue::makeString("a\\b").dump(), std::string("\"a\\\\b\""));
    WIFIMETER_CHECK_EQ(JsonValue::makeString("line\nbreak").dump(), std::string("\"line\\nbreak\""));
    WIFIMETER_CHECK_EQ(JsonValue::makeString("tab\there").dump(), std::string("\"tab\\there\""));
    WIFIMETER_CHECK_EQ(JsonValue::makeString("\x01").dump(), std::string("\"\\u0001\""));
    // 中文与表情是多字节 UTF-8，原样输出而不是转义。
    WIFIMETER_CHECK_EQ(JsonValue::makeString("家里的 Wi-Fi").dump(), std::string("\"家里的 Wi-Fi\""));
    WIFIMETER_CHECK_EQ(JsonValue::makeString("🛜").dump(), std::string("\"🛜\""));
}

void keepsByteCountsAsStrings()
{
    // 字节数超过 JS 的 53 位精度，必须走字符串：这里验证往返后一位不差。
    const std::string huge = "18446744073709551615";
    JsonValue object = JsonValue::makeObject();
    object.set("rxBytes", JsonValue::makeString(huge));
    const std::string text = object.dump();

    std::string error;
    const auto parsed = JsonValue::parse(text, error);
    WIFIMETER_CHECK(parsed.has_value());
    if (parsed)
        WIFIMETER_CHECK_EQ(parsed->stringOr("rxBytes"), huge);
}

void keepsLargeIntegersExact()
{
    // 2^53 + 1 用 double 表示会变成 2^53，整数必须按整数处理。
    const std::string text = "{\"n\":9007199254740993}";
    std::string error;
    const auto parsed = JsonValue::parse(text, error);
    WIFIMETER_CHECK(parsed.has_value());
    if (parsed)
    {
        WIFIMETER_CHECK_EQ(parsed->intOr("n"), std::int64_t{9007199254740993});
        WIFIMETER_CHECK_EQ(parsed->dump(), text);
    }
}

void parsesNestedDocuments()
{
    const std::string text = R"({"a":[1,2,{"b":"c"}],"d":{"e":true,"f":null},"g":-1.5e2})";
    std::string error;
    const auto parsed = JsonValue::parse(text, error);
    WIFIMETER_CHECK(parsed.has_value());
    if (!parsed)
    {
        wifimeter::test::fail(__FILE__, __LINE__, error);
        return;
    }
    WIFIMETER_CHECK(parsed->isObject());
    WIFIMETER_CHECK_EQ(parsed->size(), std::size_t{3});

    const JsonValue* array = parsed->find("a");
    WIFIMETER_CHECK(array != nullptr);
    if (array != nullptr)
    {
        WIFIMETER_CHECK(array->isArray());
        WIFIMETER_CHECK_EQ(array->size(), std::size_t{3});
        WIFIMETER_CHECK_EQ(array->at(0).asInt64(), std::int64_t{1});
        WIFIMETER_CHECK_EQ(array->at(2).stringOr("b"), std::string("c"));
    }

    const JsonValue* nested = parsed->find("d");
    WIFIMETER_CHECK(nested != nullptr);
    if (nested != nullptr)
    {
        WIFIMETER_CHECK(nested->boolOr("e"));
        WIFIMETER_CHECK(nested->find("f") != nullptr && nested->find("f")->isNull());
    }
    WIFIMETER_CHECK_EQ(parsed->doubleOr("g"), -150.0);
}

void parsesUnicodeEscapes()
{
    std::string error;
    const auto basic = JsonValue::parse(R"("\u4e2d\u6587")", error);
    WIFIMETER_CHECK(basic.has_value());
    if (basic)
        WIFIMETER_CHECK_EQ(basic->asString(), std::string("中文"));

    // 代理对合成一个补充平面字符。
    const auto pair = JsonValue::parse(R"("\ud83d\udce1")", error);
    WIFIMETER_CHECK(pair.has_value());
    if (pair)
        WIFIMETER_CHECK_EQ(pair->asString(), std::string("📡"));

    const auto escaped = JsonValue::parse(R"("a\/b\\c\"d\b\f\n\r\t")", error);
    WIFIMETER_CHECK(escaped.has_value());
    if (escaped)
        WIFIMETER_CHECK_EQ(escaped->asString(), std::string("a/b\\c\"d\b\f\n\r\t"));
}

void rejectsMalformedDocuments()
{
    const char* invalid[] = {
        "",
        "   ",
        "{",
        "[1,2",
        "{\"a\":}",
        "{\"a\" 1}",
        "{\"a\":1,}",
        "[1,]",
        "tru",
        "nul",
        "{'a':1}",
        "{\"a\":01}",
        "01",
        "+1",
        "1.",
        "1e",
        ".5",
        "-",
        "1 2",
        "\"unterminated",
        "\"bad\\xescape\"",
        "\"\\u12\"",
        "\"\\ud83d\"",       // 缺少低位代理
        "\"\\udce1\"",       // 孤立低位代理
        "\"raw\ncontrol\"",  // 字符串中的裸控制字符
        "[1,2]]",
    };
    for (const char* text : invalid)
    {
        std::string error;
        const auto parsed = JsonValue::parse(text, error);
        WIFIMETER_CHECK(!parsed.has_value());
        WIFIMETER_CHECK(!error.empty());
    }
}

void enforcesTheDepthLimit()
{
    std::string deep;
    for (int i = 0; i < 200; ++i)
        deep += "[";
    std::string error;
    WIFIMETER_CHECK(!JsonValue::parse(deep, error).has_value());
    WIFIMETER_CHECK(error.find("嵌套") != std::string::npos);

    // 正常深度仍然可以解析。
    std::string normal = R"({"a":{"b":{"c":[1,2,3]}}})";
    WIFIMETER_CHECK(JsonValue::parse(normal, error).has_value());
}

void returnsFallbacksForWrongTypes()
{
    std::string error;
    const auto parsed = JsonValue::parse(R"({"s":"text","n":5,"b":true,"a":[1]})", error);
    WIFIMETER_CHECK(parsed.has_value());
    if (!parsed)
        return;

    WIFIMETER_CHECK_EQ(parsed->stringOr("s"), std::string("text"));
    WIFIMETER_CHECK_EQ(parsed->stringOr("missing", "fallback"), std::string("fallback"));
    WIFIMETER_CHECK_EQ(parsed->stringOr("n", "fallback"), std::string("fallback"));  // 类型不符
    WIFIMETER_CHECK_EQ(parsed->intOr("n"), std::int64_t{5});
    WIFIMETER_CHECK_EQ(parsed->intOr("s", -1), std::int64_t{-1});
    WIFIMETER_CHECK(parsed->boolOr("b"));
    WIFIMETER_CHECK(!parsed->boolOr("missing"));
    WIFIMETER_CHECK_EQ(parsed->doubleOr("n"), 5.0);
    WIFIMETER_CHECK_EQ(parsed->at(0).asInt64(-1), std::int64_t{-1});  // 不是数组
    WIFIMETER_CHECK(parsed->find("nope") == nullptr);
}

void mutatesObjectsAndArrays()
{
    JsonValue object = JsonValue::makeObject();
    object.set("a", JsonValue::makeInt(1));
    object.set("b", JsonValue::makeInt(2));
    object.set("a", JsonValue::makeInt(3));  // 同键覆盖而不是追加
    WIFIMETER_CHECK_EQ(object.dump(), std::string(R"({"a":3,"b":2})"));
    WIFIMETER_CHECK(object.has("a"));
    WIFIMETER_CHECK_EQ(object.size(), std::size_t{2});

    JsonValue array = JsonValue::makeArray();
    array.push(JsonValue::makeString("x"));
    array.push(JsonValue::makeBool(false));
    WIFIMETER_CHECK_EQ(array.dump(), std::string(R"(["x",false])"));

    // 类型不符时修改无效，而不是崩溃或改变类型。
    JsonValue scalar = JsonValue::makeInt(1);
    scalar.set("k", JsonValue::makeInt(2));
    scalar.push(JsonValue::makeInt(3));
    WIFIMETER_CHECK_EQ(scalar.dump(), std::string("1"));
    WIFIMETER_CHECK_EQ(scalar.size(), std::size_t{0});
}

void writesPrettyOutput()
{
    JsonValue object = JsonValue::makeObject();
    JsonValue array = JsonValue::makeArray();
    array.push(JsonValue::makeInt(1));
    object.set("items", std::move(array));
    object.set("name", JsonValue::makeString("备份"));

    const std::string pretty = object.dump(2);
    WIFIMETER_CHECK(pretty.find('\n') != std::string::npos);
    WIFIMETER_CHECK(pretty.find("  \"items\"") != std::string::npos);

    // 美化输出必须还能被自己解析回来。
    std::string error;
    const auto parsed = JsonValue::parse(pretty, error);
    WIFIMETER_CHECK(parsed.has_value());
    if (parsed)
        WIFIMETER_CHECK_EQ(parsed->dump(), object.dump());
}

void roundTripsThroughText()
{
    JsonValue root = JsonValue::makeObject();
    root.set("version", JsonValue::makeInt(1));
    root.set("source", JsonValue::makeString("backend"));
    JsonValue rows = JsonValue::makeArray();
    for (int i = 0; i < 3; ++i)
    {
        JsonValue row = JsonValue::makeObject();
        row.set("date", JsonValue::makeString("2026-09-2" + std::to_string(i)));
        row.set("rxBytes", JsonValue::makeString(std::to_string(i * 1000000000ULL + 7)));
        rows.push(std::move(row));
    }
    root.set("records", std::move(rows));

    const std::string text = root.dump();
    std::string error;
    const auto parsed = JsonValue::parse(text, error);
    WIFIMETER_CHECK(parsed.has_value());
    if (parsed)
    {
        WIFIMETER_CHECK_EQ(roundTrip(*parsed), text);
        WIFIMETER_CHECK_EQ(parsed->find("records")->size(), std::size_t{3});
        WIFIMETER_CHECK_EQ(parsed->find("records")->at(2).stringOr("rxBytes"), std::string("2000000007"));
    }
}

void keepsNonFiniteNumbersOutOfOutput()
{
    // NaN 与 Infinity 不是合法 JSON，输出成 null 而不是让对面解析失败。
    WIFIMETER_CHECK_EQ(JsonValue::makeNumber(0.0 / 0.0).dump(), std::string("null"));
    WIFIMETER_CHECK_EQ(JsonValue::makeNumber(1.0 / 0.0).dump(), std::string("null"));
    WIFIMETER_CHECK_EQ(JsonValue::makeNumber(1.5).dump(), std::string("1.5"));
}

}  // namespace

int main()
{
    buildsAndDumpsValues();
    escapesControlCharactersAndQuotes();
    keepsByteCountsAsStrings();
    keepsLargeIntegersExact();
    parsesNestedDocuments();
    parsesUnicodeEscapes();
    rejectsMalformedDocuments();
    enforcesTheDepthLimit();
    returnsFallbacksForWrongTypes();
    mutatesObjectsAndArrays();
    writesPrettyOutput();
    roundTripsThroughText();
    keepsNonFiniteNumbersOutOfOutput();
    return WIFIMETER_REPORT();
}
