#include "backup_archive.h"
#include "proxy_config.h"
#include "../core/local_time.h"
#include "../core/network_key.h"
#include "../storage/usage_repository.h"
#include <charconv>
#include <set>
#include <vector>

namespace wifimeter::ipc
{
namespace
{
using support::JsonValue;
using storage::Status;
struct Column { const char* sql; const char* json; bool integer = false; bool nullable = false; };
struct Table { const char* table; const char* field; const char* where; std::vector<Column> columns; };
const std::vector<Table> tables = {
    {"hourly_usage", "hourlyRecords", "", {{"network_key","networkId"},{"day","date"},{"hour","hour",true},{"rx_bytes","rxBytes",true},{"tx_bytes","txBytes",true}}},
    {"coverage_gaps", "gaps", "scope='network'", {{"id","id",true},{"network_key","networkId"},{"reason","reason"},{"reason_detail","reasonDetail"},{"started_at","startedAt"},{"ended_at","endedAt"},{"span_seconds","spanSeconds",true}}},
    {"coverage_gaps", "appGaps", "scope='apps'", {{"id","id",true},{"network_key","networkId"},{"reason","reason"},{"reason_detail","reasonDetail"},{"started_at","startedAt"},{"ended_at","endedAt"},{"span_seconds","spanSeconds",true}}},
    {"legacy_imports", "legacyImports", "", {{"source_id","sourceId"},{"state_json","stateJson"},{"settings_json","settingsJson",false,true},{"app_usage_json","appUsageJson",false,true},{"imported_at","importedAt"},{"network_count","networkCount",true},{"daily_count","dailyCount",true},{"report_json","reportJson"}}},
    {"legacy_network_keys", "legacyNetworkMappings", "", {{"ssid","ssid"},{"network_key","networkKey"}}},
    {"proxy_config", "proxyConfig", "", {{"id","id",true},{"ports_json","portsJson"},{"process_names_json","processNamesJson"}}},
    {"proxy_apps", "proxyApps", "", {{"day","date"},{"proxy_app_id","proxyAppId"},{"proxy_name","proxyName"}}},
    {"proxy_observations", "proxyObservations", "", {{"day","date"},{"proxy_app_id","proxyAppId"},{"app_id","appId"},{"name","name"},{"connection_key","connectionKey"}}}
};
bool integer(const JsonValue* value, std::int64_t& number)
{
    if (!value || (!value->isString() && !value->isNumber())) return false;
    const auto text = value->isString() ? value->asString() : value->dump();
    const auto parsed = std::from_chars(text.data(), text.data()+text.size(), number);
    return parsed.ec == std::errc{} && parsed.ptr == text.data()+text.size() && number >= 0;
}
std::string columnsOf(const Table& table)
{
    std::string out;
    for (const auto& column : table.columns) { if (!out.empty()) out += ','; out += column.sql; }
    return out;
}
Status invalid(const std::string& field) { return Status::failure("备份字段无效：" + field); }

Status validateProxyBackupRows(const JsonValue& document)
{
    if (const auto* rows=document.find("proxyConfig"))
    {
        if (!rows->isArray() || rows->size()>1) return invalid("proxyConfig");
        for (const auto& row : rows->items())
        {
            std::int64_t id=0;
            if (!row.isObject() || !integer(row.find("id"),id) || id!=1 ||
                !row.find("portsJson") || !row.find("portsJson")->isString() ||
                !row.find("processNamesJson") || !row.find("processNamesJson")->isString()) return invalid("proxyConfig");
            platform::ProxyOptions options;
            if (const auto valid=parseProxyOptionsJson(row.stringOr("portsJson"),row.stringOr("processNamesJson"),options); !valid) return valid;
        }
    }
    for (const auto* field : {"proxyApps","proxyObservations"})
    {
        const auto* rows=document.find(field);
        if (!rows) continue;
        if (!rows->isArray()) return invalid(field);
        for (const auto& row : rows->items())
        {
            core::TimePoint day;
            if (!row.isObject() || !core::parseDayKey(row.stringOr("date"),day) ||
                row.stringOr("proxyAppId").empty()) return invalid(field);
            if (std::string(field)=="proxyApps")
            {
                if (!row.find("proxyName") || !row.find("proxyName")->isString()) return invalid(field);
            }
            else if (row.stringOr("appId").empty() || row.stringOr("connectionKey").empty() ||
                !row.find("name") || !row.find("name")->isString()) return invalid(field);
        }
    }
    return Status::success();
}

}

Status backupAdditionalTables(storage::Database& db, JsonValue& document)
{
    if (const auto initialized=ensureProxySchema(db); !initialized) return initialized;
    for (const auto& table : tables)
    {
        Status status;
        auto query = db.prepare("SELECT " + columnsOf(table) + " FROM " + table.table +
            (*table.where ? " WHERE " + std::string(table.where) : "") + " ORDER BY " + columnsOf(table), status);
        if (!query) return status;
        auto rows = JsonValue::makeArray();
        while (query->step())
        {
            auto row = JsonValue::makeObject();
            int index = 0;
            for (const auto& column : table.columns)
            {
                // 所有整数使用字符串，含 gap id，避免 JS 中间转换丢失精度。
                row.set(column.json, query->columnIsNull(index) ? JsonValue::makeNull() :
                    JsonValue::makeString(column.integer ? std::to_string(query->columnInt64(index)) : query->columnText(index)));
                ++index;
            }
            rows.push(std::move(row));
        }
        if (query->failed()) return Status::failure(query->error());
        document.set(table.field, std::move(rows));
    }
    return Status::success();
}

Status restoreAdditionalTables(storage::Database& db, const JsonValue& document)
{
    if (const auto valid=validateProxyBackupRows(document); !valid) return valid;
    if (const auto initialized=ensureProxySchema(db); !initialized) return initialized;
    if (const auto cleared = db.exec("DELETE FROM legacy_imports; DELETE FROM legacy_network_keys; DELETE FROM proxy_observations; DELETE FROM proxy_apps; DELETE FROM proxy_config;"); !cleared) return cleared;
    for (const auto& table : tables)
    {
        const auto* rows = document.find(table.field);
        if (!rows) continue;
        if (!rows->isArray()) return invalid(table.field);
        for (const auto& row : rows->items())
        {
            if (!row.isObject()) return invalid(table.field);
            std::string placeholders;
            for (std::size_t i=0; i<table.columns.size(); ++i) { if (i) placeholders += ','; placeholders += '?'; }
            const bool gaps = std::string(table.table) == "coverage_gaps";
            Status status;
            auto insert = db.prepare("INSERT INTO " + std::string(table.table) + "(" + columnsOf(table) + (gaps ? ",scope" : "") + ") VALUES(" + placeholders +
                (gaps ? (std::string(table.field)=="appGaps" ? ",'apps'" : ",'network'") : "") + ")",status);
            if (!insert) return status;
            int index = 1;
            for (const auto& column : table.columns)
            {
                const auto* value = row.find(column.json);
                if (!value && std::string(column.json)=="reportJson") { status=insert->bind(index++,std::string("{}")); if (!status) return status; continue; }
                if (!value) return invalid(column.json);
                if (column.nullable && value->isNull()) status = insert->bindNull(index);
                else if (column.integer)
                {
                    std::int64_t number=0;
                    if (!integer(value,number)) return invalid(column.json);
                    status=insert->bind(index,number);
                }
                else
                {
                    if (!value->isString()) return invalid(column.json);
                    status=insert->bind(index,value->asString());
                }
                if (!status) return status;
                ++index;
            }
            if (std::string(table.field)=="hourlyRecords")
            {
                core::TimePoint at; std::int64_t hour=0;
                if (!core::parseDayKey(row.stringOr("date"),at) || !core::isValidNetworkKey(row.stringOr("networkId")) ||
                    !integer(row.find("hour"),hour) || hour>23) return invalid(table.field);
            }
            if (gaps)
            {
                core::TimePoint start,end; std::int64_t span=0,id=0;
                if (!storage::coverageReasonFromName(row.stringOr("reason")) ||
                    !core::parseIsoUtc(row.stringOr("startedAt"),start) ||
                    (!row.stringOr("endedAt").empty() && (!core::parseIsoUtc(row.stringOr("endedAt"),end) || end<start)) ||
                    !integer(row.find("spanSeconds"),span) || !integer(row.find("id"),id) || id==0) return invalid(table.field);
            }
            if (std::string(table.field)=="legacyImports")
            {
                core::TimePoint at;
                if (row.stringOr("sourceId").empty() || !core::parseIsoUtc(row.stringOr("importedAt"),at)) return invalid(table.field);
                for (const auto* key : {"stateJson","settingsJson","appUsageJson","reportJson"})
                {
                    if (!row.find(key) || row.find(key)->isNull()) continue;
                    std::string error;
                    auto raw = row.stringOr(key);
                    if (raw.substr(0,3)=="\xEF\xBB\xBF") raw.erase(0,3);
                    const auto parsed = JsonValue::parse(raw,error);
                    if (!parsed || !parsed->isObject()) return invalid(key);
                }
            }
            if (std::string(table.field)=="legacyNetworkMappings" && !core::isValidNetworkKey(row.stringOr("networkKey"))) return invalid(table.field);
            if (const auto saved=insert->run(); !saved) return saved;
        }
    }
    // 映射不能指向另一个 SSID；网络被用户删除后遗留的映射允许往返保存。
    Status status;
    auto mismatch=db.prepare("SELECT 1 FROM legacy_network_keys m JOIN networks n ON m.network_key=n.key WHERE m.ssid != n.ssid COLLATE BINARY LIMIT 1",status);
    if (!mismatch) return status;
    if (mismatch->step()) return invalid("legacyNetworkMappings");
    return mismatch->failed() ? Status::failure(mismatch->error()) : Status::success();
}

Status validateBackupRows(const JsonValue& document)
{
    if (const auto valid=validateProxyBackupRows(document); !valid) return valid;
    if (document.has("version") && document.intOr("version")!=1) return invalid("version");
    for (const auto* required : {"networks","records"})
        if (!document.find(required) || !document.find(required)->isArray()) return invalid(required);
    if (document.has("settings") && !document.find("settings")->isObject()) return invalid("settings");
    if (const auto* settings=document.find("settings"))
    {
        if (settings->has("language") && settings->stringOr("language")!="en" && settings->stringOr("language")!="zh-CN") return invalid("language");
        for (const auto* field : {"retention","interval"})
        {
            if (!settings->has(field)) continue;
            std::int64_t value=0;
            if (!integer(settings->find(field),value) || (std::string(field)=="retention" ? value>36500 : (value!=2 && value!=5 && value!=10))) return invalid(field);
        }
    }
    std::set<std::string> keys;
    for (const auto& network : document.find("networks")->items())
        if (!core::isValidNetworkKey(network.stringOr("key")) || !keys.insert(network.stringOr("key")).second) return invalid("networks");
    for (const auto* field : {"records","ledgers"})
    {
        if (!document.has(field)) continue;
        if (!document.find(field)->isArray()) return invalid(field);
        std::set<std::pair<std::string,std::string>> seen;
        for (const auto& row : document.find(field)->items())
        {
            const bool daily = std::string(field)=="records";
            const auto key=row.stringOr("networkId");
            const auto period=row.stringOr(daily ? "date" : "periodKey");
            core::TimePoint at;
            if (key.empty() || period.empty() || (daily && !core::parseDayKey(period,at)) || !seen.emplace(key,period).second) return invalid(field);
            for (const auto* column : (daily ? std::vector<const char*>{"rxBytes","txBytes"} : std::vector<const char*>{"usedBytes"}))
            {
                std::int64_t value=0;
                if (!row.find(column) || !row.find(column)->isString() || !integer(row.find(column),value)) return invalid(column);
            }
        }
    }
    return Status::success();
}
}
