#include "fake_source.h"

#include "../support/json.h"

namespace wifimeter::platform::fake
{
namespace
{

bool readBool(const support::JsonValue& item, const char* key, bool fallback)
{
    const support::JsonValue* value = item.find(key);
    return value == nullptr ? fallback : value->asBool(fallback);
}

std::optional<int> readOptionalInt(const support::JsonValue& item, const char* key)
{
    const support::JsonValue* value = item.find(key);
    if (value == nullptr || !value->isNumber())
        return std::nullopt;
    return static_cast<int>(value->asInt64());
}

}  // namespace

std::optional<std::vector<FakeAdapter>> parseAdapters(std::string_view text)
{
    using support::JsonValue;

    std::string error;
    const auto parsed = JsonValue::parse(text, error);
    if (!parsed || !parsed->isObject())
        return std::nullopt;

    const JsonValue* adapters = parsed->find("adapters");
    if (adapters == nullptr || !adapters->isArray())
        return std::nullopt;

    std::vector<FakeAdapter> result;
    result.reserve(adapters->size());
    for (std::size_t index = 0; index < adapters->size(); ++index)
    {
        const JsonValue& item = adapters->at(index);
        if (!item.isObject())
            return std::nullopt;

        FakeAdapter adapter;
        adapter.name = item.stringOr("name");
        if (adapter.name.empty())
            return std::nullopt;
        adapter.description = item.stringOr("description");
        adapter.connected = readBool(item, "connected", false);
        adapter.mode = static_cast<std::uint32_t>(item.intOr("mode", 0));
        adapter.profileName = item.stringOr("profile");
        adapter.signalPercent = readOptionalInt(item, "signal");
        adapter.frequencyMhz = readOptionalInt(item, "frequency");
        adapter.channel = readOptionalInt(item, "channel");
        adapter.type = item.stringOr("type", "wifi");
        adapter.stableId = item.stringOr("stableId");

        if (const JsonValue* ssid = item.find("ssid"); ssid != nullptr && ssid->isString() && !ssid->asString().empty())
            adapter.ssid = ssid->asString();
        result.push_back(std::move(adapter));
    }
    return result;
}

std::vector<WifiLink> linksFromAdapters(const std::vector<FakeAdapter>& adapters)
{
    std::vector<WifiLink> links;
    links.reserve(adapters.size());
    for (const FakeAdapter& adapter : adapters)
    {
        WifiLink link;
        link.interfaceId = adapter.name;
        link.adapterAlias = adapter.description.empty() ? adapter.name : adapter.description;
        if (adapter.type == "ethernet")
        {
            link.identity = ethernetIdentity(adapter.stableId, adapter.name, adapter.connected);
            links.push_back(std::move(link));
            continue;
        }
        if (adapter.type != "wifi")
            continue;
        link.identity.profileName = adapter.profileName;
        // 测试数据里的网卡没有配置 UUID：与 Windows 侧一致，由 SSID 派生网络键。
        // 只有“已连接且有 SSID”才算关联，与两端的关联判定保持一致。
        if (adapter.connected && adapter.ssid && !adapter.ssid->empty())
            link.identity.ssid = adapter.ssid;
        link.signalPercent = adapter.signalPercent;
        link.frequencyMhz = adapter.frequencyMhz;
        if (link.frequencyMhz)
            link.band = classifyBand(*link.frequencyMhz);
        links.push_back(std::move(link));
    }
    return links;
}

bool adapterOverrideActive()
{
    return !adapterPath().empty();
}

std::optional<std::vector<FakeAdapter>> readOverriddenAdapters()
{
    const std::string& path = adapterPath();
    if (path.empty())
        return std::nullopt;
    const auto text = readTextFile(path);
    if (!text)
        return std::nullopt;
    return parseAdapters(*text);
}

LinkReadResult FakeLinkSource::readLinks()
{
    LinkReadResult result;
    const auto adapters = readOverriddenAdapters();
    if (!adapters)
    {
        result.failures.push_back({FailureKind::unavailable, {}, "测试用网卡数据不可用。"});
        return result;
    }
    result.links = linksFromAdapters(*adapters);
    return result;
}

CounterReadResult FakeLinkSource::readCounters()
{
    CounterReadResult result;
    const auto counters = readOverriddenCounters();
    if (!counters)
    {
        result.failures.push_back({FailureKind::unavailable, {}, "测试用计数数据不可用。"});
        return result;
    }
    result.counters = *counters;
    return result;
}

DisconnectOutcome FakeLinkSource::requestDisconnect(const std::string& interfaceId, std::string& detail)
{
    (void)interfaceId;
    if (!acceptDisconnect)
    {
        detail = "测试数据拒绝断开。";
        return DisconnectOutcome::commandFailed;
    }
    return DisconnectOutcome::disconnected;
}

}  // namespace wifimeter::platform::fake
