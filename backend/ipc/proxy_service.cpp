#include "service.h"
#include "proxy_config.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <map>
#include <set>
#include <tuple>

namespace wifimeter::ipc
{
namespace
{
using support::JsonValue;
using storage::Status;
using core::TimePoint;

std::string folded(std::string value)
{
    for (auto& ch : value) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    return value;
}
std::string processKey(std::string value)
{
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return {};
    value = folded(value.substr(first, value.find_last_not_of(" \t\r\n") - first + 1));
    if (value.size() >= 4 && value.substr(value.size() - 4) == ".exe") value.resize(value.size() - 4);
    return value;
}

Status observeProxy(storage::Database& db, const std::string& day, const std::string& appId, const std::string& name)
{
    if (appId.empty() || appId == "unknown") return Status::success();
    Status status;
    auto insert = db.prepare("INSERT INTO proxy_apps(day,proxy_app_id,proxy_name) VALUES(?1,?2,?3) "
        "ON CONFLICT(day,proxy_app_id) DO UPDATE SET proxy_name=excluded.proxy_name;", status);
    if (!insert) return status;
    if (!insert->bind(1, day) || !insert->bind(2, appId) || !insert->bind(3, name)) return Status::failure(insert->error());
    return insert->run();
}

// 只使用本轮 helper 的双向 EStats 连接，不缓存 PID 到路径的对应关系。
void resolveHelperIdentities(platform::ProxyClientReport& report, const platform::AppTrafficReport& apps)
{
    if (apps.generation.empty() || (apps.state != platform::AppCollectorState::running &&
        apps.state != platform::AppCollectorState::partial)) return;
    std::map<std::uint32_t, std::string> instances;
    std::set<std::uint32_t> conflicting;
    for (const auto& sample : apps.samples)
    {
        if (!sample.active || sample.interfaceId != "loopback" || sample.source != "WindowsTcpEStats") continue;
        const auto prefix = std::to_string(sample.processId) + ":";
        if (sample.instanceId.rfind(prefix, 0) != 0) { conflicting.insert(sample.processId); continue; }
        const auto end = sample.instanceId.find(':', prefix.size());
        const auto created = sample.instanceId.substr(prefix.size(), end - prefix.size());
        if (created.empty() || created == "0" || created.find_first_not_of("0123456789") != std::string::npos)
        { conflicting.insert(sample.processId); continue; }
        const auto identity = created + "|" + folded(sample.appId);
        const auto [entry, inserted] = instances.emplace(sample.processId, identity);
        if (!inserted && entry->second != identity) conflicting.insert(sample.processId);
    }
    const auto usable = [&](const platform::AppTrafficSample& sample) {
        return sample.active && sample.processId && !conflicting.count(sample.processId) &&
            instances.count(sample.processId) && sample.interfaceId == "loopback" &&
            sample.source == "WindowsTcpEStats" && !sample.appId.empty() && sample.appId != "unknown";
    };
    std::vector<platform::ProxyDetectedClient> unresolved;
    for (auto detected : report.detectedClients)
    {
        std::vector<std::string> remaining;
        for (const auto& key : detected.connectionKeys)
        {
            const auto separator = key.find('>');
            if (separator == std::string::npos) { remaining.push_back(key); continue; }
            const auto reverse = key.substr(separator + 1) + ">" + key.substr(0, separator);
            const platform::AppTrafficSample* server = nullptr;
            bool clientFound = false, ambiguous = false;
            for (const auto& sample : apps.samples)
            {
                if (!usable(sample)) continue;
                if (sample.connectionKey == key && folded(sample.appId) == folded(detected.appId) &&
                    sample.processId != detected.proxyProcessId) clientFound = true;
                if (sample.connectionKey != reverse || sample.processId != detected.proxyProcessId) continue;
                if (server && server->instanceId != sample.instanceId) ambiguous = true;
                server = &sample;
            }
            if (!clientFound || !server || ambiguous || folded(server->appId) == folded(detected.appId))
            { remaining.push_back(key); continue; }
            auto observation = std::find_if(report.observations.begin(), report.observations.end(), [&](const auto& value) {
                return folded(value.proxyAppId) == folded(server->appId) && folded(value.appId) == folded(detected.appId);
            });
            if (observation == report.observations.end())
                report.observations.push_back({server->appId, server->name, detected.appId, detected.name, 1, {key}});
            else if (std::find(observation->connectionKeys.begin(), observation->connectionKeys.end(), key) == observation->connectionKeys.end())
            {
                observation->connectionKeys.push_back(key);
                observation->connections = observation->connectionKeys.size();
            }
            auto proxy = std::find_if(report.proxies.begin(), report.proxies.end(), [&](const auto& value) {
                return value.processId == server->processId;
            });
            if (proxy == report.proxies.end()) report.proxies.push_back({server->processId, server->appId, server->name});
            else if (proxy->appId.empty()) *proxy = {server->processId, server->appId, server->name};
        }
        if (!remaining.empty() || detected.connectionKeys.empty())
        {
            detected.connectionKeys = std::move(remaining);
            if (!detected.connectionKeys.empty()) detected.connections = detected.connectionKeys.size();
            unresolved.push_back(std::move(detected));
        }
    }
    report.detectedClients = std::move(unresolved);
}

Status persistObservations(storage::Database& db, const std::string& day, const platform::ProxyClientReport& report)
{
    storage::Transaction transaction(db);
    if (!transaction.active()) return Status::failure(db.lastError());
    for (const auto& proxy : report.proxies)
        if (const auto saved = observeProxy(db, day, proxy.appId, proxy.name); !saved) return saved;
    for (const auto& observation : report.observations)
    {
        if (observation.proxyAppId.empty() || observation.proxyAppId == "unknown") continue;
        if (const auto saved = observeProxy(db, day, observation.proxyAppId, observation.proxyName); !saved) return saved;
        if (observation.appId.empty() || observation.appId == "unknown") continue;
        // connections 是单次快照计数；只按连接键写入，不能把持续连接每隔 5 秒再累加一次。
        for (const auto& key : observation.connectionKeys)
        {
            if (key.empty()) continue;
            Status status;
            auto insert = db.prepare("INSERT OR IGNORE INTO proxy_observations(day,proxy_app_id,app_id,name,connection_key) VALUES(?1,?2,?3,?4,?5);", status);
            if (!insert) return status;
            if (!insert->bind(1,day) || !insert->bind(2,observation.proxyAppId) || !insert->bind(3,observation.appId) ||
                !insert->bind(4,observation.name) || !insert->bind(5,key)) return Status::failure(insert->error());
            if (const auto saved = insert->run(); !saved) return saved;
        }
    }
    return transaction.commit();
}

// 估算的输入行：分钟行带 hour/minute，按天的行两者为 -1。
struct EstimateRow
{
    std::string networkKey, day, appId, name;
    int hour = -1, minute = -1;
    core::ByteCount rxBytes = 0, txBytes = 0;
};

using DayProxy = std::pair<std::string, std::string>;
using MinuteProxy = std::tuple<std::string, int, int, std::string>;

struct ProxyWeights
{
    std::map<std::string, std::string> proxies;  // 已确认的代理路径（小写）到名称
    std::map<DayProxy, std::vector<platform::ProxyClientObservation>> days;
    std::map<MinuteProxy, std::vector<platform::ProxyClientObservation>> minutes;
};

// 读取日期区间内的权重：按天的连接数来自连接键去重，回环字节来自分钟表的合计。
Status loadProxyWeights(storage::Database& db, const std::string& fromDay, const std::string& toDay, bool withMinutes, ProxyWeights& weights)
{
    Status status;
    auto query = db.prepare("SELECT proxy_app_id,MAX(proxy_name) FROM proxy_apps GROUP BY proxy_app_id;", status);
    if (!query) return status;
    while (query->step()) weights.proxies[folded(query->columnText(0))] = query->columnText(1);
    if (query->failed()) return Status::failure(query->error());

    query = db.prepare("SELECT day,proxy_app_id,app_id,MAX(name),COUNT(*) FROM proxy_observations WHERE day>=?1 AND day<=?2 "
        "GROUP BY day,proxy_app_id,app_id ORDER BY day,proxy_app_id,app_id;", status);
    if (!query) return status;
    if (!query->bind(1, fromDay) || !query->bind(2, toDay)) return Status::failure(query->error());
    while (query->step())
    {
        const DayProxy key{query->columnText(0), folded(query->columnText(1))};
        weights.days[key].push_back({query->columnText(1), weights.proxies[key.second], query->columnText(2), query->columnText(3),
            static_cast<std::uint64_t>(query->columnInt64(4)), {}});
    }
    if (query->failed()) return Status::failure(query->error());

    query = db.prepare("SELECT day,hour,minute,proxy_app_id,app_id,name,connections,rx_bytes,tx_bytes FROM proxy_minute_weights "
        "WHERE day>=?1 AND day<=?2 ORDER BY day,hour,minute,proxy_app_id,app_id;", status);
    if (!query) return status;
    if (!query->bind(1, fromDay) || !query->bind(2, toDay)) return Status::failure(query->error());
    while (query->step())
    {
        const auto proxy = folded(query->columnText(3));
        platform::ProxyClientObservation observation{query->columnText(3), weights.proxies[proxy], query->columnText(4), query->columnText(5),
            static_cast<std::uint64_t>(query->columnInt64(6)), {}, static_cast<std::uint64_t>(query->columnInt64(7)),
            static_cast<std::uint64_t>(query->columnInt64(8))};
        auto& day = weights.days[{query->columnText(0), proxy}];
        auto known = std::find_if(day.begin(), day.end(), [&](const auto& value) { return folded(value.appId) == folded(observation.appId); });
        if (known == day.end())
        {
            // 只有分钟权重的客户端在按天估算时不带连接数，由字节权重决定份额。
            day.push_back(observation);
            day.back().connections = 0;
        }
        else
        {
            known->rxWeight += observation.rxWeight;
            known->txWeight += observation.txWeight;
        }
        if (withMinutes)
            weights.minutes[{query->columnText(0), static_cast<int>(query->columnInt64(1)), static_cast<int>(query->columnInt64(2)), proxy}]
                .push_back(std::move(observation));
    }
    return query->failed() ? Status::failure(query->error()) : Status::success();
}

// 把代理进程的原生字节分给客户端。分钟行优先用当分钟的权重，没有时退回当天的权重。
JsonValue estimateRows(const std::vector<EstimateRow>& rows, const ProxyWeights& weights, const platform::ProxyOptions& options)
{
    auto result = JsonValue::makeArray();
    std::set<std::string> configuredNames;
    for (const auto& name : options.processNames) if (auto key = processKey(name); !key.empty()) configuredNames.insert(std::move(key));
    static const std::vector<platform::ProxyClientObservation> none;
    for (const auto& row : rows)
    {
        const auto proxyKey = folded(row.appId);
        const auto separator = row.appId.find_last_of("/\\");
        const auto filename = row.appId.substr(separator == std::string::npos ? 0 : separator + 1);
        if (!weights.proxies.count(proxyKey) && !configuredNames.count(processKey(row.name)) && !configuredNames.count(processKey(filename))) continue;
        const auto* observations = &none;
        const auto minute = row.minute < 0 ? weights.minutes.end() : weights.minutes.find({row.day, row.hour, row.minute, proxyKey});
        if (minute != weights.minutes.end()) observations = &minute->second;
        else if (const auto day = weights.days.find({row.day, proxyKey}); day != weights.days.end()) observations = &day->second;
        for (const auto& estimate : platform::estimateProxyUsage(row.day, {{row.appId, row.name, row.rxBytes, row.txBytes}}, *observations))
        {
            auto item = JsonValue::makeObject();
            item.set("networkId", JsonValue::makeString(row.networkKey));
            item.set("date", JsonValue::makeString(estimate.day));
            if (row.minute >= 0)
            {
                char time[8] = {};
                std::snprintf(time, sizeof(time), "%02d:%02d", row.hour, row.minute);
                item.set("hour", JsonValue::makeInt(row.hour));
                item.set("minute", JsonValue::makeInt(row.minute));
                item.set("time", JsonValue::makeString(time));
            }
            item.set("proxyAppId", JsonValue::makeString(estimate.proxyAppId));
            item.set("appId", JsonValue::makeString(estimate.appId));
            item.set("name", JsonValue::makeString(estimate.name));
            item.set("rxBytes", JsonValue::makeString(core::decimalString(estimate.rxBytes)));
            item.set("txBytes", JsonValue::makeString(core::decimalString(estimate.txBytes)));
            item.set("estimated", JsonValue::makeBool(true));
            item.set("unattributed", JsonValue::makeBool(estimate.unattributed));
            result.push(std::move(item));
        }
    }
    return result;
}
}  // namespace

Status BackendService::initializeProxyStorage() const
{
    if (proxyStorageReady_) return Status::success();
    const auto status = ensureProxySchema(deps_.store.database());
    proxyStorageReady_ = status.ok;
    return status;
}

platform::ProxyOptions BackendService::proxyOptions(Status& status) const
{
    platform::ProxyOptions options;
    if (!(status = initializeProxyStorage())) return options;
    auto query = deps_.store.database().prepare("SELECT ports_json,process_names_json FROM proxy_config WHERE id=1;", status);
    if (!query) return options;
    if (!query->step())
    {
        status = query->failed() ? Status::failure(query->error()) : Status::success();
        return options;
    }
    status = parseProxyOptionsJson(query->columnText(0), query->columnText(1), options);
    return options;
}

BackendService::Response BackendService::updateProxyConfig(const JsonValue& params)
{
    Response response;
    platform::ProxyOptions options;
    if (const auto valid = validateProxyOptions(params, options); !valid)
    { response.error = Error{errorCode::kInvalidParams, valid.message}; return response; }
    auto status = initializeProxyStorage();
    if (!status) { response.error = Error{errorCode::kStorageFailure,status.message}; return response; }
    status = saveProxyOptions(deps_.store.database(), options);
    if (!status) { response.error = Error{errorCode::kStorageFailure,status.message}; return response; }
    // 显式保存配置时只读发现一次连接，不启动应用字节采集，也不保存流量或连接权重。
    proxyReport_ = {};
    proxyReportCurrent_ = false;
    if (!options.ports.empty())
    {
        proxyReport_ = deps_.proxySampler ? deps_.proxySampler(options) : platform::sampleProxyClients(options);
        proxyReportCurrent_ = true;
    }
    response.result = JsonValue::makeObject();
    response.result.set("proxy", proxyJson(status));
    if (!status) response.error = Error{errorCode::kStorageFailure,status.message};
    return response;
}

JsonValue BackendService::proxyJson(Status& status) const
{
    const auto options = proxyOptions(status);
    auto value = proxyOptionsJson(options);
    bool supported = true;
#if !defined(_WIN32)
    supported = static_cast<bool>(deps_.proxySampler);
#endif
    bool available = supported;
    std::string state = "disabled", detail = proxyReportCurrent_ ? proxyReport_.detail : std::string{};
    if (!supported) { state = "unsupported"; detail = "Proxy TCP observation is unsupported on this platform."; }
    else if (appEnabled_ && !options.ports.empty())
    {
        if (paused_) { state = "paused"; detail = "采集已暂停，代理连接观测也已暂停。"; }
        else if (!proxyReportCurrent_) { state = "starting"; detail = "等待下一次代理连接采样。"; }
        else
        {
            available = proxyReport_.available;
            detail = proxyReport_.detail;
            switch (proxyReport_.status)
            {
                case platform::ProxySampleStatus::ready: state = "ready"; break;
                case platform::ProxySampleStatus::disabled: state = "disabled"; break;
                case platform::ProxySampleStatus::unsupported: state = "unsupported"; break;
                case platform::ProxySampleStatus::failed: state = "failed"; break;
            }
        }
    }
    if (supported && !options.ports.empty() && !appEnabled_)
    {
        if (!detail.empty()) detail += " ";
        detail += "代理端口已保存；客户端列表仅显示最近一次发现的连接，不代表实测流量。请启用应用采集以测量字节并持续观测连接。";
    }
    if (supported && !options.ports.empty() && !paused_ &&
        (appState_ == platform::AppCollectorState::permission || (appEnabled_ && appState_ == platform::AppCollectorState::unavailable)))
    {
        if (!detail.empty()) detail += " ";
        detail += appState_ == platform::AppCollectorState::permission
            ? "应用流量采集尚未获得所需权限；代理连接观测不能代替应用字节采集。"
            : "应用流量采集不可用；代理连接观测不能代替应用字节采集。";
    }
    auto clients = JsonValue::makeArray();
    if (!options.ports.empty() && proxyReportCurrent_ && proxyReport_.available)
    {
        for (const auto& observation : proxyReport_.observations)
        {
            auto client = JsonValue::makeObject();
            client.set("appId", JsonValue::makeString(observation.appId));
            client.set("proxyAppId", JsonValue::makeString(observation.proxyAppId));
            client.set("name", JsonValue::makeString(observation.name));
            client.set("proxyName", JsonValue::makeString(observation.proxyName));
            client.set("connections", JsonValue::makeInt(static_cast<std::int64_t>(observation.connections)));
            client.set("pathAvailable", JsonValue::makeBool(true));
            if (appEnabled_ && !paused_) addProxyMeasurement(client, appProcesses_, observation.connectionKeys);
            else addProxyMeasurement(client, JsonValue::makeArray(), {});
            clients.push(std::move(client));
        }
        for (const auto& detected : proxyReport_.detectedClients)
        {
            auto client = JsonValue::makeObject();
            client.set("appId", JsonValue::makeString(detected.appId));
            client.set("proxyAppId", JsonValue::makeString(""));
            client.set("name", JsonValue::makeString(detected.name));
            client.set("proxyName", JsonValue::makeString(detected.proxyName));
            client.set("connections", JsonValue::makeInt(static_cast<std::int64_t>(detected.connections)));
            client.set("pathAvailable", JsonValue::makeBool(false));
            if (appEnabled_ && !paused_) addProxyMeasurement(client, appProcesses_, detected.connectionKeys);
            else addProxyMeasurement(client, JsonValue::makeArray(), {});
            clients.push(std::move(client));
        }
    }
    value.set("clients", std::move(clients));
    value.set("available",JsonValue::makeBool(available));
    value.set("status",JsonValue::makeString(state));
    value.set("detail",JsonValue::makeString(detail));
    return value;
}

void BackendService::collectProxyClients(TimePoint now)
{
    if (!appEnabled_ || paused_) return;
    if (proxySampleAt_ && now - *proxySampleAt_ < std::chrono::seconds(5)) return;
    Status status;
    const auto options = proxyOptions(status);
    if (status && options.ports.empty()) return;
    proxySampleAt_ = now;
    proxyReportCurrent_ = true;
    proxyReport_ = {};
    if (status) status = pruneProxyObservations(now);
    if (status)
    {
        proxyReport_ = deps_.proxySampler ? deps_.proxySampler(options) : platform::sampleProxyClients(options);
        if (proxyReport_.available && proxyIdentityFresh_) resolveHelperIdentities(proxyReport_, proxyIdentityReport_);
        const auto stamp = core::localStampOf(now);
        if (proxyReport_.available) status = persistObservations(deps_.store.database(), core::dayKeyOf(stamp), proxyReport_);
        if (status && proxyReport_.available) status = persistMinuteWeights(stamp);
    }
    if (!status)
    {
        proxyReport_.available = false;
        proxyReport_.status = platform::ProxySampleStatus::failed;
        proxyReport_.detail = status.message;
    }
}

// 每轮把客户端回环连接的字节增量和当分钟的去重连接数累加到分钟权重表。
Status BackendService::persistMinuteWeights(const core::LocalStamp& stamp)
{
    const auto day = core::dayKeyOf(stamp);
    const auto minuteKey = day + " " + std::to_string(stamp.hour) + ":" + std::to_string(stamp.minute);
    if (proxyMinuteStamp_ != minuteKey) { proxyMinuteKeys_.clear(); proxyMinuteStamp_ = minuteKey; }

    // 同一连接可能有多行实例；先按（客户端，连接键）合计累计值，再与上一轮比较。
    std::map<std::string, std::pair<std::uint64_t, std::uint64_t>> totals;
    for (const auto& row : appProcesses_.items())
    {
        if (row.stringOr("scope") != "loopback" || !row.boolOr("measurementAvailable")) continue;
        auto& total = totals[folded(row.stringOr("appId")) + "|" + row.stringOr("connectionKey")];
        total.first += std::stoull(row.stringOr("rxBytes", "0"));
        total.second += std::stoull(row.stringOr("txBytes", "0"));
    }
    const auto delta = [](std::uint64_t current, std::uint64_t previous) { return current >= previous ? current - previous : current; };

    auto& db = deps_.store.database();
    storage::Transaction transaction(db);
    if (!transaction.active()) return Status::failure(db.lastError());
    for (const auto& observation : proxyReport_.observations)
    {
        if (observation.proxyAppId.empty() || observation.proxyAppId == "unknown" ||
            observation.appId.empty() || observation.appId == "unknown") continue;
        auto& seen = proxyMinuteKeys_[{folded(observation.proxyAppId), folded(observation.appId)}];
        std::uint64_t rx = 0, tx = 0;
        for (const auto& key : observation.connectionKeys)
        {
            if (key.empty()) continue;
            seen.insert(key);
            const auto id = folded(observation.appId) + "|" + key;
            const auto current = totals.find(id);
            if (current == totals.end()) continue;
            const auto previous = proxyLoopbackTotals_.find(id);
            rx += delta(current->second.first, previous == proxyLoopbackTotals_.end() ? 0 : previous->second.first);
            tx += delta(current->second.second, previous == proxyLoopbackTotals_.end() ? 0 : previous->second.second);
        }
        if (seen.empty()) continue;
        Status status;
        auto upsert = db.prepare("INSERT INTO proxy_minute_weights(day,hour,minute,proxy_app_id,app_id,name,connections,rx_bytes,tx_bytes) "
            "VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(day,hour,minute,proxy_app_id,app_id) DO UPDATE SET name=excluded.name,"
            "connections=MAX(connections,excluded.connections),rx_bytes=rx_bytes+excluded.rx_bytes,tx_bytes=tx_bytes+excluded.tx_bytes;", status);
        if (!upsert) return status;
        if (!upsert->bind(1, day) || !upsert->bind(2, static_cast<std::int64_t>(stamp.hour)) || !upsert->bind(3, static_cast<std::int64_t>(stamp.minute)) ||
            !upsert->bind(4, observation.proxyAppId) || !upsert->bind(5, observation.appId) || !upsert->bind(6, observation.name) ||
            !upsert->bind(7, static_cast<std::int64_t>(seen.size())) || !upsert->bind(8, static_cast<std::int64_t>(rx)) ||
            !upsert->bind(9, static_cast<std::int64_t>(tx))) return Status::failure(upsert->error());
        if (const auto saved = upsert->run(); !saved) return saved;
    }
    if (const auto committed = transaction.commit(); !committed) return committed;
    proxyLoopbackTotals_ = std::move(totals);
    return Status::success();
}

Status BackendService::pruneProxyObservations(TimePoint now) const
{
    auto status = initializeProxyStorage();
    if (!status) return status;
    const auto settings = deps_.store.settings().load(status);
    if (!status || settings.retentionDays <= 0) return status;
    const auto cutoff = core::dayKeyOf(core::shiftLocalDays(core::localStampOf(now), 1 - settings.retentionDays));
    storage::Transaction transaction(deps_.store.database());
    if (!transaction.active()) return Status::failure(deps_.store.database().lastError());
    for (const auto* table : {"proxy_observations", "proxy_apps", "proxy_minute_weights"})
    {
        auto remove = deps_.store.database().prepare(std::string("DELETE FROM ") + table + " WHERE day < ?1;",status);
        if (!remove) return status;
        if (!remove->bind(1,cutoff)) return Status::failure(remove->error());
        if (!(status=remove->run())) return status;
    }
    return transaction.commit();
}

Status BackendService::clearProxyObservations() const
{
    if (const auto status=initializeProxyStorage(); !status) return status;
    storage::Transaction transaction(deps_.store.database());
    if (!transaction.active()) return Status::failure(deps_.store.database().lastError());
    const auto status=deps_.store.database().exec("DELETE FROM proxy_observations; DELETE FROM proxy_apps; DELETE FROM proxy_minute_weights;");
    return status ? transaction.commit() : status;
}

JsonValue BackendService::proxyEstimatedUpdates(TimePoint now, Status& status)
{
    auto updates = JsonValue::makeArray();
    const auto day = core::dayKeyOf(core::localStampOf(now));
    // 仅重算采样当日，跨日保留前一日已发送的历史，不发送虚假的清除。
    if (proxyEstimateDay_ != day) { proxyEstimateGroups_.clear(); proxyEstimateDay_ = day; }
    const auto rows = deps_.store.usage().appRange({}, day, day, status);
    if (!status) return updates;
    const auto records = proxyEstimatedRecords(rows, status);
    if (!status) return updates;
    std::map<std::string, JsonValue> groups;
    for (const auto& row : records.items())
    {
        auto identity = JsonValue::makeArray();
        identity.push(JsonValue::makeString(row.stringOr("networkId")));
        identity.push(JsonValue::makeString(day));
        identity.push(JsonValue::makeString(folded(row.stringOr("proxyAppId"))));
        const auto key = identity.dump();
        auto [entry, inserted] = groups.try_emplace(key, JsonValue::makeObject());
        if (inserted)
        {
            entry->second.set("networkId", JsonValue::makeString(row.stringOr("networkId")));
            entry->second.set("date", JsonValue::makeString(day));
            entry->second.set("proxyAppId", JsonValue::makeString(row.stringOr("proxyAppId")));
            entry->second.set("records", JsonValue::makeArray());
        }
        auto values = *entry->second.find("records");
        values.push(row);
        entry->second.set("records", std::move(values));
    }
    for (const auto& [key, group] : groups)
    {
        const auto old = proxyEstimateGroups_.find(key);
        if (old == proxyEstimateGroups_.end() || old->second.dump() != group.dump()) updates.push(group);
    }
    for (const auto& [key, old] : proxyEstimateGroups_)
        if (!groups.count(key))
        {
            auto removed = old;
            removed.set("records", JsonValue::makeArray());
            updates.push(std::move(removed));
        }
    proxyEstimateGroups_ = std::move(groups);
    return updates;
}

JsonValue BackendService::proxyEstimatedRecords(const std::vector<storage::AppUsageRow>& rows, Status& status) const
{
    const auto options = proxyOptions(status);
    if (!status || rows.empty()) return JsonValue::makeArray();
    const auto dates = std::minmax_element(rows.begin(), rows.end(), [](const auto& a, const auto& b) { return a.day < b.day; });
    ProxyWeights weights;
    // 已确认的代理路径可识别历史原始行；客户端权重仍严格按原始行日期查询。
    if (!(status = loadProxyWeights(deps_.store.database(), dates.first->day, dates.second->day, false, weights))) return JsonValue::makeArray();
    std::vector<EstimateRow> input;
    input.reserve(rows.size());
    for (const auto& row : rows) input.push_back({row.networkKey, row.day, row.appId, row.name, -1, -1, row.rxBytes, row.txBytes});
    return estimateRows(input, weights, options);
}

JsonValue BackendService::proxyEstimatedMinuteRecords(const std::vector<storage::AppMinuteUsageRow>& rows, Status& status) const
{
    const auto options = proxyOptions(status);
    if (!status || rows.empty()) return JsonValue::makeArray();
    const auto dates = std::minmax_element(rows.begin(), rows.end(), [](const auto& a, const auto& b) { return a.day < b.day; });
    ProxyWeights weights;
    if (!(status = loadProxyWeights(deps_.store.database(), dates.first->day, dates.second->day, true, weights))) return JsonValue::makeArray();
    std::vector<EstimateRow> input;
    input.reserve(rows.size());
    for (const auto& row : rows) input.push_back({row.networkKey, row.day, row.appId, row.name, row.hour, row.minute, row.rxBytes, row.txBytes});
    return estimateRows(input, weights, options);
}

// 只重算当前和上一分钟：更早的分钟不会再收到新字节，界面保留已发送的估算。
JsonValue BackendService::proxyEstimatedMinuteUpdates(TimePoint now, Status& status)
{
    auto updates = JsonValue::makeArray();
    std::map<std::string, JsonValue> groups;
    std::set<std::string> current;
    for (const auto at : {now - std::chrono::minutes(1), now})
    {
        const auto stamp = core::localStampOf(at);
        const auto day = core::dayKeyOf(stamp);
        const int minute = stamp.hour * 60 + stamp.minute;
        char time[8] = {};
        std::snprintf(time, sizeof(time), "%02d:%02d", stamp.hour, stamp.minute);
        current.insert(day + " " + time);
        const auto rows = deps_.store.usage().appMinuteRange({}, day, day, status, minute, minute);
        if (!status) return updates;
        const auto records = proxyEstimatedMinuteRecords(rows, status);
        if (!status) return updates;
        for (const auto& row : records.items())
        {
            auto identity = JsonValue::makeArray();
            identity.push(JsonValue::makeString(row.stringOr("networkId")));
            identity.push(JsonValue::makeString(day + " " + time));
            identity.push(JsonValue::makeString(folded(row.stringOr("proxyAppId"))));
            auto [entry, inserted] = groups.try_emplace(identity.dump(), JsonValue::makeObject());
            if (inserted)
            {
                entry->second.set("networkId", JsonValue::makeString(row.stringOr("networkId")));
                entry->second.set("date", JsonValue::makeString(day));
                entry->second.set("time", JsonValue::makeString(time));
                entry->second.set("proxyAppId", JsonValue::makeString(row.stringOr("proxyAppId")));
                entry->second.set("records", JsonValue::makeArray());
            }
            auto values = *entry->second.find("records");
            values.push(row);
            entry->second.set("records", std::move(values));
        }
    }
    for (const auto& [key, group] : groups)
    {
        const auto old = proxyEstimateMinuteGroups_.find(key);
        if (old == proxyEstimateMinuteGroups_.end() || old->second.dump() != group.dump()) updates.push(group);
    }
    for (const auto& [key, old] : proxyEstimateMinuteGroups_)
    {
        if (groups.count(key) || !current.count(old.stringOr("date") + " " + old.stringOr("time"))) continue;
        auto removed = old;
        removed.set("records", JsonValue::makeArray());
        updates.push(std::move(removed));
    }
    proxyEstimateMinuteGroups_ = std::move(groups);
    return updates;
}
}  // namespace wifimeter::ipc
