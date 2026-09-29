#include "counter_source.h"

#include <cstdlib>
#include <fstream>
#include <sstream>

#include "../support/json.h"

namespace wifimeter::platform::fake
{
namespace
{

const char* variableValue(const char* name)
{
    const char* value = std::getenv(name);
    return (value != nullptr && *value != '\0') ? value : nullptr;
}

std::string& adapterPathStorage()
{
    static std::string value;
    return value;
}

std::string& countersPathStorage()
{
    static std::string value;
    return value;
}

}  // namespace

void configureFromEnvironment()
{
    if (const char* value = variableValue(kAdapterVariable); value != nullptr)
        adapterPathStorage() = value;
    if (const char* value = variableValue(kCountersVariable); value != nullptr)
        countersPathStorage() = value;
}

void setAdapterPath(std::string path)
{
    adapterPathStorage() = std::move(path);
}

void setCountersPath(std::string path)
{
    countersPathStorage() = std::move(path);
}

const std::string& adapterPath()
{
    return adapterPathStorage();
}

const std::string& countersPath()
{
    return countersPathStorage();
}

std::optional<std::string> readTextFile(const std::string& path)
{
    std::ifstream stream(path, std::ios::binary);
    if (!stream)
        return std::nullopt;
    std::ostringstream buffer;
    buffer << stream.rdbuf();
    return buffer.str();
}

std::optional<std::vector<CounterReading>> parseCounters(std::string_view text)
{
    using wifimeter::support::JsonValue;

    std::string error;
    const auto parsed = JsonValue::parse(text, error);
    if (!parsed || !parsed->isObject())
        return std::nullopt;

    const JsonValue* interfaces = parsed->find("interfaces");
    if (interfaces == nullptr || !interfaces->isArray())
        return std::nullopt;

    std::vector<CounterReading> counters;
    counters.reserve(interfaces->size());
    for (std::size_t index = 0; index < interfaces->size(); ++index)
    {
        const JsonValue& item = interfaces->at(index);
        if (!item.isObject())
            return std::nullopt;

        CounterReading entry;
        entry.interfaceId = item.stringOr("name");
        if (entry.interfaceId.empty())
            return std::nullopt;

        // 计数必须是非负整数：负数说明测试数据写错了，宁可当作读不到也不要截断。
        const std::int64_t rx = item.intOr("rx", -1);
        const std::int64_t tx = item.intOr("tx", -1);
        if (rx < 0 || tx < 0)
            return std::nullopt;
        entry.rxBytes = static_cast<std::uint64_t>(rx);
        entry.txBytes = static_cast<std::uint64_t>(tx);
        counters.push_back(std::move(entry));
    }
    return counters;
}

std::optional<CounterReading> findCounters(const std::vector<CounterReading>& counters, std::string_view interfaceId)
{
    for (const CounterReading& entry : counters)
    {
        if (entry.interfaceId == interfaceId)
            return entry;
    }
    return std::nullopt;
}

bool countersOverrideActive()
{
    return !countersPathStorage().empty();
}

std::optional<std::vector<CounterReading>> readOverriddenCounters()
{
    return readOverriddenCounters(readTextFile);
}

std::optional<std::vector<CounterReading>> readOverriddenCounters(const TextSource& source)
{
    const std::string& path = countersPathStorage();
    if (path.empty())
        return std::nullopt;

    // 每次都重新读取：测试要在两次采样之间改数字来制造增量。
    const auto text = source(path);
    if (!text)
        return std::nullopt;
    return parseCounters(*text);
}

}  // namespace wifimeter::platform::fake
