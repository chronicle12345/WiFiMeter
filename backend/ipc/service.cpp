#include "service.h"

#include <algorithm>
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

std::string periodName(core::QuotaPeriod period)
{
    return period == core::QuotaPeriod::day ? "day" : "month";
}

core::QuotaPeriod parsePeriod(const std::string& name)
{
    return name == "day" ? core::QuotaPeriod::day : core::QuotaPeriod::month;
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
    // 上次退出时可能留下了未结束的空档（进程被杀、断电），启动时补上结束时间。
    std::size_t closed = 0;
    deps_.store.closeOpenGaps(now, closed);
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
    }
    else
    {
        std::size_t closed = 0;
        deps_.store.closeOpenGaps(now, closed);
    }
    nextSampleAt_ = now;
}

JsonValue BackendService::settingsToJson(const storage::SettingsRecord& settings) const
{
    JsonValue value = JsonValue::makeObject();
    value.set("unit", JsonValue::makeString(settings.unit == storage::DisplayUnit::gib ? "GiB" : "GB"));
    value.set("speedUnit", JsonValue::makeString(settings.speedUnit == storage::SpeedUnit::megabitsPerSecond ? "Mbps" : "MB/s"));
    value.set("interval", JsonValue::makeInt(settings.intervalSeconds));
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
    value.set("warnPercent", JsonValue::makeInt(record.warnPercent));
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
    return live;
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

    result.set("live", buildLive());
    // 应用级统计尚未实现，保持空数组以便界面结构稳定。
    result.set("appRecords", JsonValue::makeArray());

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
    const int warnPercent = static_cast<int>(params.intOr("warnPercent", record->warnPercent));
    const core::QuotaPeriod period = params.find("quotaPeriod") != nullptr ? parsePeriod(params.stringOr("quotaPeriod")) : record->quotaPeriod;
    const bool notify = params.boolOr("notify", record->notify);
    const bool autoDisconnect = params.boolOr("autoDisconnect", record->autoDisconnect);

    if (warnPercent < 1 || warnPercent > 100 || capGb < 0 || capGb > 100000)
    {
        response.error = Error{errorCode::kInvalidParams, "额度或提醒阈值超出范围。"};
        return response;
    }

    if (const Status updated = deps_.store.networks().updateUserSettings(key, alias, capGb, warnPercent, period, notify, autoDisconnect); !updated)
    {
        response.error = Error{errorCode::kStorageFailure, updated.message};
        return response;
    }

    // 周期变化时账本必须按新周期重算，否则会拿旧周期的用量去比新周期的额度。
    if (period != record->quotaPeriod)
    {
        const std::string periodKey = core::periodKeyFor(period, now);
        deps_.store.networks().saveLedger(storage::QuotaLedgerRecord{key, periodKey, 0});
    }

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

    JsonValue result = JsonValue::makeObject();
    JsonValue document = JsonValue::makeObject();
    document.set("version", JsonValue::makeInt(1));
    // 与界面导出的“流量导出”区分开，恢复时会校验这个标记。
    document.set("backupType", JsonValue::makeString("wifimeter-backend-backup"));

    const storage::SettingsRecord settings = deps_.store.settings().load(status);
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
        entry.set("warnPercent", JsonValue::makeInt(record.warnPercent));
        entry.set("quotaPeriod", JsonValue::makeString(periodName(record.quotaPeriod)));
        entry.set("notify", JsonValue::makeBool(record.notify));
        entry.set("autoDisconnect", JsonValue::makeBool(record.autoDisconnect));
        entry.set("firstSeenAt", JsonValue::makeString(record.firstSeenAt));
        entry.set("lastSeenAt", JsonValue::makeString(record.lastSeenAt));
        networks.push(std::move(entry));
    }
    document.set("networks", std::move(networks));

    // 备份取全部历史，因此区间给得足够宽。
    const std::vector<storage::DailyUsageRow> daily = deps_.store.usage().dailyRange("", "0000-01-01", "9999-12-31", status);
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

    JsonValue ledgers = JsonValue::makeArray();
    for (const storage::QuotaLedgerRecord& ledger : deps_.store.networks().allLedgers(status))
    {
        JsonValue entry = JsonValue::makeObject();
        entry.set("networkId", JsonValue::makeString(ledger.networkKey));
        entry.set("periodKey", JsonValue::makeString(ledger.periodKey));
        entry.set("usedBytes", bytes(ledger.usedBytes));
        ledgers.push(std::move(entry));
    }
    document.set("ledgers", std::move(ledgers));

    result.set("backup", std::move(document));
    response.result = std::move(result);
    return response;
}

BackendService::Response BackendService::restore(const JsonValue& params)
{
    Response response;
    Status status;

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

    storage::Transaction transaction(deps_.store.database());
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
            record.warnPercent = static_cast<int>(entry.intOr("warnPercent", 80));
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

    if (const Status committed = transaction.commit(); !committed)
    {
        response.error = Error{errorCode::kStorageFailure, committed.message};
        return response;
    }

    // 恢复后暂停采集，避免刚恢复的历史立刻被当前计数差覆盖。
    paused_ = true;
    collectorState_ = "paused";

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
    result.set("removedDaily", JsonValue::makeInt(static_cast<std::int64_t>(removedDaily)));
    result.set("removedHourly", JsonValue::makeInt(static_cast<std::int64_t>(removedHourly)));
    response.result = std::move(result);
    return response;
}

BackendService::Response BackendService::handle(const Request& request, TimePoint now)
{
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

    if (request.method == method::kClearUsage)
    {
        Response response;
        if (const Status cleared = deps_.store.clearUsage(); !cleared)
        {
            response.error = Error{errorCode::kStorageFailure, cleared.message};
            return response;
        }
        paused_ = true;  // 清空后暂停，避免立刻把当前计数差写回新记录
        collectorState_ = "paused";
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
            if (reference.key != record.key)
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

    const platform::SampleReport report = deps_.network.sampleWifi();
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
        JsonValue usage = JsonValue::makeObject();
        usage.set("day", JsonValue::makeString(core::dayKeyOf(core::localStampOf(now))));
        JsonValue networks = JsonValue::makeArray();
        for (const auto& entry : recorded)
        {
            JsonValue item = JsonValue::makeObject();
            item.set("networkId", JsonValue::makeString(entry.first));
            item.set("rxBytes", bytes(entry.second.first));
            item.set("txBytes", bytes(entry.second.second));
            networks.push(std::move(item));
        }
        usage.set("networks", std::move(networks));
        events.names.push_back(event::kUsage);
        events.items.push_back(std::move(usage));
    }

    events.names.push_back(event::kLive);
    events.items.push_back(buildLive());

    evaluateQuotas(now, events);
    return events;
}

}  // namespace wifimeter::ipc
