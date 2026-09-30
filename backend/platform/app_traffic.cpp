#include "app_traffic.h"

#include <array>
#include <charconv>
#include <limits>
#include <set>
#include <tuple>
#include <utility>

#include "../support/json.h"

namespace wifimeter::platform
{
namespace
{
constexpr std::array<std::string_view, 7> kNames{"disabled", "starting", "running", "paused", "permission", "unavailable", "partial"};

bool byteString(const support::JsonValue& object, const char* field, std::uint64_t& bytes)
{
    const auto* value = object.find(field);
    if (value == nullptr || !value->isString())
        return false;
    const auto text = value->asString();
    if (text.empty() || text.size() > 20 || (text.size() > 1 && text.front() == '0'))
        return false;
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), bytes);
    return parsed.ec == std::errc{} && parsed.ptr == text.data() + text.size();
}
}  // namespace

std::string_view appCollectorStateName(AppCollectorState state)
{
    return kNames.at(static_cast<std::size_t>(state));
}

AppTrafficReport parseAppTrafficReport(std::string_view text)
{
    AppTrafficReport report;
    report.state = AppCollectorState::unavailable;
    report.detail = "Invalid application traffic report";
    std::string error;
    const auto document = support::JsonValue::parse(text, error);
    if (!document || !document->isObject())
        return report;
    const auto state = document->stringOr("state");
    bool known = false;
    for (std::size_t index = 0; index < kNames.size(); ++index)
    {
        if (state == kNames[index])
        {
            report.state = static_cast<AppCollectorState>(index);
            known = true;
            break;
        }
    }
    if (!known)
        return report;
    report.generation = document->stringOr("generation");
    report.detail = document->stringOr("detail");
    if (report.state != AppCollectorState::running && report.state != AppCollectorState::partial)
        return report;
    const auto* samples = document->find("samples");
    if (report.generation.empty() || report.generation.size() > 128 || samples == nullptr || !samples->isArray() || samples->size() > 65536)
        return {AppCollectorState::unavailable, {}, "Invalid application traffic counters", {}};
    std::set<std::tuple<std::string, std::string, std::string>> seen;
    for (std::size_t index = 0; index < samples->size(); ++index)
    {
        const auto& entry = samples->at(index);
        AppTrafficSample sample;
        sample.interfaceId = entry.stringOr("interfaceId");
        sample.appId = entry.stringOr("appId");
        sample.name = entry.stringOr("name");
        sample.instanceId = entry.stringOr("instanceId");
        const auto* pid = entry.find("processId");
        const auto processId = entry.intOr("processId", -1);
        if (sample.interfaceId.empty() || sample.interfaceId.size() > 128 || sample.appId.empty() || sample.appId.size() > 1024 ||
            sample.name.empty() || sample.name.size() > 256 || sample.instanceId.empty() || sample.instanceId.size() > 128 ||
            pid == nullptr || !pid->isNumber() || processId < 0 || processId > std::numeric_limits<std::uint32_t>::max() || pid->asDouble() != static_cast<double>(processId) ||
            !byteString(entry, "rxBytes", sample.rxBytes) || !byteString(entry, "txBytes", sample.txBytes) ||
            !seen.emplace(sample.interfaceId, sample.appId, sample.instanceId).second)
            return {AppCollectorState::unavailable, {}, "Invalid application traffic sample", {}};
        sample.processId = static_cast<std::uint32_t>(processId);
        sample.active = entry.boolOr("active", true);
        report.samples.push_back(std::move(sample));
    }
    return report;
}

}  // namespace wifimeter::platform
