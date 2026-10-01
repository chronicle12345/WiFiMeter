#include "service.h"
#include <cmath>
#include "../storage/total_quota.h"

namespace wifimeter::ipc {
namespace {
using support::JsonValue;
using storage::Status;
const char* totalPeriod(core::QuotaPeriod value) {
    return value == core::QuotaPeriod::day ? "day" : value == core::QuotaPeriod::all ? "all" : "month";
}
JsonValue totalSettings(const storage::TotalQuotaSettings& value) {
    auto out = JsonValue::makeObject();
    out.set("capGb", JsonValue::makeNumber(value.capGb));
    out.set("warnPercent", JsonValue::makeNumber(value.warnPercent));
    out.set("period", JsonValue::makeString(totalPeriod(value.period)));
    out.set("notify", JsonValue::makeBool(value.notify));
    out.set("autoDisconnect", JsonValue::makeBool(value.autoDisconnect));
    return out;
}
bool parseTotalSettings(const JsonValue& input, storage::TotalQuotaSettings& settings) {
    if (!input.isObject()) return false;
    for (const auto* key : {"notify", "autoDisconnect"}) if (input.has(key) && !input.find(key)->isBool()) return false;
    for (const auto* key : {"capGb", "warnPercent"}) if (input.has(key) && !input.find(key)->isNumber()) return false;
    const auto period = input.stringOr("period", totalPeriod(settings.period));
    if (period != "day" && period != "month" && period != "all") return false;
    settings.period = period == "day" ? core::QuotaPeriod::day : period == "all" ? core::QuotaPeriod::all : core::QuotaPeriod::month;
    settings.capGb = input.doubleOr("capGb", settings.capGb);
    const double warn = input.doubleOr("warnPercent", settings.warnPercent);
    if (!std::isfinite(warn) || warn < 1 || warn > 100 || !std::isfinite(settings.capGb) || settings.capGb < 0 || settings.capGb > 9000000000.0 || (settings.capGb > 0 && settings.capGb < 1e-9)) return false;
    settings.warnPercent = warn;
    settings.notify = input.boolOr("notify", settings.notify);
    settings.autoDisconnect = input.boolOr("autoDisconnect", settings.autoDisconnect);
    return true;
}
}

support::JsonValue BackendService::totalQuotaJson(core::TimePoint now, storage::Status& status) {
    const auto view = deps_.store.totalQuota().current(now, status);
    auto value = totalSettings(view.settings);
    value.set("usedBytes", JsonValue::makeString(core::decimalString(view.ledger.usedBytes)));
    value.set("periodKey", JsonValue::makeString(view.ledger.periodKey));
    return value;
}

BackendService::Response BackendService::updateTotalQuota(const JsonValue& params, core::TimePoint now) {
    Response response;
    Status status;
    auto settings = deps_.store.totalQuota().load(status).settings;
    if (!status) { response.error = Error{errorCode::kStorageFailure, status.message}; return response; }
    if (!parseTotalSettings(params, settings)) { response.error = Error{errorCode::kInvalidParams, "Invalid total Wi-Fi quota settings."}; return response; }
    status = deps_.store.totalQuota().save(settings, now);
    if (!status) { response.error = Error{errorCode::kStorageFailure, status.message}; return response; }
    response.result = JsonValue::makeObject();
    response.result.set("totalQuota", totalQuotaJson(now, status));
    if (!status) response.error = Error{errorCode::kStorageFailure, status.message};
    return response;
}

support::JsonValue BackendService::totalQuotaBackup(storage::Status& status) const {
    const auto snapshot = deps_.store.totalQuota().load(status);
    auto out = JsonValue::makeObject();
    out.set("settings", totalSettings(snapshot.settings));
    auto ledgers = JsonValue::makeArray();
    for (const auto& ledger : snapshot.ledgers) {
        auto item = JsonValue::makeObject();
        item.set("period", JsonValue::makeString(totalPeriod(ledger.period)));
        item.set("periodKey", JsonValue::makeString(ledger.periodKey));
        item.set("usedBytes", JsonValue::makeString(core::decimalString(ledger.usedBytes)));
        item.set("warningNotified", JsonValue::makeBool(ledger.warningNotified));
        item.set("limitNotified", JsonValue::makeBool(ledger.limitNotified));
        ledgers.push(std::move(item));
    }
    out.set("ledgers", std::move(ledgers));
    return out;
}

storage::Status BackendService::restoreTotalQuota(const JsonValue& document) {
    const auto* value = document.find("totalQuota");
    storage::TotalQuotaSnapshot snapshot;
    if (!value) return deps_.store.totalQuota().save(snapshot);
    if (!value->isObject() || !value->find("settings") || !parseTotalSettings(*value->find("settings"), snapshot.settings) || !value->find("ledgers") || !value->find("ledgers")->isArray()) return Status::failure("Invalid total Wi-Fi quota backup.");
    for (const auto& item : value->find("ledgers")->items()) {
        storage::TotalQuotaLedger ledger;
        const auto period = item.stringOr("period");
        if (period != "day" && period != "month" && period != "all") return Status::failure("Invalid quota period.");
        ledger.period = period == "day" ? core::QuotaPeriod::day : period == "all" ? core::QuotaPeriod::all : core::QuotaPeriod::month;
        ledger.periodKey = item.stringOr("periodKey");
        if (!item.find("usedBytes") || !item.find("usedBytes")->isString() || !core::parseDecimal(item.stringOr("usedBytes"), ledger.usedBytes)) return Status::failure("Invalid quota bytes.");
        if (!item.find("warningNotified") || !item.find("warningNotified")->isBool() || !item.find("limitNotified") || !item.find("limitNotified")->isBool()) return Status::failure("Invalid quota notification state.");
        ledger.warningNotified = item.boolOr("warningNotified");
        ledger.limitNotified = item.boolOr("limitNotified");
        snapshot.ledgers.push_back(ledger);
    }
    return deps_.store.totalQuota().save(snapshot);
}

void BackendService::evaluateTotalQuota(core::TimePoint now, Events& events) {
    Status status;
    const auto view = deps_.store.totalQuota().current(now, status);
    if (!status || !view.quota.limited) return;
    const auto settings = deps_.store.settings().load(status);
    if (!status) return;
    if (settings.notifications && view.settings.notify) {
        bool marked = false;
        const bool limit = view.quota.reachedLimit();
        if (limit) { bool ignored = false; deps_.store.totalQuota().markNotified(view.settings.period, view.ledger.periodKey, storage::TotalQuotaNotification::warning, ignored); }
        status = deps_.store.totalQuota().markNotified(view.settings.period, view.ledger.periodKey,
            limit ? storage::TotalQuotaNotification::limit : storage::TotalQuotaNotification::warning, marked);
        if (status && marked) {
            auto alert = JsonValue::makeObject();
            alert.set("kind", JsonValue::makeString(limit ? "quotaLimit" : "quotaWarn"));
            alert.set("scope", JsonValue::makeString("total"));
            alert.set("ssid", JsonValue::makeString("Total Wi-Fi"));
            alert.set("percent", JsonValue::makeNumber(view.quota.percent()));
            alert.set("usedBytes", JsonValue::makeString(core::decimalString(view.ledger.usedBytes)));
            events.names.push_back(event::kAlert); events.items.push_back(std::move(alert));
        }
    }
    if (!view.settings.autoDisconnect || !view.quota.reachedLimit()) return;
    for (const auto& link : liveLinks_) {
        if (link.identity.type != "wifi" || !link.identity.associated()) continue;
        const auto found = totalDisconnectAttempts_.find(link.interfaceId);
        if (found != totalDisconnectAttempts_.end() && now - found->second < std::chrono::seconds(30)) continue;
        totalDisconnectAttempts_[link.interfaceId] = now;
        const auto result = deps_.network.disconnectIfAssociated(link.interfaceId, link.identity.ssid.value_or(""));
        auto alert = JsonValue::makeObject();
        alert.set("kind", JsonValue::makeString("quotaDisconnect"));
        alert.set("scope", JsonValue::makeString("total"));
        alert.set("ssid", JsonValue::makeString("Total Wi-Fi"));
        alert.set("outcome", JsonValue::makeInt(static_cast<std::int64_t>(result.outcome)));
        alert.set("detail", JsonValue::makeString(result.detail));
        alert.set("percent", JsonValue::makeNumber(view.quota.percent()));
        events.names.push_back(event::kAlert); events.items.push_back(std::move(alert));
    }
}
} // namespace wifimeter::ipc
