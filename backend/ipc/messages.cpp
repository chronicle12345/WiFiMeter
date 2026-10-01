#include "messages.h"

namespace wifimeter::ipc
{

std::optional<Request> parseRequest(std::string_view line, Error& error)
{
    std::string parseError;
    const auto document = support::JsonValue::parse(line, parseError);
    if (!document || !document->isObject())
    {
        error = Error{errorCode::kBadRequest, parseError.empty() ? "请求必须是 JSON 对象。" : parseError};
        return std::nullopt;
    }

    Request request;
    request.method = document->stringOr("method");
    if (request.method.empty())
    {
        error = Error{errorCode::kBadRequest, "缺少 method。"};
        return std::nullopt;
    }

    if (const support::JsonValue* id = document->find("id"); id != nullptr && id->isNumber())
    {
        request.hasId = true;
        request.id = static_cast<long long>(id->asInt64());
    }

    if (const support::JsonValue* params = document->find("params"); params != nullptr)
    {
        if (!params->isObject())
        {
            error = Error{errorCode::kBadRequest, "params 必须是 JSON 对象。"};
            return std::nullopt;
        }
        request.params = *params;
    }
    else
    {
        request.params = support::JsonValue::makeObject();
    }

    request.protocol = static_cast<int>(document->intOr("protocol", kProtocolVersion));
    if (request.protocol != kProtocolVersion)
    {
        error = Error{errorCode::kVersionMismatch, "协议版本不一致：请求为 " + std::to_string(request.protocol) + "，后端为 " + std::to_string(kProtocolVersion) + "。"};
        return std::nullopt;
    }

    return request;
}

std::string encodeResult(const Request& request, const support::JsonValue& result)
{
    support::JsonValue document = support::JsonValue::makeObject();
    if (request.hasId)
        document.set("id", support::JsonValue::makeInt(request.id));
    document.set("ok", support::JsonValue::makeBool(true));
    document.set("result", result);
    return document.dump();
}

std::string encodeError(const Request& request, std::string_view code, std::string_view message)
{
    support::JsonValue document = support::JsonValue::makeObject();
    if (request.hasId)
        document.set("id", support::JsonValue::makeInt(request.id));
    document.set("ok", support::JsonValue::makeBool(false));

    support::JsonValue detail = support::JsonValue::makeObject();
    detail.set("code", support::JsonValue::makeString(std::string(code)));
    detail.set("message", support::JsonValue::makeString(std::string(message)));
    document.set("error", std::move(detail));
    return document.dump();
}

std::string encodeEvent(std::string_view name, const support::JsonValue& payload)
{
    support::JsonValue document = support::JsonValue::makeObject();
    document.set("event", support::JsonValue::makeString(std::string(name)));
    for (const auto& field : payload.fields())
        document.set(field.first, field.second);
    return document.dump();
}

}  // namespace wifimeter::ipc
