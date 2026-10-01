#include "proxy_config.h"

#include <cctype>
#include <cmath>
#include <set>

namespace wifimeter::ipc
{
using storage::Status;
using support::JsonValue;
namespace
{
std::string folded(std::string value)
{
    for (auto& ch : value) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    return value;
}

// main 按 .NET 字符串长度计数：BMP 字符占一个 UTF-16 单位，补充字符占两个。
bool validProcessName(const std::string& name)
{
    std::size_t units = 0;
    for (std::size_t i = 0; i < name.size();)
    {
        const auto first = static_cast<unsigned char>(name[i++]);
        std::uint32_t code = first;
        unsigned remaining = 0;
        if (first >= 0xc2 && first <= 0xdf) { code = first & 0x1f; remaining = 1; }
        else if (first >= 0xe0 && first <= 0xef) { code = first & 0x0f; remaining = 2; }
        else if (first >= 0xf0 && first <= 0xf4) { code = first & 7; remaining = 3; }
        else if (first >= 0x80) return false;
        const auto extra = remaining;
        while (remaining-- > 0)
        {
            if (i == name.size()) return false;
            const auto next = static_cast<unsigned char>(name[i++]);
            if ((next & 0xc0) != 0x80) return false;
            code = (code << 6) | (next & 0x3f);
        }
        if ((extra == 2 && code < 0x800) || (extra == 3 && code < 0x10000) || code > 0x10ffff ||
            (code >= 0xd800 && code <= 0xdfff) || code < 32 || code == 127) return false;
        units += code > 0xffff ? 2 : 1;
        if (units > 64) return false;
    }
    return units != 0;
}

}  // namespace

Status validateProxyOptions(const JsonValue& input, platform::ProxyOptions& options)
{
    if (!input.isObject()) return Status::failure("Proxy config must be an object.");
    options = {};
    if (const auto* ports = input.find("ports"))
    {
        if (!ports->isArray() || ports->size() > 64) return Status::failure("Proxy ports must be an array of at most 64 integers.");
        std::set<std::uint16_t> seen;
        for (const auto& port : ports->items())
        {
            const auto number = port.asDouble();
            if (!port.isNumber() || !std::isfinite(number) || number < 1 || number > 65535 || std::floor(number) != number)
                return Status::failure("Proxy ports must be integers from 1 to 65535.");
            const auto value = static_cast<std::uint16_t>(number);
            if (!seen.insert(value).second) return Status::failure("Proxy ports must not repeat.");
            options.ports.push_back(value);
        }
    }
    if (const auto* names = input.find("processNames"))
    {
        if (!names->isArray() || names->size() > 32) return Status::failure("Proxy process names must be an array of at most 32 strings.");
        std::set<std::string> seen;
        for (const auto& name : names->items())
        {
            if (!name.isString() || !validProcessName(name.asString())) return Status::failure("Proxy process names must contain 1 to 64 characters without controls.");
            if (!seen.insert(folded(name.asString())).second) return Status::failure("Proxy process names must not repeat.");
            options.processNames.push_back(name.asString());
        }
    }
    return Status::success();
}

JsonValue proxyOptionsJson(const platform::ProxyOptions& options)
{
    auto value = JsonValue::makeObject(), ports = JsonValue::makeArray(), names = JsonValue::makeArray();
    for (auto port : options.ports) ports.push(JsonValue::makeInt(port));
    for (const auto& name : options.processNames) names.push(JsonValue::makeString(name));
    value.set("ports", std::move(ports));
    value.set("processNames", std::move(names));
    return value;
}

Status parseProxyOptionsJson(const std::string& portsJson, const std::string& processNamesJson, platform::ProxyOptions& options)
{
    std::string error;
    const auto ports = JsonValue::parse(portsJson, error);
    const auto names = JsonValue::parse(processNamesJson, error);
    if (!ports || !names) return Status::failure("Invalid saved proxy config JSON.");
    auto value = JsonValue::makeObject();
    value.set("ports", *ports);
    value.set("processNames", *names);
    return validateProxyOptions(value, options);
}

Status ensureProxySchema(storage::Database& database)
{
    return database.exec(
        "CREATE TABLE IF NOT EXISTS proxy_config(id INTEGER PRIMARY KEY CHECK(id=1),ports_json TEXT NOT NULL,process_names_json TEXT NOT NULL);"
        "CREATE TABLE IF NOT EXISTS proxy_apps(day TEXT NOT NULL,proxy_app_id TEXT COLLATE NOCASE NOT NULL,proxy_name TEXT NOT NULL,PRIMARY KEY(day,proxy_app_id));"
        "CREATE TABLE IF NOT EXISTS proxy_observations(day TEXT NOT NULL,proxy_app_id TEXT COLLATE NOCASE NOT NULL,app_id TEXT COLLATE NOCASE NOT NULL,"
        "name TEXT NOT NULL,connection_key TEXT NOT NULL,PRIMARY KEY(day,proxy_app_id,app_id,connection_key));");
}

Status saveProxyOptions(storage::Database& database, const platform::ProxyOptions& options)
{
    if (const auto initialized = ensureProxySchema(database); !initialized) return initialized;
    const auto value = proxyOptionsJson(options);
    Status status;
    auto insert = database.prepare("INSERT INTO proxy_config(id,ports_json,process_names_json) VALUES(1,?1,?2) "
        "ON CONFLICT(id) DO UPDATE SET ports_json=excluded.ports_json,process_names_json=excluded.process_names_json;", status);
    if (!insert) return status;
    if (!insert->bind(1,value.find("ports")->dump()) || !insert->bind(2,value.find("processNames")->dump())) return Status::failure(insert->error());
    return insert->run();
}
}  // namespace wifimeter::ipc
