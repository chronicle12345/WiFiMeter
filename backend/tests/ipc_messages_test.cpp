// 协议消息测试：请求解析、响应与事件的封装、错误码。

#include <string>

#include "../ipc/messages.h"
#include "test_support.h"

using namespace wifimeter::ipc;

namespace support = wifimeter::support;

namespace
{

void parsesValidRequests()
{
    Error error;
    const auto basic = parseRequest(R"({"id":7,"method":"snapshot"})", error);
    WIFIMETER_CHECK(basic.has_value());
    if (basic)
    {
        WIFIMETER_CHECK(basic->hasId);
        WIFIMETER_CHECK_EQ(basic->id, 7LL);
        WIFIMETER_CHECK_EQ(basic->method, std::string("snapshot"));
        WIFIMETER_CHECK(basic->params.isObject());
        WIFIMETER_CHECK_EQ(basic->protocol, kProtocolVersion);
    }

    const auto withParams = parseRequest(R"({"id":1,"protocol":1,"method":"updateNetwork","params":{"key":"uuid-1","capGb":10}})", error);
    WIFIMETER_CHECK(withParams.has_value());
    if (withParams)
    {
        WIFIMETER_CHECK_EQ(withParams->params.stringOr("key"), std::string("uuid-1"));
        WIFIMETER_CHECK_EQ(withParams->params.doubleOr("capGb"), 10.0);
    }

    // 没有 id 的通知式请求也能解析，只是不回带 id 的响应。
    const auto anonymous = parseRequest(R"({"method":"hello"})", error);
    WIFIMETER_CHECK(anonymous.has_value());
    if (anonymous)
        WIFIMETER_CHECK(!anonymous->hasId);
}

void rejectsBadRequests()
{
    Error error;
    WIFIMETER_CHECK(!parseRequest("", error).has_value());
    WIFIMETER_CHECK_EQ(error.code, std::string(errorCode::kBadRequest));

    WIFIMETER_CHECK(!parseRequest("这是文本不是 JSON", error).has_value());
    WIFIMETER_CHECK(!parseRequest("[1,2,3]", error).has_value());
    WIFIMETER_CHECK_EQ(error.code, std::string(errorCode::kBadRequest));

    // 缺 method
    WIFIMETER_CHECK(!parseRequest(R"({"id":1})", error).has_value());
    WIFIMETER_CHECK(error.message.find("method") != std::string::npos);

    // params 必须是对象
    WIFIMETER_CHECK(!parseRequest(R"({"id":1,"method":"x","params":[]})", error).has_value());
    WIFIMETER_CHECK(error.message.find("params") != std::string::npos);

    // 协议版本不一致要单独报错，避免新旧版本静默错位。
    WIFIMETER_CHECK(!parseRequest(R"({"id":1,"protocol":99,"method":"hello"})", error).has_value());
    WIFIMETER_CHECK_EQ(error.code, std::string(errorCode::kVersionMismatch));
    WIFIMETER_CHECK(error.message.find("99") != std::string::npos);
}

void encodesResponses()
{
    Request request;
    request.hasId = true;
    request.id = 3;

    support::JsonValue result = support::JsonValue::makeObject();
    result.set("value", support::JsonValue::makeInt(1));
    WIFIMETER_CHECK_EQ(encodeResult(request, result), std::string(R"({"id":3,"ok":true,"result":{"value":1}})"));

    WIFIMETER_CHECK_EQ(encodeError(request, Error{errorCode::kNotFound, "没有这个网络"}), std::string(R"({"id":3,"ok":false,"error":{"code":"notFound","message":"没有这个网络"}})"));

    // 没有 id 的请求不回 id 字段。
    Request anonymous;
    WIFIMETER_CHECK_EQ(encodeResult(anonymous, support::JsonValue::makeObject()), std::string(R"({"ok":true,"result":{}})"));
}

void encodesEvents()
{
    support::JsonValue payload = support::JsonValue::makeObject();
    payload.set("state", support::JsonValue::makeString("connected"));
    WIFIMETER_CHECK_EQ(encodeEvent(event::kLive, payload), std::string(R"({"event":"live","state":"connected"})"));
}

void roundTripsThroughText()
{
    // 响应本身也必须是可解析的 JSON，否则对面的 JSON.parse 会失败。
    Request request;
    request.hasId = true;
    request.id = 42;
    support::JsonValue result = support::JsonValue::makeObject();
    result.set("text", support::JsonValue::makeString("含\"引号\"与\n换行"));
    const std::string encoded = encodeResult(request, result);

    WIFIMETER_CHECK(encoded.find('\n') == std::string::npos);  // 必须是单行
    Error error;
    const auto parsed = parseRequest(encoded, error);
    WIFIMETER_CHECK(!parsed.has_value());  // 响应没有 method，不是合法请求
    WIFIMETER_CHECK_EQ(error.code, std::string(errorCode::kBadRequest));
}

}  // namespace

int main()
{
    parsesValidRequests();
    rejectsBadRequests();
    encodesResponses();
    encodesEvents();
    roundTripsThroughText();
    return WIFIMETER_REPORT();
}
