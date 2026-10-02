#include "service.h"
#include "proxy_config.h"

#include <algorithm>
#include <cctype>
#include <map>
#include <set>

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
    if (supported && !options.ports.empty() && appEnabled_ && !paused_ &&
        (appState_ == platform::AppCollectorState::permission || appState_ == platform::AppCollectorState::unavailable))
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
        if (proxyReport_.available) status = persistObservations(deps_.store.database(), core::dayKeyOf(core::localStampOf(now)), proxyReport_);
    }
    if (!status)
    {
        proxyReport_.available = false;
        proxyReport_.status = platform::ProxySampleStatus::failed;
        proxyReport_.detail = status.message;
    }
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
    for (const auto* table : {"proxy_observations", "proxy_apps"})
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
    const auto status=deps_.store.database().exec("DELETE FROM proxy_observations; DELETE FROM proxy_apps;");
    return status ? transaction.commit() : status;
}

JsonValue BackendService::proxyEstimatedRecords(const std::vector<storage::AppUsageRow>& rows, Status& status) const
{
    auto result = JsonValue::makeArray();
    const auto options = proxyOptions(status);
    if (!status || rows.empty()) return result;
    using DayProxy = std::pair<std::string,std::string>;
    std::map<std::string,std::string> proxies;
    std::map<DayProxy,std::vector<platform::ProxyClientObservation>> weights;
    const auto dates = std::minmax_element(rows.begin(),rows.end(),[](const auto& a,const auto& b) { return a.day < b.day; });
    // 已确认的代理路径可识别历史原始行；客户端权重仍严格按原始行日期查询。
    auto query=deps_.store.database().prepare("SELECT proxy_app_id,MAX(proxy_name) FROM proxy_apps GROUP BY proxy_app_id;",status);
    if (!query) return result;
    while(query->step()) proxies[folded(query->columnText(0))]=query->columnText(1);
    if (query->failed()) { status=Status::failure(query->error()); return result; }
    query=deps_.store.database().prepare("SELECT day,proxy_app_id,app_id,MAX(name),COUNT(*) FROM proxy_observations WHERE day>=?1 AND day<=?2 "
        "GROUP BY day,proxy_app_id,app_id ORDER BY day,proxy_app_id,app_id;",status);
    if (!query) return result;
    if (!query->bind(1,dates.first->day) || !query->bind(2,dates.second->day)) { status=Status::failure(query->error()); return result; }
    while(query->step())
    {
        const DayProxy key{query->columnText(0),folded(query->columnText(1))};
        weights[key].push_back({query->columnText(1),proxies[key.second],query->columnText(2),query->columnText(3),static_cast<std::uint64_t>(query->columnInt64(4)),{}});
    }
    if (query->failed()) { status=Status::failure(query->error()); return result; }
    std::set<std::string> configuredNames;
    for (const auto& name : options.processNames) if (auto key=processKey(name); !key.empty()) configuredNames.insert(std::move(key));
    for (const auto& row : rows)
    {
        const DayProxy key{row.day,folded(row.appId)};
        const auto proxy=proxies.find(key.second);
        const auto filename=row.appId.substr(row.appId.find_last_of("/\\") == std::string::npos ? 0 : row.appId.find_last_of("/\\")+1);
        if (proxy==proxies.end() && !configuredNames.count(processKey(row.name)) && !configuredNames.count(processKey(filename))) continue;
        const auto found=weights.find(key);
        const auto estimated=platform::estimateProxyUsage(row.day,{{row.appId,row.name,row.rxBytes,row.txBytes}},
            found==weights.end() ? std::vector<platform::ProxyClientObservation>{} : found->second);
        for (const auto& estimate : estimated)
        {
            auto item=JsonValue::makeObject();
            item.set("networkId",JsonValue::makeString(row.networkKey));
            item.set("date",JsonValue::makeString(estimate.day));
            item.set("proxyAppId",JsonValue::makeString(estimate.proxyAppId));
            item.set("appId",JsonValue::makeString(estimate.appId));
            item.set("name",JsonValue::makeString(estimate.name));
            item.set("rxBytes",JsonValue::makeString(core::decimalString(estimate.rxBytes)));
            item.set("txBytes",JsonValue::makeString(core::decimalString(estimate.txBytes)));
            item.set("estimated",JsonValue::makeBool(true));
            item.set("unattributed",JsonValue::makeBool(estimate.unattributed));
            result.push(std::move(item));
        }
    }
    return result;
}
}  // namespace wifimeter::ipc
