#pragma once

// 后端服务：把存储、平台采集与业务规则组装成协议方法。
//
// 这里不做任何输入输出，时间也由调用方传入，因此可以用假的平台实现直接测每一条分支；
// 真正的读写循环在 server.h。

#include <functional>
#include <optional>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "../core/usage_accumulator.h"
#include "../core/app_usage_accumulator.h"
#include "../platform/network_platform.h"
#include "../platform/proxy_attribution.h"
#include "../storage/store.h"
#include "../support/json.h"
#include "messages.h"
#include "loopback_live.h"

namespace wifimeter::ipc
{

class BackendService
{
public:
    struct Deps
    {
        storage::Store& store;
        platform::NetworkPlatform& network;
        platform::AppTrafficSource* applications = nullptr;
        std::function<platform::ProxyClientReport(const platform::ProxyOptions&)> proxySampler = {};
    };

    explicit BackendService(Deps deps, bool paused = false);

    struct Response
    {
        Error error;
        support::JsonValue result;
        bool ok() const
        {
            return error.code.empty();
        }
    };

    // 处理一条请求。
    Response handle(const Request& request, core::TimePoint now);

    struct Events
    {
        Error error;                            // 非空表示这次采集失败
        std::vector<support::JsonValue> items;  // 需要推送的事件负载（不含事件名）
        std::vector<std::string> names;         // 与 items 一一对应的事件名
    };

    // 采样一次：写入数据库并生成本次要推送的事件。
    Events collectOnce(core::TimePoint now);

    bool paused() const
    {
        return paused_;
    }
    void setPaused(bool paused, core::TimePoint now);

    // 启动时闭合上次退出遗留的未结束空档（例如进程被杀）。
    void onStart(core::TimePoint now);

    // 处理请求过程中产生的事件（例如 collectNow 触发的采样与额度提醒）。
    // 由调用方在写完响应后取走并推送。
    std::vector<std::pair<std::string, support::JsonValue>> takePendingEvents();

    // 距离下一次采样还有多久（给事件循环做超时用）。
    core::TimePoint nextSampleAt() const
    {
        return nextSampleAt_;
    }
    int intervalSeconds() const;

private:
    Response legacyRequest(const support::JsonValue& params, core::TimePoint now, bool query);
    Response buildHello() const;
    Response buildSnapshot(const support::JsonValue& params, core::TimePoint now);
    Response updateSettings(const support::JsonValue& params);
    Response updateNetwork(const support::JsonValue& params, core::TimePoint now);
    Response exportUsage(const support::JsonValue& params, core::TimePoint now) const;
    Response backup() const;
    Response restore(const support::JsonValue& params);
    Response disconnect(const support::JsonValue& params);
    Response pruneUsage(core::TimePoint now);
    storage::Status initializeProxyStorage() const;
    platform::ProxyOptions proxyOptions(storage::Status& status) const;
    Response updateProxyConfig(const support::JsonValue& params);
    support::JsonValue proxyJson(storage::Status& status) const;
    support::JsonValue proxyEstimatedRecords(const std::vector<storage::AppUsageRow>& rows, storage::Status& status) const;
    void collectProxyClients(core::TimePoint now);
    storage::Status pruneProxyObservations(core::TimePoint now) const;
    storage::Status clearProxyObservations() const;
    Response updateTotalQuota(const support::JsonValue& params, core::TimePoint now);
    support::JsonValue totalQuotaJson(core::TimePoint now, storage::Status& status);
    support::JsonValue totalQuotaBackup(storage::Status& status) const;
    storage::Status restoreTotalQuota(const support::JsonValue& document);
    void evaluateTotalQuota(core::TimePoint now, Events& events);

    support::JsonValue buildLive() const;
    support::JsonValue networkToJson(const storage::NetworkRecord& record, core::ByteCount usedBytes, const std::string& periodKey) const;
    support::JsonValue settingsToJson(const storage::SettingsRecord& settings) const;
    storage::Status refreshPausedLive(core::TimePoint now);
    void refreshLive(const platform::SampleReport& report, core::TimePoint now);
    void evaluateQuotas(core::TimePoint now, Events& events);
    support::JsonValue appCollectionToJson() const;
    void collectApplications(const platform::SampleReport& wifi, core::TimePoint now, Events& events);
    Response setAppCollection(const support::JsonValue& params, core::TimePoint now);

    Deps deps_;
    core::UsageAccumulator accumulator_;
    core::AppUsageAccumulator appAccumulator_;
    LoopbackLive loopbackLive_;
    bool appEnabled_ = false;
    mutable bool proxyStorageReady_ = false;
    std::optional<core::TimePoint> proxySampleAt_;
    platform::ProxyClientReport proxyReport_;
    bool proxyReportCurrent_ = false;
    platform::AppCollectorState appState_ = platform::AppCollectorState::disabled;
    std::string appDetail_;
    core::TimePoint appLastAt_{};
    std::int64_t appSampledAtMs_ = 0;
    std::string appSampleGeneration_;
    core::TimePoint appSampleReceivedAt_{};
    support::JsonValue appProcesses_ = support::JsonValue::makeArray();
    bool paused_ = false;
    core::TimePoint nextSampleAt_{};
    core::TimePoint lastSampleAt_{};
    core::TimePoint liveUpdatedAt_{};
    bool hasSampled_ = false;

    std::string liveState_ = "disconnected";
    std::string collectorState_ = "running";
    std::vector<platform::WifiLink> liveLinks_;
    std::map<std::string, core::TimePoint> linkSince_;                              // 按网卡记录本次连接的开始时间
    std::map<std::string, std::string> linkSsid_;                                   // 按网卡记录上次见到的网络
    std::map<std::string, std::pair<core::ByteCount, core::ByteCount>> linkRates_;  // 字节/秒
    std::string liveMessage_;
    int skippedIntervals_ = 0;
    std::map<std::string, core::TimePoint> totalDisconnectAttempts_;
    std::vector<std::pair<std::string, support::JsonValue>> pending_;
};

}  // namespace wifimeter::ipc
