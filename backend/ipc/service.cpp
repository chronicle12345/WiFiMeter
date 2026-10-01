#include "service.h"
#include "legacy_import.h"
#include "backup_archive.h"

#include <algorithm>
#include <cmath>
#include <tuple>
#include <utility>

#include "../core/local_time.h"
#include "../core/quota.h"
#include "../storage/database.h"

namespace wifimeter::ipc
{
namespace
{

using core::ByteCount;
using core::LocalStamp;
using core::TimePoint;
using storage::Status;
using support::JsonValue;

JsonValue bytes(ByteCount value)
{
    // 字节数一律走十进制字符串：JSON 数字在 JS 侧只有 53 位精度。
    return JsonValue::makeString(core::decimalString(value));
}

ByteCount parseBytes(const JsonValue& object, std::string_view key)
{
    const JsonValue* value = object.find(key);
    if (value == nullptr)
        return 0;
    if (value->isString())
    {
        ByteCount parsed = 0;
        if (core::parseDecimal(value->asString(), parsed))
            return parsed;
        return 0;
    }
    if (value->isNumber())
        return static_cast<ByteCount>(value->asDouble());
    return 0;
}

JsonValue appRowsToJson(const std::vector<storage::AppUsageRow>& rows)
{
    JsonValue records = JsonValue::makeArray();
    for (const auto& row : rows)
    {
        JsonValue record = JsonValue::makeObject();
        record.set("networkId", JsonValue::makeString(row.networkKey));
        record.set("date", JsonValue::makeString(row.day));
        record.set("appId", JsonValue::makeString(row.appId));
        record.set("name", JsonValue::makeString(row.name));
        record.set("rxBytes", bytes(row.rxBytes));
        record.set("txBytes", bytes(row.txBytes));
        records.push(std::move(record));
    }
    return records;
}

JsonValue appGapToJson(const storage::CoverageGap& gap)
{
    JsonValue entry = JsonValue::makeObject();
    entry.set("networkId", JsonValue::makeString(gap.networkKey));
    entry.set("reason", JsonValue::makeString(std::string(storage::coverageReasonName(gap.reason))));
    entry.set("startedAt", JsonValue::makeString(core::isoUtcOf(gap.startedAt)));
    entry.set("endedAt", JsonValue::makeString(gap.span.count() > 0 ? core::isoUtcOf(gap.endedAt) : ""));
    entry.set("spanSeconds", JsonValue::makeInt(gap.span.count()));
    return entry;
}

std::string periodName(core::QuotaPeriod period)
{
    return period == core::QuotaPeriod::all ? "all" : period == core::QuotaPeriod::day ? "day" : "month";
}

core::QuotaPeriod parsePeriod(const std::string& name)
{
    return name == "all" ? core::QuotaPeriod::all : name == "day" ? core::QuotaPeriod::day : core::QuotaPeriod::month;
}

bool failureIsGlobal(const platform::Failure& failure)
{
    return failure.interfaceId.empty();
}

}  // namespace

BackendService::BackendService(Deps deps, bool paused)
    : deps_(deps),
      paused_(paused)
{
    collectorState_ = paused_ ? "paused" : "running";
}

int BackendService::intervalSeconds() const
{
    Status status;
    const storage::SettingsRecord settings = deps_.store.settings().load(status);
    return status ? settings.intervalSeconds : 5;
}

void BackendService::onStart(TimePoint now)
{
    if (initializeProxyStorage()) pruneProxyObservations(now);
    // 上次退出时可能留下了未结束的空档（进程被杀、断电），启动时补上结束时间。
    std::size_t closed = 0;
    deps_.store.closeOpenGaps(now, closed);
    deps_.store.usage().closeOpenGaps(now, closed, true);
    lastSampleAt_ = now;
    nextSampleAt_ = now;
    collectorState_ = paused_ ? "paused" : "running";
}

std::vector<std::pair<std::string, support::JsonValue>> BackendService::takePendingEvents()
{
    std::vector<std::pair<std::string, support::JsonValue>> events;
    events.swap(pending_);
    return events;
}

void BackendService::setPaused(bool paused, TimePoint now)
{
    if (paused_ == paused)
        return;
    paused_ = paused;
    collectorState_ = paused ? "paused" : "running";

    // 暂停期间没有采集，恢复时把这段区间补成覆盖空档，而不是让那几天看起来是 0。
    if (paused)
    {
        storage::CoverageGap gap;
        gap.reason = storage::CoverageReason::paused;
        gap.startedAt = now;
        deps_.store.usage().addGap(gap);
        if (appEnabled_)
        {
            gap.application = true;
            deps_.store.usage().addGap(gap);
            if (deps_.applications)
                deps_.applications->stop();
            appAccumulator_.clear();
            appProcesses_ = JsonValue::makeArray();
            appState_ = platform::AppCollectorState::paused;
        }
    }
    else
    {
        std::size_t closed = 0;
        deps_.store.closeOpenGaps(now, closed);
        deps_.store.usage().closeOpenGaps(now, closed, true);
        if (appEnabled_ && deps_.applications)
        {
            deps_.applications->start();
            appState_ = platform::AppCollectorState::starting;
            appLastAt_ = now;
        }
    }
    nextSampleAt_ = now;
}

JsonValue BackendService::settingsToJson(const storage::SettingsRecord& settings) const
{
    JsonValue value = JsonValue::makeObject();
    value.set("unit", JsonValue::makeString(settings.unit == storage::DisplayUnit::gib ? "GiB" : "GB"));
    value.set("speedUnit", JsonValue::makeString(settings.speedUnit == storage::SpeedUnit::megabitsPerSecond ? "Mbps" : "MB/s"));
    value.set("interval", JsonValue::makeInt(settings.intervalSeconds));
    value.set("language", JsonValue::makeString(settings.language));
    value.set("retention", JsonValue::makeInt(settings.retentionDays));
    value.set("autoStart", JsonValue::makeBool(settings.autoStart));
    value.set("minimizeToTray", JsonValue::makeBool(settings.minimizeToTray));
    value.set("notifications", JsonValue::makeBool(settings.notifications));
    return value;
}

JsonValue BackendService::networkToJson(const storage::NetworkRecord& record, ByteCount usedBytes, const std::string& periodKey) const
{
    JsonValue value = JsonValue::makeObject();
    value.set("id", JsonValue::makeString(record.key));
    value.set("ssid", JsonValue::makeString(record.ssid));
    value.set("alias", JsonValue::makeString(record.alias));
    value.set("type", JsonValue::makeString(record.type));
    value.set("capGb", JsonValue::makeNumber(record.capGb));
    value.set("warnPercent", JsonValue::makeNumber(record.warnPercent));
    value.set("quotaPeriod", JsonValue::makeString(periodName(record.quotaPeriod)));
    value.set("notify", JsonValue::makeBool(record.notify));
    value.set("autoDisconnect", JsonValue::makeBool(record.autoDisconnect));

    // 界面用账本判断额度，而不是回头统计区间内的记录，因此这里必须带上。
    JsonValue ledger = JsonValue::makeObject();
    ledger.set("periodKey", JsonValue::makeString(periodKey));
    ledger.set("usedBytes", bytes(usedBytes));
    value.set("quotaLedger", std::move(ledger));

    value.set("firstSeenAt", JsonValue::makeString(record.firstSeenAt));
    value.set("lastSeenAt", JsonValue::makeString(record.lastSeenAt));
    return value;
}

JsonValue BackendService::buildLive() const
{
    JsonValue live = JsonValue::makeObject();
    live.set("state", JsonValue::makeString(liveState_));
    live.set("collector", JsonValue::makeString(collectorState_));
    live.set("updatedAt", JsonValue::makeString(core::isoUtcOf(lastSampleAt_)));
    live.set("skippedIntervals", JsonValue::makeInt(skippedIntervals_));
    if (!liveMessage_.empty())
        live.set("message", JsonValue::makeString(liveMessage_));

    JsonValue connections = JsonValue::makeArray();
    for (const platform::WifiLink& link : liveLinks_)
    {
        const core::NetworkRef reference = core::networkRefOf(link.identity);
        if (!reference.valid())
            continue;

        JsonValue connection = JsonValue::makeObject();
        connection.set("networkId", JsonValue::makeString(reference.key));
        connection.set("type", JsonValue::makeString(link.identity.type));
        connection.set("interfaceId", JsonValue::makeString(link.interfaceId));
        connection.set("adapterAlias", JsonValue::makeString(link.adapterAlias));
        connection.set("band", JsonValue::makeString(std::string(platform::bandLabel(link.band))));
        connection.set("signal", JsonValue::makeInt(link.signalPercent.value_or(0)));

        const auto rate = linkRates_.find(link.interfaceId);
        const ByteCount rxPerSecond = rate != linkRates_.end() ? rate->second.first : 0;
        const ByteCount txPerSecond = rate != linkRates_.end() ? rate->second.second : 0;
        connection.set("rxPerSecond", bytes(rxPerSecond));
        connection.set("txPerSecond", bytes(txPerSecond));

        const auto since = linkSince_.find(link.interfaceId);
        connection.set("since", JsonValue::makeString(since != linkSince_.end() ? core::isoUtcOf(since->second) : core::isoUtcOf(lastSampleAt_)));
        connections.push(std::move(connection));
    }
    live.set("connections", std::move(connections));
    live.set("appCollection", appCollectionToJson());
    live.set("appProcesses", appProcesses_);
    return live;
}

JsonValue BackendService::appCollectionToJson() const
{
    JsonValue value = JsonValue::makeObject();
    value.set("enabled", JsonValue::makeBool(appEnabled_));
    value.set("available", JsonValue::makeBool(deps_.applications != nullptr));
    value.set("state", JsonValue::makeString(std::string(platform::appCollectorStateName(appState_))));
    value.set("detail", JsonValue::makeString(appDetail_));
    return value;
}

BackendService::Response BackendService::setAppCollection(const JsonValue& params, TimePoint now)
{
    Response response;
    const auto* enabled = params.find("enabled");
    if (enabled == nullptr || !enabled->isBool())
    {
        response.error = Error{errorCode::kInvalidParams, "enabled 必须是布尔值。"};
        return response;
    }
    if (enabled->asBool() && deps_.applications == nullptr)
    {
        response.error = Error{errorCode::kUnavailable, "当前构建没有可用的应用采集器。"};
        return response;
    }
    appEnabled_ = enabled->asBool();
    if (deps_.applications)
    {
        deps_.applications->stop();
        if (appEnabled_ && !paused_)
            deps_.applications->start();
    }
    appAccumulator_.clear();
    appProcesses_ = JsonValue::makeArray();
    appLastAt_ = now;
    appDetail_.clear();
    appState_ = !appEnabled_ ? platform::AppCollectorState::disabled : paused_ ? platform::AppCollectorState::paused : platform::AppCollectorState::starting;
    std::size_t closed = 0;
    deps_.store.usage().closeOpenGaps(now, closed, true);
    JsonValue result = JsonValue::makeObject();
    result.set("appCollection", appCollectionToJson());
    response.result = std::move(result);
    pending_.emplace_back(event::kLive, buildLive());
    return response;
}

void BackendService::collectApplications(const platform::SampleReport& wifi, TimePoint now, Events& events)
{
    if (!appEnabled_ || deps_.applications == nullptr)
        return;
    const auto report = deps_.applications->read();
    appState_ = report.state;
    appDetail_ = report.detail;
    const auto accumulated = appAccumulator_.accumulate(report, wifi, now);
    appProcesses_ = JsonValue::makeArray();
    Status status;
    storage::Transaction transaction(deps_.store.database());
    if (!transaction.active())
    {
        appState_ = platform::AppCollectorState::unavailable;
        appDetail_ = deps_.store.database().lastError();
        appAccumulator_.clear();
        appLastAt_ = now;
        return;
    }
    std::vector<storage::AppUsageRow> rows;
    JsonValue gapRecords = JsonValue::makeArray();
    for (const auto& delta : accumulated.deltas)
    {
        storage::AppUsageRow row{delta.network.key, core::dayKeyOf(core::localStampOf(delta.at)), delta.process.appId, delta.process.name, delta.rxBytes, delta.txBytes};
        if (const auto written = deps_.store.usage().addApp(row); !written)
        {
            // 应用存储失败不撤销已提交的网卡统计，也不推送未保存的应用增量。
            appState_ = platform::AppCollectorState::unavailable;
            appDetail_ = written.message;
            appAccumulator_.clear();
            appLastAt_ = now;
            return;
        }
        rows.push_back(std::move(row));
    }
    for (const auto& missing : accumulated.gaps)
    {
        storage::CoverageGap gap;
        gap.application = true;
        gap.networkKey = missing.network.key;
        gap.startedAt = missing.startedAt;
        gap.endedAt = missing.endedAt;
        gap.span = std::chrono::duration_cast<std::chrono::seconds>(gap.endedAt - gap.startedAt);
        switch (missing.kind)
        {
            case core::AppGapKind::counterReset: gap.reason = storage::CoverageReason::counterReset; break;
            case core::AppGapKind::reattributed: gap.reason = storage::CoverageReason::reattributed; break;
            case core::AppGapKind::identityUnknown: gap.reason = storage::CoverageReason::identityUnknown; break;
            case core::AppGapKind::sourceRestart: gap.reason = storage::CoverageReason::offline; break;
        }
        if (gap.span.count() > 0)
        {
            if (!(status = deps_.store.usage().addGap(gap)))
                break;
            gapRecords.push(appGapToJson(gap));
        }
    }
    const bool collecting = report.state == platform::AppCollectorState::running || report.state == platform::AppCollectorState::partial;
    if (status && appLastAt_ != TimePoint{} && now > appLastAt_ && (!collecting || report.state == platform::AppCollectorState::partial || !wifi.complete()))
    {
        storage::CoverageGap gap;
        gap.application = true;
        gap.startedAt = appLastAt_;
        gap.endedAt = now;
        gap.span = std::chrono::duration_cast<std::chrono::seconds>(now - appLastAt_);
        gap.reason = !wifi.complete() ? storage::CoverageReason::identityUnknown : storage::CoverageReason::offline;
        if (gap.span.count() > 0)
        {
            status = deps_.store.usage().addGap(gap);
            if (status)
                gapRecords.push(appGapToJson(gap));
        }
    }
    if (!status || !(status = transaction.commit()))
    {
        if (!transaction.active())
            deps_.store.database().rollback();
        appState_ = platform::AppCollectorState::unavailable;
        appDetail_ = status.message;
        appAccumulator_.clear();
        appLastAt_ = now;
        return;
    }
    if (collecting && (!accumulated.gaps.empty() || !wifi.complete()))
        appState_ = platform::AppCollectorState::partial;
    for (const auto& process : report.samples)
    {
        if (!collecting || !process.active || !process.processId)
            continue;
        const auto link = std::find_if(wifi.samples.begin(), wifi.samples.end(), [&](const auto& sample) { return sample.interfaceId == process.interfaceId; });
        if (link == wifi.samples.end())
            continue;
        const auto delta = std::find_if(accumulated.deltas.begin(), accumulated.deltas.end(), [&](const auto& item) {
            return item.process.interfaceId == process.interfaceId && item.process.instanceId == process.instanceId && item.process.appId == process.appId;
        });
        const auto seconds = delta != accumulated.deltas.end() && delta->span.count() > 0 ? static_cast<ByteCount>(delta->span.count()) : ByteCount{1};
        JsonValue value = JsonValue::makeObject();
        value.set("networkId", JsonValue::makeString(core::networkRefOf(link->identity).key));
        value.set("appId", JsonValue::makeString(process.appId));
        value.set("processId", JsonValue::makeInt(process.processId));
        value.set("instanceId", JsonValue::makeString(process.instanceId));
        value.set("rxPerSecond", bytes(delta != accumulated.deltas.end() ? delta->rxBytes / seconds : 0));
        value.set("txPerSecond", bytes(delta != accumulated.deltas.end() ? delta->txBytes / seconds : 0));
        appProcesses_.push(std::move(value));
    }
    appLastAt_ = now;
    if (!rows.empty() || gapRecords.size())
    {
        JsonValue usage = JsonValue::makeObject();
        usage.set("records", appRowsToJson(rows));
        usage.set("gaps", std::move(gapRecords));
        events.names.push_back(event::kAppUsage);
        events.items.push_back(std::move(usage));
    }
}

BackendService::Response BackendService::buildHello() const
{
    Response response;
    Status status;
    JsonValue result = JsonValue::makeObject();
    result.set("protocol", JsonValue::makeInt(kProtocolVersion));
    result.set("application", JsonValue::makeString("wifimeter-backend"));
    result.set("schemaVersion", JsonValue::makeInt(deps_.store.database().schemaVersion()));
    result.set("intervalSeconds", JsonValue::makeInt(intervalSeconds()));
    result.set("paused", JsonValue::makeBool(paused_));
    // 带上设置：主进程据此同步开机启动、托盘与通知等系统级状态，无需再取整份快照。
    result.set("settings", settingsToJson(deps_.store.settings().load(status)));
    response.result = std::move(result);
    return response;
}

BackendService::Response BackendService::buildSnapshot(const JsonValue& params, TimePoint now)
{
    Response response;
    Status status;

    // 默认给足界面可能选择的范围（最多 366 天），界面切换时间范围时不必再往返一次。
    const LocalStamp today = core::localStampOf(now);
    const std::string toDay = params.stringOr("to", core::dayKeyOf(today));
    const std::string fromDay = params.stringOr("from", core::dayKeyOf(core::shiftLocalDays(today, -365)));
    const std::string networkKey = params.stringOr("networkKey");
    const std::string hourlyDay = params.stringOr("hourlyDay", toDay);

    JsonValue result = JsonValue::makeObject();
    result.set("version", JsonValue::makeInt(1));
    result.set("source", JsonValue::makeString("backend"));
    result.set("range", [&] {
        JsonValue range = JsonValue::makeObject();
        range.set("from", JsonValue::makeString(fromDay));
        range.set("to", JsonValue::makeString(toDay));
        return range;
    }());

    const storage::SettingsRecord settings = deps_.store.settings().load(status);
    if (!status)
    {
        response.error = Error{errorCode::kStorageFailure, status.message};
        return response;
    }
    result.set("settings", settingsToJson(settings));

    // 网络列表附带账本，界面据此显示额度而无需完整记录。
    const std::vector<storage::NetworkRecord> networks = deps_.store.networks().all(status);
    if (!status)
    {
        response.error = Error{errorCode::kStorageFailure, status.message};
        return response;
    }
    JsonValue networkArray = JsonValue::makeArray();
    for (const storage::NetworkRecord& record : networks)
    {
        const auto ledger = deps_.store.networks().ledger(record.key, status);
        const ByteCount used = ledger ? ledger->usedBytes : 0;
        const std::string periodKey = ledger ? ledger->periodKey : core::periodKeyFor(record.quotaPeriod, now);
        networkArray.push(networkToJson(record, used, periodKey));
    }
    result.set("networks", std::move(networkArray));

    const std::vector<storage::DailyUsageRow> daily = deps_.store.usage().dailyRange(networkKey, fromDay, toDay, status);
    if (!status)
    {
        response.error = Error{errorCode::kStorageFailure, status.message};
        return response;
    }
    JsonValue records = JsonValue::makeArray();
    for (const storage::DailyUsageRow& row : daily)
    {
        JsonValue record = JsonValue::makeObject();
        record.set("date", JsonValue::makeString(row.day));
        record.set("networkId", JsonValue::makeString(row.networkKey));
        record.set("rxBytes", bytes(row.rxBytes));
        record.set("txBytes", bytes(row.txBytes));
        records.push(std::move(record));
    }
    result.set("records", std::move(records));

    const std::vector<storage::HourlyUsageRow> hourly = deps_.store.usage().hourlyOfDay(networkKey, hourlyDay, status);
    if (!status)
    {
        response.error = Error{errorCode::kStorageFailure, status.message};
        return response;
    }
    JsonValue hourlyArray = JsonValue::makeArray();
    for (const storage::HourlyUsageRow& row : hourly)
    {
        JsonValue record = JsonValue::makeObject();
        record.set("date", JsonValue::makeString(row.day));
        record.set("networkId", JsonValue::makeString(row.networkKey));
        record.set("hour", JsonValue::makeInt(row.hour));
        record.set("rxBytes", bytes(row.rxBytes));
        record.set("txBytes", bytes(row.txBytes));
        hourlyArray.push(std::move(record));
    }
    result.set("hourly", std::move(hourlyArray));

    // 覆盖空档：界面据此说明“这段时间没有采集到数据”，而不是显示成 0。
    // 空档按本地日期的整天区间查询：从起始日的正午往前推半天到结束日的次日正午。
    TimePoint rangeStart = now - std::chrono::hours(24 * 366);
    TimePoint rangeEnd = now;
    if (!core::parseDayKey(fromDay, rangeStart))
        rangeStart = now - std::chrono::hours(24 * 366);
    if (!core::parseDayKey(toDay, rangeEnd))
        rangeEnd = now;
    rangeStart -= std::chrono::hours(12);
    rangeEnd += std::chrono::hours(12);
    const std::vector<storage::CoverageGap> gaps = deps_.store.usage().gapsInRange(core::isoUtcOf(rangeStart), core::isoUtcOf(rangeEnd), status);
    JsonValue gapArray = JsonValue::makeArray();
    for (const storage::CoverageGap& gap : gaps)
    {
        JsonValue entry = JsonValue::makeObject();
        entry.set("networkId", JsonValue::makeString(gap.networkKey));
        entry.set("reason", JsonValue::makeString(std::string(storage::coverageReasonName(gap.reason))));
        entry.set("startedAt", JsonValue::makeString(core::isoUtcOf(gap.startedAt)));
        entry.set("endedAt", JsonValue::makeString(core::isoUtcOf(gap.endedAt)));
        entry.set("spanSeconds", JsonValue::makeInt(static_cast<std::int64_t>(gap.span.count())));
        gapArray.push(std::move(entry));
    }
    result.set("gaps", std::move(gapArray));

    result.set("totalQuota", totalQuotaJson(now, status));
    if (!status) { response.error = Error{errorCode::kStorageFailure, status.message}; return response; }
    result.set("live", buildLive());
    const auto apps = deps_.store.usage().appRange(networkKey, fromDay, toDay, status);
    if (!status)
    {
        response.error = Error{errorCode::kStorageFailure, status.message};
        return response;
    }
    result.set("appRecords", appRowsToJson(apps));
    result.set("proxy", proxyJson(status));
    if (!status) { response.error = Error{errorCode::kStorageFailure, status.message}; return response; }
    result.set("proxyEstimatedRecords", proxyEstimatedRecords(apps, status));
    if (!status) { response.error = Error{errorCode::kStorageFailure, status.message}; return response; }
    result.set("appCollection", appCollectionToJson());
    result.set("appProcesses", appProcesses_);
    const auto appGaps = deps_.store.usage().gapsInRange(core::isoUtcOf(rangeStart), core::isoUtcOf(rangeEnd), status, true);
    if (!status)
    {
        response.error = Error{errorCode::kStorageFailure, status.message};
        return response;
    }
    JsonValue appGapArray = JsonValue::makeArray();
    for (const auto& gap : appGaps)
        appGapArray.push(appGapToJson(gap));
    result.set("appGaps", std::move(appGapArray));

    response.result = std::move(result);
    return response;
}

BackendService::Response BackendService::updateSettings(const JsonValue& params)
{
    Response response;
    Status status;
    storage::SettingsRecord settings = deps_.store.settings().load(status);
    if (!status)
    {
        response.error = Error{errorCode::kStorageFailure, status.message};
        return response;
    }

    const JsonValue* patch = params.find("settings");
    if (patch == nullptr || !patch->isObject())
    {
        response.error = Error{errorCode::kInvalidParams, "缺少 settings 对象。"};
        return response;
    }

    settings.language = patch->stringOr("language", settings.language);
    settings.unit = patch->stringOr("unit", settings.unit == storage::DisplayUnit::gib ? "GiB" : "GB") == "GiB" ? storage::DisplayUnit::gib : storage::DisplayUnit::gb;
    settings.speedUnit = patch->stringOr("speedUnit", settings.speedUnit == storage::SpeedUnit::megabitsPerSecond ? "Mbps" : "MB/s") == "Mbps" ? storage::SpeedUnit::megabitsPerSecond : storage::SpeedUnit::megabytesPerSecond;
    settings.intervalSeconds = static_cast<int>(patch->intOr("interval", settings.intervalSeconds));
    settings.retentionDays = static_cast<int>(patch->intOr("retention", settings.retentionDays));
    settings.autoStart = patch->boolOr("autoStart", settings.autoStart);
    settings.minimizeToTray = patch->boolOr("minimizeToTray", settings.minimizeToTray);
    settings.notifications = patch->boolOr("notifications", settings.notifications);

    if (const Status saved = deps_.store.settings().save(settings); !saved)
    {
        response.error = Error{errorCode::kStorageFailure, saved.message};
        return response;
    }

    JsonValue result = JsonValue::makeObject();
    result.set("settings", settingsToJson(deps_.store.settings().load(status)));
    response.result = std::move(result);
    return response;
}

BackendService::Response BackendService::updateNetwork(const JsonValue& params, TimePoint now)
{
    Response response;
    Status status;
    const std::string key = params.stringOr("key");
    if (key.empty())
    {
        response.error = Error{errorCode::kInvalidParams, "缺少网络 key。"};
        return response;
    }

    const auto record = deps_.store.networks().find(key, status);
    if (!status)
    {
        response.error = Error{errorCode::kStorageFailure, status.message};
        return response;
    }
    if (!record)
    {
        response.error = Error{errorCode::kNotFound, "网络不存在：" + key};
        return response;
    }

    const std::string alias = params.stringOr("alias", record->alias);
    const double capGb = params.find("capGb") != nullptr ? params.doubleOr("capGb", record->capGb) : record->capGb;
    const double warnPercent = params.doubleOr("warnPercent", record->warnPercent);
    const core::QuotaPeriod period = params.find("quotaPeriod") != nullptr ? parsePeriod(params.stringOr("quotaPeriod")) : record->quotaPeriod;
    const bool notify = params.boolOr("notify", record->notify);
    const bool autoDisconnect = params.boolOr("autoDisconnect", record->autoDisconnect);

    if ((params.has("warnPercent") && !params.find("warnPercent")->isNumber()) || !std::isfinite(warnPercent) || warnPercent < 1 || warnPercent > 100 || !std::isfinite(capGb) || capGb < 0 || capGb > 9000000000.0 || (capGb > 0 && capGb < 1e-9))
    {
        response.error = Error{errorCode::kInvalidParams, "额度或提醒阈值超出范围。"};
        return response;
    }

    if (params.has("quotaPeriod") && params.stringOr("quotaPeriod") != "day" && params.stringOr("quotaPeriod") != "month" && params.stringOr("quotaPeriod") != "all")
    { response.error = Error{errorCode::kInvalidParams, "Invalid quota period."}; return response; }
    storage::Transaction networkUpdate(deps_.store.database());
    if (!networkUpdate.active()) { response.error = Error{errorCode::kStorageFailure, deps_.store.database().lastError()}; return response; }
    if (const Status updated = deps_.store.networks().updateUserSettings(key, alias, capGb, warnPercent, period, notify, autoDisconnect); !updated)
    {
        response.error = Error{errorCode::kStorageFailure, updated.message};
        return response;
    }

    // 周期变化时账本必须按新周期重算，否则会拿旧周期的用量去比新周期的额度。
    if (period != record->quotaPeriod)
    {
        const std::string periodKey = core::periodKeyFor(period, now);
        const std::string to = core::dayKeyOf(core::localStampOf(now));
        const std::string from = period == core::QuotaPeriod::day ? to : period == core::QuotaPeriod::month ? to.substr(0, 7) + "-01" : "0001-01-01";
        ByteCount used = 0;
        for (const auto& row : deps_.store.usage().dailyRange(key, from, to, status)) {
            if (row.rxBytes > static_cast<ByteCount>(INT64_MAX) - used || row.txBytes > static_cast<ByteCount>(INT64_MAX) - used - row.rxBytes) {
                response.error = Error{errorCode::kInvalidParams, "Quota history exceeds 64-bit storage."}; return response;
            }
            used += row.rxBytes + row.txBytes;
        }
        if (!status) { response.error = Error{errorCode::kStorageFailure, status.message}; return response; }
        status = deps_.store.networks().saveLedger(storage::QuotaLedgerRecord{key, periodKey, used});
        if (!status) { response.error = Error{errorCode::kStorageFailure, status.message}; return response; }
    }

    if (const auto committed = networkUpdate.commit(); !committed) { response.error = Error{errorCode::kStorageFailure, committed.message}; return response; }
    const auto refreshed = deps_.store.networks().find(key, status);
    const auto ledger = deps_.store.networks().ledger(key, status);
    JsonValue result = JsonValue::makeObject();
    if (refreshed)
        result.set("network", networkToJson(*refreshed, ledger ? ledger->usedBytes : 0, ledger ? ledger->periodKey : core::periodKeyFor(period, now)));
    response.result = std::move(result);
    return response;
}

BackendService::Response BackendService::exportUsage(const JsonValue& params, TimePoint now) const
{
    Response response;
    Status status;
    const LocalStamp today = core::localStampOf(now);
    const std::string toDay = params.stringOr("to", core::dayKeyOf(today));
    const std::string fromDay = params.stringOr("from", core::dayKeyOf(core::shiftLocalDays(today, -365)));
    const std::string networkKey = params.stringOr("networkKey");

    const std::vector<storage::DailyUsageRow> rows = deps_.store.usage().dailyRange(networkKey, fromDay, toDay, status);
    if (!status)
    {
        response.error = Error{errorCode::kStorageFailure, status.message};
        return response;
    }

    JsonValue result = JsonValue::makeObject();
    result.set("from", JsonValue::makeString(fromDay));
    result.set("to", JsonValue::makeString(toDay));
    JsonValue records = JsonValue::makeArray();
    for (const storage::DailyUsageRow& row : rows)
    {
        const auto record = deps_.store.networks().find(row.networkKey, status);
        JsonValue entry = JsonValue::makeObject();
        entry.set("date", JsonValue::makeString(row.day));
        entry.set("networkId", JsonValue::makeString(row.networkKey));
        entry.set("ssid", JsonValue::makeString(record ? record->ssid : std::string()));
        entry.set("alias", JsonValue::makeString(record ? record->alias : std::string()));
        entry.set("rxBytes", bytes(row.rxBytes));
        entry.set("txBytes", bytes(row.txBytes));
        records.push(std::move(entry));
    }
    result.set("records", std::move(records));
    response.result = std::move(result);
    return response;
}

BackendService::Response BackendService::backup() const
{
    Response response;
    Status status;
    if (const auto initialized = initializeProxyStorage(); !initialized)
    { response.error = Error{errorCode::kStorageFailure, initialized.message}; return response; }

    storage::Transaction transaction(deps_.store.database());
    if (!transaction.active()) { response.error = Error{errorCode::kStorageFailure, deps_.store.database().lastError()}; return response; }
    JsonValue result = JsonValue::makeObject();
    JsonValue document = JsonValue::makeObject();
    document.set("version", JsonValue::makeInt(1));
    // 与界面导出的“流量导出”区分开，恢复时会校验这个标记。
    document.set("backupType", JsonValue::makeString("wifimeter-backend-backup"));

    const storage::SettingsRecord settings = deps_.store.settings().load(status);
    if (!status) { response.error = Error{errorCode::kStorageFailure, status.message}; return response; }
    document.set("settings", settingsToJson(settings));

    JsonValue networks = JsonValue::makeArray();
    for (const storage::NetworkRecord& record : deps_.store.networks().all(status))
    {
        JsonValue entry = JsonValue::makeObject();
        entry.set("key", JsonValue::makeString(record.key));
        entry.set("ssid", JsonValue::makeString(record.ssid));
        entry.set("alias", JsonValue::makeString(record.alias));
        entry.set("type", JsonValue::makeString(record.type));
        entry.set("capGb", JsonValue::makeNumber(record.capGb));
        entry.set("warnPercent", JsonValue::makeNumber(record.warnPercent));
        entry.set("quotaPeriod", JsonValue::makeString(periodName(record.quotaPeriod)));
        entry.set("notify", JsonValue::makeBool(record.notify));
        entry.set("autoDisconnect", JsonValue::makeBool(record.autoDisconnect));
        entry.set("firstSeenAt", JsonValue::makeString(record.firstSeenAt));
        entry.set("lastSeenAt", JsonValue::makeString(record.lastSeenAt));
        networks.push(std::move(entry));
    }
    if (!status) { response.error = Error{errorCode::kStorageFailure, status.message}; return response; }
    document.set("networks", std::move(networks));

    // 备份取全部历史，因此区间给得足够宽。
    const std::vector<storage::DailyUsageRow> daily = deps_.store.usage().dailyRange("", "0000-01-01", "9999-12-31", status);
    if (!status) { response.error = Error{errorCode::kStorageFailure, status.message}; return response; }
    JsonValue records = JsonValue::makeArray();
    for (const storage::DailyUsageRow& row : daily)
    {
        JsonValue entry = JsonValue::makeObject();
        entry.set("date", JsonValue::makeString(row.day));
        entry.set("networkId", JsonValue::makeString(row.networkKey));
        entry.set("rxBytes", bytes(row.rxBytes));
        entry.set("txBytes", bytes(row.txBytes));
        records.push(std::move(entry));
    }
    document.set("records", std::move(records));

    const auto apps = deps_.store.usage().appRange("", "0000-01-01", "9999-12-31", status);
    if (!status)
    {
        response.error = Error{errorCode::kStorageFailure, status.message};
        return response;
    }
    document.set("appRecords", appRowsToJson(apps));

    JsonValue ledgers = JsonValue::makeArray();
    for (const storage::QuotaLedgerRecord& ledger : deps_.store.networks().allLedgers(status))
    {
        JsonValue entry = JsonValue::makeObject();
        entry.set("networkId", JsonValue::makeString(ledger.networkKey));
        entry.set("periodKey", JsonValue::makeString(ledger.periodKey));
        entry.set("usedBytes", bytes(ledger.usedBytes));
        ledgers.push(std::move(entry));
    }
    if (!status) { response.error = Error{errorCode::kStorageFailure, status.message}; return response; }
    document.set("ledgers", std::move(ledgers));
    document.set("totalQuota", totalQuotaBackup(status));
    if (!status) { response.error = Error{errorCode::kStorageFailure, status.message}; return response; }

    if (const auto saved = backupAdditionalTables(deps_.store.database(), document); !saved)
    { response.error = Error{errorCode::kStorageFailure, saved.message}; return response; }
    if (const auto committed = transaction.commit(); !committed)
    { response.error = Error{errorCode::kStorageFailure, committed.message}; return response; }
    result.set("backup", std::move(document));
    response.result = std::move(result);
    return response;
}

BackendService::Response BackendService::restore(const JsonValue& params)
{
    Response response;
    Status status;
    if (const auto initialized = initializeProxyStorage(); !initialized)
    { response.error = Error{errorCode::kStorageFailure, initialized.message}; return response; }

    const JsonValue* document = params.find("backup");
    if (document == nullptr || !document->isObject())
    {
        response.error = Error{errorCode::kInvalidParams, "缺少 backup 对象。"};
        return response;
    }
    const std::string type = document->stringOr("backupType");
    if (type != "wifimeter-backend-backup")
    {
        response.error = Error{errorCode::kInvalidParams, "请选择本应用生成的完整备份文件。"};
        return response;
    }

    if (const auto valid = validateBackupRows(*document); !valid)
    { response.error = Error{errorCode::kInvalidParams, valid.message}; return response; }
    storage::Transaction transaction(deps_.store.database());
    if (!transaction.active()) { response.error = Error{errorCode::kStorageFailure, deps_.store.database().lastError()}; return response; }
    // 恢复是整体替换：先清空，再按备份内容重建。
    if (const Status cleared = deps_.store.usage().clearUsage(); !cleared)
    {
        response.error = Error{errorCode::kStorageFailure, cleared.message};
        return response;
    }
    if (const Status removed = deps_.store.networks().removeAll(); !removed)
    {
        response.error = Error{errorCode::kStorageFailure, removed.message};
        return response;
    }

    std::size_t networkCount = 0;
    if (const JsonValue* networks = document->find("networks"); networks != nullptr && networks->isArray())
    {
        for (std::size_t index = 0; index < networks->size(); ++index)
        {
            const JsonValue& entry = networks->at(index);
            storage::NetworkRecord record;
            record.key = entry.stringOr("key");
            if (record.key.empty())
            {
                response.error = Error{errorCode::kInvalidParams, "备份中的网络缺少 key。"};
                return response;
            }
            record.ssid = entry.stringOr("ssid");
            record.alias = entry.stringOr("alias");
            record.type = entry.stringOr("type", "wifi");
            record.capGb = entry.doubleOr("capGb", 0);
            record.warnPercent = entry.doubleOr("warnPercent", 80);
            if ((entry.has("warnPercent") && !entry.find("warnPercent")->isNumber()) || !std::isfinite(record.warnPercent) || record.warnPercent < 1 || record.warnPercent > 100)
            {
                response.error = Error{errorCode::kInvalidParams, "Invalid warning threshold in backup."};
                return response;
            }
            record.quotaPeriod = parsePeriod(entry.stringOr("quotaPeriod", "month"));
            record.notify = entry.boolOr("notify", false);
            record.autoDisconnect = entry.boolOr("autoDisconnect", false);
            record.firstSeenAt = entry.stringOr("firstSeenAt");
            record.lastSeenAt = entry.stringOr("lastSeenAt");
            if (const Status replaced = deps_.store.networks().replace(record); !replaced)
            {
                response.error = Error{errorCode::kStorageFailure, replaced.message};
                return response;
            }
            ++networkCount;
        }
    }

    std::size_t recordCount = 0;
    if (const JsonValue* records = document->find("records"); records != nullptr && records->isArray())
    {
        for (std::size_t index = 0; index < records->size(); ++index)
        {
            const JsonValue& entry = records->at(index);
            if (const Status written = deps_.store.usage().setDaily(entry.stringOr("networkId"), entry.stringOr("date"), parseBytes(entry, "rxBytes"), parseBytes(entry, "txBytes")); !written)
            {
                response.error = Error{errorCode::kStorageFailure, written.message};
                return response;
            }
            ++recordCount;
        }
    }

    // 旧版完整备份没有 appRecords，仍可恢复；新字段存在时必须完整校验。
    if (const JsonValue* apps = document->find("appRecords"); apps != nullptr)
    {
        if (!apps->isArray())
        {
            response.error = Error{errorCode::kInvalidParams, "备份中的应用记录格式或数量无效。"};
            return response;
        }
        std::set<std::tuple<std::string, std::string, std::string>> seen;
        for (std::size_t index = 0; index < apps->size(); ++index)
        {
            const auto& entry = apps->at(index);
            storage::AppUsageRow row{entry.stringOr("networkId"), entry.stringOr("date"), entry.stringOr("appId"), entry.stringOr("name"), 0, 0};
            const auto* rx = entry.find("rxBytes");
            const auto* tx = entry.find("txBytes");
            core::TimePoint at;
            const auto network = deps_.store.networks().find(row.networkKey, status);
            if (!status)
            {
                response.error = Error{errorCode::kStorageFailure, status.message};
                return response;
            }
            if (!network || !core::parseDayKey(row.day, at) || row.appId.empty() || row.appId.size() > 1024 || row.name.empty() || row.name.size() > 256 ||
                rx == nullptr || tx == nullptr || !rx->isString() || !tx->isString() ||
                !core::parseDecimal(rx->asString(), row.rxBytes) || !core::parseDecimal(tx->asString(), row.txBytes) ||
                !storage::toStoredBytes(row.rxBytes) || !storage::toStoredBytes(row.txBytes) || !seen.emplace(row.networkKey, row.day, row.appId).second)
            {
                response.error = Error{errorCode::kInvalidParams, "备份中包含无效或重复的应用记录。"};
                return response;
            }
            if (const Status written = deps_.store.usage().setApp(row); !written)
            {
                response.error = Error{errorCode::kStorageFailure, written.message};
                return response;
            }
        }
    }

    if (const JsonValue* ledgers = document->find("ledgers"); ledgers != nullptr && ledgers->isArray())
    {
        for (std::size_t index = 0; index < ledgers->size(); ++index)
        {
            const JsonValue& entry = ledgers->at(index);
            if (const Status saved = deps_.store.networks().saveLedger(storage::QuotaLedgerRecord{entry.stringOr("networkId"), entry.stringOr("periodKey"), parseBytes(entry, "usedBytes")}); !saved)
            {
                response.error = Error{errorCode::kStorageFailure, saved.message};
                return response;
            }
        }
    }

    if (const JsonValue* settings = document->find("settings"); settings != nullptr && settings->isObject())
    {
        storage::SettingsRecord record = deps_.store.settings().load(status);
        record.language = settings->stringOr("language", "en");
        record.unit = settings->stringOr("unit", "GB") == "GiB" ? storage::DisplayUnit::gib : storage::DisplayUnit::gb;
        record.speedUnit = settings->stringOr("speedUnit", "MB/s") == "Mbps" ? storage::SpeedUnit::megabitsPerSecond : storage::SpeedUnit::megabytesPerSecond;
        record.intervalSeconds = static_cast<int>(settings->intOr("interval", record.intervalSeconds));
        record.retentionDays = static_cast<int>(settings->intOr("retention", record.retentionDays));
        record.autoStart = settings->boolOr("autoStart", record.autoStart);
        record.minimizeToTray = settings->boolOr("minimizeToTray", record.minimizeToTray);
        record.notifications = settings->boolOr("notifications", record.notifications);
        if (const Status saved = deps_.store.settings().save(record); !saved)
        {
            response.error = Error{errorCode::kStorageFailure, saved.message};
            return response;
        }
    }

    if (const auto totalRestored = restoreTotalQuota(*document); !totalRestored)
    { response.error = Error{errorCode::kInvalidParams, totalRestored.message}; return response; }
    if (const auto restored = restoreAdditionalTables(deps_.store.database(), *document); !restored)
    { response.error = Error{errorCode::kInvalidParams, restored.message}; return response; }
    if (const Status committed = transaction.commit(); !committed)
    {
        response.error = Error{errorCode::kStorageFailure, committed.message};
        return response;
    }

    proxyReportCurrent_ = false;
    // 恢复后暂停采集，避免刚恢复的历史立刻被当前计数差覆盖。
    accumulator_.clear();
    paused_ = true;
    collectorState_ = "paused";
    if (deps_.applications)
        deps_.applications->stop();
    appAccumulator_.clear();
    appProcesses_ = JsonValue::makeArray();
    appState_ = appEnabled_ ? platform::AppCollectorState::paused : platform::AppCollectorState::disabled;

    JsonValue result = JsonValue::makeObject();
    result.set("networks", JsonValue::makeInt(static_cast<std::int64_t>(networkCount)));
    result.set("records", JsonValue::makeInt(static_cast<std::int64_t>(recordCount)));
    result.set("paused", JsonValue::makeBool(true));
    response.result = std::move(result);
    return response;
}

BackendService::Response BackendService::disconnect(const JsonValue& params)
{
    Response response;
    const std::string interfaceId = params.stringOr("interfaceId");
    const std::string ssid = params.stringOr("ssid");
    if (interfaceId.empty() || ssid.empty())
    {
        response.error = Error{errorCode::kInvalidParams, "缺少 interfaceId 或 ssid。"};
        return response;
    }

    const auto known = std::find_if(liveLinks_.begin(), liveLinks_.end(), [&](const auto& link) { return link.interfaceId == interfaceId; });
    if (known != liveLinks_.end() && known->identity.type == "ethernet")
    {
        response.error = Error{errorCode::kInvalidParams, "有线连接不支持 Wi-Fi 断开操作。"};
        return response;
    }

    const platform::DisconnectReport report = deps_.network.disconnectIfAssociated(interfaceId, ssid);

    JsonValue result = JsonValue::makeObject();
    std::string outcome;
    switch (report.outcome)
    {
        case platform::DisconnectOutcome::disconnected:
            outcome = "disconnected";
            break;
        case platform::DisconnectOutcome::notAssociated:
            outcome = "notAssociated";
            break;
        case platform::DisconnectOutcome::ssidMismatch:
            outcome = "ssidMismatch";
            break;
        case platform::DisconnectOutcome::stillAssociated:
            outcome = "stillAssociated";
            break;
        case platform::DisconnectOutcome::unavailable:
            outcome = "unavailable";
            break;
        case platform::DisconnectOutcome::commandFailed:
            outcome = "commandFailed";
            break;
    }
    result.set("outcome", JsonValue::makeString(outcome));
    result.set("detail", JsonValue::makeString(report.detail));
    response.result = std::move(result);
    return response;
}

BackendService::Response BackendService::pruneUsage(TimePoint now)
{
    Response response;
    std::size_t removedDaily = 0;
    std::size_t removedHourly = 0;
    if (const Status pruned = deps_.store.pruneByRetention(now, removedDaily, removedHourly); !pruned)
    {
        response.error = Error{errorCode::kStorageFailure, pruned.message};
        return response;
    }
    JsonValue result = JsonValue::makeObject();
    if (const auto pruned = pruneProxyObservations(now); !pruned)
    { response.error = Error{errorCode::kStorageFailure, pruned.message}; return response; }
    result.set("removedDaily", JsonValue::makeInt(static_cast<std::int64_t>(removedDaily)));
    result.set("removedHourly", JsonValue::makeInt(static_cast<std::int64_t>(removedHourly)));
    response.result = std::move(result);
    return response;
}

BackendService::Response BackendService::legacyRequest(const JsonValue& params, TimePoint now, bool query)
{
    Response response;
    std::string code;
    const Status status = query ? legacyMigrationStatus(deps_.store, params, response.result, code)
                                : importLegacy(deps_.store, params, now, response.result, code);
    if (!status) response.error = Error{code.empty() ? errorCode::kStorageFailure : code, status.message};
    return response;
}

BackendService::Response BackendService::handle(const Request& request, TimePoint now)
{
    if (request.method == "updateProxyConfig") return updateProxyConfig(request.params);
    if (request.method == "updateTotalQuota") return updateTotalQuota(request.params, now);
    if (request.method == "importLegacy" || request.method == "migrationStatus")
        return legacyRequest(request.params, now, request.method == "migrationStatus");
    if (request.method == method::kHello)
        return buildHello();
    if (request.method == method::kSnapshot)
        return buildSnapshot(request.params, now);
    if (request.method == method::kUpdateSettings)
        return updateSettings(request.params);
    if (request.method == method::kUpdateNetwork)
        return updateNetwork(request.params, now);
    if (request.method == method::kExportUsage)
        return exportUsage(request.params, now);
    if (request.method == method::kBackup)
        return backup();
    if (request.method == method::kRestore)
        return restore(request.params);
    if (request.method == method::kDisconnect)
        return disconnect(request.params);
    if (request.method == method::kPruneUsage)
        return pruneUsage(now);
    if (request.method == method::kSetAppCollection)
        return setAppCollection(request.params, now);

    if (request.method == method::kClearUsage)
    {
        Response response;
        if (const Status cleared = deps_.store.clearUsage(); !cleared)
        {
            response.error = Error{errorCode::kStorageFailure, cleared.message};
            return response;
        }
        if (const auto cleared = clearProxyObservations(); !cleared)
        { response.error = Error{errorCode::kStorageFailure, cleared.message}; return response; }
        proxyReportCurrent_ = false;
        paused_ = true;  // 清空后暂停，避免立刻把当前计数差写回新记录
        collectorState_ = "paused";
        if (deps_.applications)
            deps_.applications->stop();
        appAccumulator_.clear();
        appProcesses_ = JsonValue::makeArray();
        appState_ = appEnabled_ ? platform::AppCollectorState::paused : platform::AppCollectorState::disabled;
        JsonValue result = JsonValue::makeObject();
        result.set("cleared", JsonValue::makeBool(true));
        result.set("paused", JsonValue::makeBool(true));
        response.result = std::move(result);
        return response;
    }

    if (request.method == method::kSetPaused)
    {
        const bool paused = request.params.boolOr("paused", true);
        setPaused(paused, now);
        Response response;
        JsonValue result = JsonValue::makeObject();
        result.set("paused", JsonValue::makeBool(paused_));
        response.result = std::move(result);
        return response;
    }

    if (request.method == method::kCollectNow)
    {
        const Events events = collectOnce(now);
        Response response;
        if (!events.error.code.empty())
        {
            response.error = events.error;
            return response;
        }
        for (std::size_t index = 0; index < events.items.size(); ++index)
            pending_.emplace_back(events.names[index], events.items[index]);
        JsonValue result = JsonValue::makeObject();
        result.set("events", JsonValue::makeInt(static_cast<std::int64_t>(events.items.size())));
        response.result = std::move(result);
        return response;
    }

    if (request.method == method::kShutdown)
    {
        Response response;
        response.result = JsonValue::makeObject();
        return response;
    }

    Response response;
    response.error = Error{errorCode::kUnknownMethod, "未知方法：" + request.method};
    return response;
}

void BackendService::refreshLive(const platform::SampleReport& report, TimePoint now)
{
    liveLinks_.clear();
    for (const platform::WifiLink& link : report.links)
    {
        if (link.identity.associated())
            liveLinks_.push_back(link);
    }

    // 连接开始时间靠身份变化来推断：同一张网卡换了网络就重新计时。
    for (const platform::WifiLink& link : liveLinks_)
    {
        const std::string ssid = link.identity.ssid.value_or(std::string());
        const auto previous = linkSsid_.find(link.interfaceId);
        if (previous == linkSsid_.end() || previous->second != ssid)
        {
            linkSsid_[link.interfaceId] = ssid;
            linkSince_[link.interfaceId] = now;
        }
    }
    // 不再关联的网卡要清掉记录，避免下次连上时沿用旧的开始时间。
    for (auto entry = linkSsid_.begin(); entry != linkSsid_.end();)
    {
        const bool stillThere = std::any_of(liveLinks_.begin(), liveLinks_.end(), [&entry](const platform::WifiLink& link) { return link.interfaceId == entry->first; });
        if (stillThere)
        {
            ++entry;
            continue;
        }
        linkSince_.erase(entry->first);
        linkRates_.erase(entry->first);
        entry = linkSsid_.erase(entry);
    }

    bool globalFailure = false;
    for (const platform::Failure& failure : report.failures)
    {
        if (failureIsGlobal(failure) && (failure.kind == platform::FailureKind::unavailable || failure.kind == platform::FailureKind::timeout || failure.kind == platform::FailureKind::commandFailed))
            globalFailure = true;
    }
    // WLAN 不可用不代表成功返回样本的有线接口也离线。
    if (std::any_of(report.samples.begin(), report.samples.end(), [](const auto& sample) {
        return sample.identity.type == "ethernet" && sample.identity.associated();
    })) globalFailure = false;
    liveMessage_ = report.failures.empty() ? std::string() : (report.failures.front().detail.empty() ? std::string("部分接口采样失败。") : report.failures.front().detail);

    if (globalFailure)
        liveState_ = "offline";
    else if (!liveLinks_.empty())
        liveState_ = "connected";
    else
        liveState_ = "disconnected";

    collectorState_ = paused_ ? "paused" : (globalFailure ? "offline" : "running");
}

void BackendService::evaluateQuotas(TimePoint now, Events& events)
{
    evaluateTotalQuota(now, events);
    Status status;
    const storage::SettingsRecord settings = deps_.store.settings().load(status);
    if (!status)
        return;

    for (const storage::NetworkRecord& record : deps_.store.networks().all(status))
    {
        const auto ledger = deps_.store.networks().ledger(record.key, status);
        if (!ledger)
            continue;

        core::QuotaSettings quotaSettings;
        quotaSettings.capGb = record.capGb;
        quotaSettings.warnPercent = record.warnPercent;
        quotaSettings.period = record.quotaPeriod;
        const core::QuotaState state = core::quotaStateOf(quotaSettings, ledger->usedBytes, now);
        if (!state.limited)
            continue;

        const std::string noticeKey = record.key + "|" + state.periodKey;
        if (settings.notifications && record.notify && state.reachedWarn(record.warnPercent) && notified_.insert(noticeKey).second)
        {
            JsonValue alert = JsonValue::makeObject();
            alert.set("kind", JsonValue::makeString("quotaWarn"));
            alert.set("networkId", JsonValue::makeString(record.key));
            alert.set("ssid", JsonValue::makeString(record.ssid));
            alert.set("alias", JsonValue::makeString(record.alias));
            alert.set("percent", JsonValue::makeNumber(state.percent()));
            alert.set("usedBytes", bytes(state.usedBytes));
            alert.set("capBytes", bytes(state.capBytes));
            events.names.push_back(event::kAlert);
            events.items.push_back(std::move(alert));
        }

        if (!record.autoDisconnect || !state.reachedLimit())
            continue;

        // 超额断开：只断当前确实关联在该网络上的网卡，并复核结果。
        for (const platform::WifiLink& link : liveLinks_)
        {
            const core::NetworkRef reference = core::networkRefOf(link.identity);
            if (reference.key != record.key || link.identity.type == "ethernet")
                continue;
            const platform::DisconnectReport report = deps_.network.disconnectIfAssociated(link.interfaceId, link.identity.ssid.value_or(std::string()));
            JsonValue alert = JsonValue::makeObject();
            alert.set("kind", JsonValue::makeString("quotaDisconnect"));
            alert.set("networkId", JsonValue::makeString(record.key));
            alert.set("ssid", JsonValue::makeString(record.ssid));
            alert.set("alias", JsonValue::makeString(record.alias));
            alert.set("percent", JsonValue::makeNumber(state.percent()));
            alert.set("outcome", JsonValue::makeInt(static_cast<std::int64_t>(report.outcome)));
            alert.set("detail", JsonValue::makeString(report.detail));
            events.names.push_back(event::kAlert);
            events.items.push_back(std::move(alert));
        }
    }
}

BackendService::Events BackendService::collectOnce(TimePoint now)
{
    Events events;
    if (paused_)
    {
        collectorState_ = "paused";
        return events;
    }

    const int interval = intervalSeconds();
    if (hasSampled_)
    {
        const auto gap = std::chrono::duration_cast<std::chrono::seconds>(now - lastSampleAt_);
        // 采样明显迟于预期（例如系统休眠）时记一次缺失，界面会把它显示出来。
        if (gap > std::chrono::seconds(interval * 2))
            ++skippedIntervals_;
    }

    platform::SampleReport report = deps_.network.sampleWifi();
    if (const Status mapped = mapLegacyNetworks(deps_.store.database(), report); !mapped)
    {
        events.error = Error{errorCode::kStorageFailure, mapped.message};
        return events;
    }
    lastSampleAt_ = now;
    hasSampled_ = true;
    nextSampleAt_ = now + std::chrono::seconds(interval);

    refreshLive(report, now);

    const core::AccumulateResult accumulated = accumulator_.accumulate(report, now);
    storage::ApplySummary summary;
    if (const Status applied = deps_.store.applyUsage(accumulated, now, summary); !applied)
    {
        events.error = Error{errorCode::kStorageFailure, applied.message};
        return events;
    }

    // 速率用本次增量除以区间长度，与累计差值保持同一口径。
    collectApplications(report, now, events);
    collectProxyClients(now);
    std::map<std::string, std::pair<ByteCount, ByteCount>> recorded;
    for (const core::UsageDelta& delta : accumulated.deltas)
    {
        const auto seconds = delta.span.count() > 0 ? delta.span.count() : 1;
        linkRates_[delta.interfaceId] = {delta.rxBytes / static_cast<ByteCount>(seconds), delta.txBytes / static_cast<ByteCount>(seconds)};
        auto& totals = recorded[delta.network.key];
        totals.first += delta.rxBytes;
        totals.second += delta.txBytes;
    }

    if (!accumulated.deltas.empty())
    {
        Status lookup;
        JsonValue usage = JsonValue::makeObject();
        usage.set("day", JsonValue::makeString(core::dayKeyOf(core::localStampOf(now))));
        JsonValue networks = JsonValue::makeArray();
        for (const auto& entry : recorded)
        {
            JsonValue item = JsonValue::makeObject();
            item.set("networkId", JsonValue::makeString(entry.first));
            item.set("rxBytes", bytes(entry.second.first));
            item.set("txBytes", bytes(entry.second.second));
            // 顺带带上网络记录：首次见到某个网络时（新装的应用、换了新 Wi-Fi），
            // 界面的快照里还没有这个网络，只推增量的话它无法把用量归属到名字上，
            // 于是显示“未识别网络”并且用量一直是 0，要重启应用才恢复。
            const auto record = deps_.store.networks().find(entry.first, lookup);
            if (lookup && record.has_value())
            {
                const auto ledger = deps_.store.networks().ledger(entry.first, lookup);
                const ByteCount used = lookup && ledger.has_value() ? ledger->usedBytes : 0;
                item.set("network", networkToJson(*record, used, core::periodKeyFor(record->quotaPeriod, now)));
            }
            networks.push(std::move(item));
        }
        usage.set("networks", std::move(networks));
        auto total = totalQuotaJson(now, lookup);
        if (lookup) usage.set("totalQuota", std::move(total));
        events.names.push_back(event::kUsage);
        events.items.push_back(std::move(usage));
    }

    events.names.push_back(event::kLive);
    events.items.push_back(buildLive());

    evaluateQuotas(now, events);
    return events;
}

}  // namespace wifimeter::ipc
