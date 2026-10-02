#include "legacy_import.h"
#include "proxy_config.h"

#include <charconv>
#include <cctype>
#include <cmath>
#include <limits>
#include <map>
#include <regex>
#include <set>
#include <tuple>

namespace wifimeter::ipc
{
namespace
{
using support::JsonValue;
using storage::Status;

bool jsonDigit(char value)
{
    return value >= '0' && value <= '9';
}

bool jsonWhitespace(char value)
{
    return value == ' ' || value == '\t' || value == '\r' || value == '\n';
}

// 转成字符串前严格验证 JSON 数值语法，避免把 0123、1. 或 1e 隐藏在引号中。
bool validJsonNumber(std::string_view token)
{
    std::size_t i=0;
    if (i<token.size() && token[i]=='-') ++i;
    if (i==token.size()) return false;
    if (token[i]=='0') ++i;
    else
    {
        if (token[i]<'1' || token[i]>'9') return false;
        while (i<token.size() && jsonDigit(token[i])) ++i;
    }
    if (i<token.size() && token[i]=='.')
    {
        const auto digits=++i;
        while (i<token.size() && jsonDigit(token[i])) ++i;
        if (i==digits) return false;
    }
    if (i<token.size() && (token[i]=='e' || token[i]=='E'))
    {
        ++i;
        if (i<token.size() && (token[i]=='+' || token[i]=='-')) ++i;
        const auto digits=i;
        while (i<token.size() && jsonDigit(token[i])) ++i;
        if (i==digits) return false;
    }
    return i==token.size();
}

std::optional<JsonValue> parseLegacyJson(std::string_view text, std::string& error)
{
    // PowerShell 的 UTF-8 文件可带 BOM；只在解析视图中跳过，档案保留原始文本。
    if (text.substr(0,3)=="\xEF\xBB\xBF") text.remove_prefix(3);
    std::string exact;
    {
        std::vector<std::pair<std::size_t,std::size_t>> numbers;
        for (std::size_t i=0;i<text.size();)
        {
            if (text[i]!='"') { ++i; continue; }
            const auto begin=i++;
            bool escaped=false,closed=false;
            while (i<text.size())
            {
                const auto character=text[i++];
                if (character=='\\')
                {
                    escaped=true;
                    if (i<text.size()) ++i;
                }
                else if (character=='"') { closed=true; break; }
            }
            if (!closed) break; // 最后一次完整解析负责报告未结束的字符串。
            auto value=i;
            while (value<text.size() && jsonWhitespace(text[value])) ++value;
            if (value==text.size() || text[value++]!=':') continue;

            auto key=text.substr(begin+1,i-begin-2);
            std::optional<JsonValue> decoded;
            std::string decodedKey;
            if (escaped)
            {
                decoded=JsonValue::parse(text.substr(begin,i-begin),error);
                if (!decoded) return std::nullopt;
                decodedKey=decoded->asString();
                key=decodedKey;
            }
            if (key!="UsedBytes" && key!="LimitGB" && key!="WarnPercent") continue;
            while (value<text.size() && jsonWhitespace(text[value])) ++value;
            if (value==text.size() || (text[value]!='-' && !jsonDigit(text[value]))) continue;
            auto end=value;
            while (end<text.size() && (jsonDigit(text[end]) || text[end]=='-' || text[end]=='+' ||
                text[end]=='.' || text[end]=='e' || text[end]=='E')) ++end;
            if (!validJsonNumber(text.substr(value,end-value)) ||
                (end<text.size() && !jsonWhitespace(text[end]) && text[end]!=',' && text[end]!='}' && text[end]!=']'))
            {
                error="旧 JSON 数值格式无效，位置 "+std::to_string(value);
                return std::nullopt;
            }
            numbers.emplace_back(value,end);
            i=end;
        }
        if (!numbers.empty())
        {
            // 一次分配转换文本；不逐项 replace 移动大历史，也不保留预解析的完整树。
            exact.reserve(text.size()+numbers.size()*2);
            std::size_t copied=0;
            for (const auto& [begin,end] : numbers)
            {
                exact.append(text.substr(copied,begin-copied));
                exact.push_back('"');
                exact.append(text.substr(begin,end-begin));
                exact.push_back('"');
                copied=end;
            }
            exact.append(text.substr(copied));
        }
    } // 构建完整 JSON 树前释放数值位置列表；没有目标数值时不复制原文。
    return JsonValue::parse(exact.empty() ? text : std::string_view(exact),error);
}

Status invalid(std::string& code, const std::string& message)
{
    code = "LegacyInvalid";
    return Status::failure(message);
}

// 原解析器已经直接保存 int64；按十进制重新检查可拒绝越界后退回 double 的值。
bool count(const JsonValue& object, const char* name, std::int64_t& value)
{
    const auto* field = object.find(name);
    if (!field || !field->isNumber()) return false;
    const auto text = field->dump();
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), value);
    return parsed.ec == std::errc{} && parsed.ptr == text.data() + text.size() && value >= 0;
}

bool timestamp(const JsonValue& object, const char* name)
{
    const auto text = object.stringOr(name);
    static const std::regex pattern(R"(^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,7})?(Z|[+-][0-9]{2}:[0-9]{2})$)");
    if (!std::regex_match(text, pattern)) return false;
    core::TimePoint ignored;
    if (!core::parseIsoUtc(text.substr(0, 19) + "Z", ignored)) return false;
    if (text.back() != 'Z')
    {
        const auto offset = text.substr(text.size() - 5);
        const int hours = std::stoi(offset.substr(0, 2));
        const int minutes = std::stoi(offset.substr(3, 2));
        if (hours > 14 || minutes > 59 || (hours == 14 && minutes != 0)) return false;
    }
    return true;
}

core::TimePoint legacyInstant(const std::string& text)
{
    // 调用前已通过 timestamp 校验；保留 100 ns 精度并换算时区偏移。
    core::TimePoint at;
    core::parseIsoUtc(text.substr(0,19)+"Z",at);
    if (text[19]=='.')
    {
        auto fraction=text.substr(20,text.find_first_of("Z+-",20)-20);
        fraction.append(9-fraction.size(),'0');
        at+=std::chrono::duration_cast<core::TimePoint::duration>(std::chrono::nanoseconds(std::stoll(fraction)));
    }
    if (text.back()!='Z')
    {
        const auto sign=text.size()-6;
        const int offset=std::stoi(text.substr(sign+1,2))*60+std::stoi(text.substr(sign+4,2));
        at+=std::chrono::minutes(text[sign]=='+' ? -offset : offset);
    }
    return at;
}

Status execute(storage::Database& db, const std::string& sql, const std::vector<std::string>& values)
{
    Status status;
    auto statement = db.prepare(sql, status);
    if (!statement) return status;
    int index = 1;
    for (const auto& value : values)
        if (!statement->bind(index++, value)) return Status::failure(statement->error());
    return statement->run();
}

// Days 是按日期和 AppId 聚合的完整日记录；Rows 是区间汇总，不能再次计数。
Status importCachedDays(storage::Store& store, const JsonValue& cache, JsonValue& report)
{
    using Identity = std::tuple<std::string,std::string,std::string>;
    std::map<Identity,storage::AppUsageRow> candidates;
    std::set<Identity> ambiguous;
    auto warnings = report.find("warnings") ? *report.find("warnings") : JsonValue::makeArray();
    std::int64_t archived=0, imported=0;
    const auto warn = [&](const std::string& reason) { ++archived; warnings.push(JsonValue::makeString(reason)); };
    storage::Status status;
    const auto networks=store.networks().all(status);
    if (!status) return status;
    const auto* records=cache.find("Records");
    std::int64_t version=0;
    if (!count(cache,"SchemaVersion",version) || version!=1 || !records || !records->isArray())
        warn("应用缓存版本或 Records 无效，仅保存原文。");
    else for (const auto& record : records->items())
    {
        const auto ssid=record.stringOr("SSID");
        std::string key;
        bool multiple=false;
        for (const auto& network : networks) if (network.ssid==ssid && network.type=="wifi") { if (!key.empty()) multiple=true; key=network.key; }
        const auto* result=record.find("Result");
        const auto start=record.stringOr("StartDate"), end=record.stringOr("EndDate");
        core::TimePoint ignored;
        std::int64_t requested=0,completed=0;
        if (key.empty() || multiple || !result || !result->isObject() || !core::parseDayKey(start,ignored) || !core::parseDayKey(end,ignored) || start>end ||
            !result->boolOr("Available") || !result->find("Rows") || !result->find("Rows")->isArray() || !result->find("Days") || !result->find("Days")->isArray() ||
            !count(*result,"RequestedDays",requested) || !count(*result,"CompletedDays",completed) || requested==0 || requested!=completed ||
            !timestamp(*result,"UpdatedAt") || !timestamp(*result,"EffectiveStart") || !timestamp(*result,"EffectiveEnd"))
        { warn("无法确认应用缓存的网络、查询范围或完成状态，仅保存原文："+ssid); continue; }
        const auto effectiveStart=result->stringOr("EffectiveStart"), effectiveEnd=result->stringOr("EffectiveEnd");
        if (legacyInstant(effectiveStart)>=legacyInstant(effectiveEnd) || legacyInstant(effectiveEnd)>legacyInstant(result->stringOr("UpdatedAt")))
        { warn("应用缓存时间顺序无效，仅保存原文："+ssid); continue; }
        const auto message=result->stringOr("MessageCode");
        if (message!="Available" && message!="Partial" && message!="NoData") { warn("应用缓存查询状态不受支持，仅保存原文："+ssid); continue; }
        for (const auto& day : result->find("Days")->items())
        {
            storage::AppUsageRow row{key,day.stringOr("Date"),day.stringOr("AppId"),day.stringOr("Name"),0,0};
            std::int64_t rx=0,tx=0,total=0;
            // 不把查询当天的部分时间段当成完整日流量。
            const bool wholeDay=(effectiveStart.substr(0,10)<row.day ||
                (effectiveStart.substr(0,10)==row.day && effectiveStart.substr(11,8)=="00:00:00" &&
                 (effectiveStart[19]!='.' || effectiveStart.substr(20,effectiveStart.find_first_of("Z+-",20)-20).find_first_not_of('0')==std::string::npos))) &&
                effectiveEnd.substr(0,10)>row.day;
            if (!core::parseDayKey(row.day,ignored) || row.day<start || row.day>end || !wholeDay || row.appId.empty() || row.appId.size()>1024 || row.name.empty() || row.name.size()>256 ||
                !count(day,"RxBytes",rx) || !count(day,"TxBytes",tx) || !count(day,"TotalBytes",total) ||
                rx>std::numeric_limits<std::int64_t>::max()-tx || rx+tx!=total)
            { warn("应用日记录不完整或不能直接映射，仅保存原文："+ssid+" "+row.day+" "+row.appId); continue; }
            row.rxBytes=static_cast<core::ByteCount>(rx); row.txBytes=static_cast<core::ByteCount>(tx);
            const Identity id{key,row.day,row.appId};
            const auto found=candidates.find(id);
            if (found!=candidates.end() && (found->second.rxBytes!=row.rxBytes || found->second.txBytes!=row.txBytes || found->second.name!=row.name)) ambiguous.insert(id);
            else candidates.emplace(id,row);
        }
    }
    for (const auto& [id,row] : candidates)
    {
        if (ambiguous.count(id)) { warn("重叠缓存中的应用日记录不同，全部保留在原文档案："+row.day+" "+row.appId); continue; }
        auto existing=store.database().prepare("SELECT 1 FROM app_usage WHERE network_key=?1 AND day=?2 AND app_id=?3",status);
        if (!existing) return status;
        if (!existing->bind(1,row.networkKey) || !existing->bind(2,row.day) || !existing->bind(3,row.appId)) return Status::failure(existing->error());
        if (existing->step()) { warn("已有 SQLite 应用日记录，保留当前记录及缓存原文："+row.day+" "+row.appId); continue; }
        if (existing->failed()) return Status::failure(existing->error());
        if (const auto saved=store.usage().setApp(row); !saved) return saved;
        ++imported;
    }
    report.set("appRecordCount",JsonValue::makeInt(imported));
    report.set("appArchivedOnlyCount",JsonValue::makeInt(archived));
    report.set("warnings",std::move(warnings));
    return Status::success();
}

bool exactLedgerBytes(const JsonValue* value, std::int64_t& result, int decimalShift=0)
{
    if (!value || (!value->isString() && !value->isNumber())) return false;
    const auto text=value->isString() ? value->asString() : value->dump();
    static const std::regex decimal(R"(^\+?([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$)");
    std::smatch match;
    if (!std::regex_match(text,match,decimal)) return false;
    std::string digits=match[1].str()+match[2].str();
    int exponent=0;
    if (match[3].matched)
    {
        auto power=match[3].str();
        if (!power.empty() && power.front()=='+') power.erase(0,1);
        const auto parsed=std::from_chars(power.data(),power.data()+power.size(),exponent);
        if (parsed.ec!=std::errc{} || parsed.ptr!=power.data()+power.size() || exponent>1000 || exponent< -1000) return false;
    }
    const auto first=digits.find_first_not_of('0');
    if (first==std::string::npos) { result=0; return true; }
    digits.erase(0,first);
    const auto scale=static_cast<long long>(match[2].length())-exponent-decimalShift;
    if (scale>0)
    {
        if (static_cast<unsigned long long>(scale)>=digits.size()) return false;
        const auto cut=digits.size()-static_cast<std::size_t>(scale);
        if (digits.find_first_not_of('0',cut)!=std::string::npos) return false;
        digits.resize(cut);
    }
    else
    {
        if (digits.size()+static_cast<unsigned long long>(-scale)>19) return false;
        digits.append(static_cast<std::size_t>(-scale),'0');
    }
    const auto parsed=std::from_chars(digits.data(),digits.data()+digits.size(),result);
    return parsed.ec==std::errc{} && parsed.ptr==digits.data()+digits.size() && result>=0;
}

void migrationWarning(JsonValue& report,const std::string& message)
{
    auto warnings=report.find("warnings") ? *report.find("warnings") : JsonValue::makeArray();
    warnings.push(JsonValue::makeString(message));
    report.set("warnings",std::move(warnings));
}

bool parseLegacyQuotaPolicy(const JsonValue& policy,storage::TotalQuotaSettings& result)
{
    if (!policy.isObject()) return false;
    const auto period=policy.stringOr("Period","Month");
    const auto capToken=policy.find("LimitGB") ? *policy.find("LimitGB") : JsonValue::makeInt(0);
    std::string error;
    const auto parsedCap=JsonValue::parse(capToken.isString() ? capToken.asString() : capToken.dump(),error);
    const double cap=parsedCap ? parsedCap->asDouble() : -1;
    std::int64_t exactCap=0;
    double percent=80;
    if (const auto* token=policy.find("WarnPercent"))
    {
        if (!token->isString() && !token->isNumber()) return false;
        const auto text=token->isString() ? token->asString() : token->dump();
        static const std::regex decimal(R"(^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$)");
        if (!std::regex_match(text,decimal)) return false;
        try { percent=std::stod(text); } catch (const std::exception&) { return false; }
        if (!std::isfinite(percent) || percent<1 || percent>100) return false;
    }
    if (!parsedCap || !parsedCap->isNumber() || !std::isfinite(cap) || cap<0 || cap>9000000000.0 ||
        !exactLedgerBytes(&capToken,exactCap,9) || core::bytesOfGigabytes(cap)!=static_cast<core::ByteCount>(exactCap) ||
        (cap>0 && cap<0.000000001) || (period!="Day" && period!="Month" && period!="All") ||
        (policy.has("DisconnectAtLimit") && !policy.find("DisconnectAtLimit")->isBool())) return false;
    result.capGb=cap;
    result.warnPercent=percent;
    result.warnPercents={percent};
    result.period=period=="All" ? core::QuotaPeriod::all : period=="Day" ? core::QuotaPeriod::day : core::QuotaPeriod::month;
    result.notify=cap>0;
    result.autoDisconnect=policy.boolOr("DisconnectAtLimit");
    return true;
}

bool parseLegacyPeriodKey(std::string& key,core::QuotaPeriod& period)
{
    core::TimePoint ignored;
    if (key=="All") { key="all"; period=core::QuotaPeriod::all; return true; }
    if (key.rfind("Day:",0)==0) { key.erase(0,4); period=core::QuotaPeriod::day; return core::parseDayKey(key,ignored); }
    if (key.rfind("Month:",0)==0) { key.erase(0,6); period=core::QuotaPeriod::month; return key.size()==7 && core::parseDayKey(key+"-01",ignored); }
    return false;
}

Status importTotalQuota(storage::Store& store,const JsonValue* settings,const JsonValue& state,
                        bool initial,core::TimePoint now,JsonValue& report)
{
    report.set("totalQuotaApplied",JsonValue::makeBool(false));
    report.set("totalLedgerApplied",JsonValue::makeBool(false));
    const auto* policy=settings ? settings->find("TotalLimit") : nullptr;
    const auto* quota=state.find("QuotaLedger");
    const auto* total=quota ? quota->find("Total") : nullptr;
    if (total && total->isNull()) total=nullptr;
    if (!policy && !total) return Status::success();
    if (!initial)
    {
        migrationWarning(report,"已有 SQLite 总额度配置保持不变，旧总额度及账本仅保留原文。");
        return Status::success();
    }
    storage::TotalQuotaSettings converted;
    if (policy && !parseLegacyQuotaPolicy(*policy,converted))
    {
        migrationWarning(report,"旧总额度策略不能精确转换，总额度及账本仅保留原文，未启用策略。");
        return Status::success();
    }
    storage::TotalQuotaLedger ledger;
    if (total)
    {
        std::int64_t version=0,used=0;
        ledger.periodKey=total->stringOr("PeriodKey");
        if (!count(*quota,"Version",version) || version!=1 || !total->isObject() ||
            !parseLegacyPeriodKey(ledger.periodKey,ledger.period) || !exactLedgerBytes(total->find("UsedBytes"),used))
        {
            migrationWarning(report,"旧总额度账本周期或 UsedBytes 无法精确转换，总额度及账本仅保留原文，未启用策略。");
            return Status::success();
        }
        ledger.usedBytes=static_cast<core::ByteCount>(used);
    }
    // 保存策略时生成其余周期的历史基线，再用旧独立账本替换对应周期。
    if (const auto saved=store.totalQuota().save(converted,now); !saved) return saved;
    if (total)
    {
        Status status;
        auto snapshot=store.totalQuota().load(status);
        if (!status) return status;
        bool found=false;
        for (auto& entry:snapshot.ledgers)
            if (entry.period==ledger.period && entry.periodKey==ledger.periodKey) { entry=ledger; found=true; break; }
        if (!found) snapshot.ledgers.push_back(ledger);
        if (const auto saved=store.totalQuota().save(snapshot); !saved) return saved;
        report.set("totalLedgerApplied",JsonValue::makeBool(true));
    }
    report.set("totalQuotaApplied",JsonValue::makeBool(true));
    return Status::success();
}

Status importNetworkPolicies(storage::Store& store,const JsonValue* settings,const JsonValue& state,
                             const std::map<std::string,std::string>& created,JsonValue& report)
{
    std::int64_t policyCount=0,ledgerCount=0;
    const auto warn=[&](const std::string& text) { migrationWarning(report,text); };
    const auto* policies=settings ? settings->find("Networks") : nullptr;
    if (policies && !policies->isArray()) warn("旧网络偏好 Networks 无效，仅保留原文。");
    else if (policies)
    {
        std::map<std::string,int> occurrences;
        for (const auto& policy:policies->items()) ++occurrences[policy.stringOr("SSID")];
        for (const auto& policy:policies->items())
        {
            const auto ssid=policy.stringOr("SSID");
            const auto key=created.find(ssid);
            if (!policy.find("SSID") || !policy.find("SSID")->isString() || occurrences[ssid]!=1 || key==created.end())
            { warn("网络偏好重复、网络未映射或 SQLite 网络已存在，保留当前设置及原文："+ssid); continue; }
            const auto alias=policy.stringOr("Alias");
            storage::TotalQuotaSettings converted;
            if ((policy.has("Alias") && !policy.find("Alias")->isString()) || alias.size()>320 || !parseLegacyQuotaPolicy(policy,converted))
            { warn("网络偏好无法精确映射，保留默认设置及原文："+ssid); continue; }
            if (const auto saved=store.networks().updateUserSettings(key->second,alias,converted.capGb,converted.warnPercent,converted.period,converted.notify,converted.autoDisconnect,converted.warnPercents); !saved) return saved;
            ++policyCount;
        }
    }
    const auto* quota=state.find("QuotaLedger");
    const auto* ledgers=quota ? quota->find("Networks") : nullptr;
    if (ledgers)
    {
        std::int64_t version=0;
        if (!count(*quota,"Version",version) || version!=1 || !ledgers->isArray()) warn("旧网络额度账本格式或版本无效，仅保留原文。");
        else
        {
            std::map<std::string,int> occurrences;
            for (const auto& ledger:ledgers->items()) ++occurrences[ledger.stringOr("SSID")];
            for (const auto& ledger:ledgers->items())
            {
                const auto ssid=ledger.stringOr("SSID");
                const auto key=created.find(ssid);
                if (!ledger.find("SSID") || !ledger.find("SSID")->isString() || occurrences[ssid]!=1 || key==created.end())
                { warn("网络额度账本重复、网络未映射或 SQLite 网络已存在，保留当前账本及原文："+ssid); continue; }
                std::string period=ledger.stringOr("PeriodKey");
                core::QuotaPeriod convertedPeriod;
                const bool valid=parseLegacyPeriodKey(period,convertedPeriod);
                std::int64_t used=0;
                if (!valid || !exactLedgerBytes(ledger.find("UsedBytes"),used))
                { warn("网络额度账本周期或 UsedBytes 不能精确表示为非负 int64，仅保留原文："+ssid); continue; }
                storage::Status status;
                const auto existing=store.networks().ledger(key->second,status);
                if (!status) return status;
                if (existing) { warn("SQLite 已有网络额度账本，保留当前账本及原文："+ssid); continue; }
                if (const auto saved=store.networks().saveLedger({key->second,period,static_cast<core::ByteCount>(used)}); !saved) return saved;
                ++ledgerCount;
            }
        }
    }
    report.set("networkPolicyCount",JsonValue::makeInt(policyCount));
    report.set("ledgerCount",JsonValue::makeInt(ledgerCount));
    return Status::success();
}

void addReport(JsonValue& result, const std::string& raw)
{
    std::string error;
    const auto report=JsonValue::parse(raw,error);
    if (report && report->isObject()) for (const auto& field : report->fields()) result.set(field.first,field.second);
}

Status canInitializeSettings(storage::Database& db,bool& eligible)
{
    if (const auto initialized=ensureProxySchema(db); !initialized) return initialized;
    Status status;
    auto occupied=db.prepare("SELECT 1 FROM networks UNION ALL SELECT 1 FROM daily_usage UNION ALL SELECT 1 FROM hourly_usage UNION ALL SELECT 1 FROM app_usage UNION ALL SELECT 1 FROM legacy_imports UNION ALL SELECT 1 FROM total_quota_settings WHERE cap_gb!=0 OR warn_percent!=80 OR warn_percents NOT IN ('[]','[80]') OR period!='month' OR notify!=0 OR auto_disconnect!=0 UNION ALL SELECT 1 FROM total_quota_ledgers WHERE used_bytes!=0 OR warning_notified!=0 OR limit_notified!=0 UNION ALL SELECT 1 FROM settings WHERE language!='en' OR unit!='GB' OR speed_unit NOT IN ('MB/s','auto') OR interval_seconds!=5 OR retention_days!=90 OR auto_start!=0 OR minimize_to_tray!=0 OR notifications!=1 UNION ALL SELECT 1 FROM proxy_config LIMIT 1",status);
    if (!occupied) return status;
    eligible=!occupied->step();
    return occupied->failed() ? Status::failure(occupied->error()) : Status::success();
}

void summary(JsonValue& result, const std::string& source, const std::string& state,
             std::int64_t networks = 0, std::int64_t days = 0, const std::string& at = {})
{
    result = JsonValue::makeObject();
    result.set("sourceId", JsonValue::makeString(source));
    result.set("status", JsonValue::makeString(state));
    result.set("networkCount", JsonValue::makeInt(networks));
    result.set("dailyCount", JsonValue::makeInt(days));
    result.set("importedAt", JsonValue::makeString(at));
}
}

Status legacyMigrationStatus(storage::Store& store, const JsonValue& params, JsonValue& result, std::string& code)
{
    code.clear();
    const auto source = params.stringOr("sourceId");
    if (source.empty()) return invalid(code, "sourceId 必须是非空的稳定数据集标识。");
    Status status;
    auto row = store.database().prepare("SELECT network_count, daily_count, imported_at, report_json FROM legacy_imports WHERE source_id = ?1", status);
    if (!row) return status;
    if (!row->bind(1, source)) return Status::failure(row->error());
    if (row->step()) { summary(result, source, "completed", row->columnInt64(0), row->columnInt64(1), row->columnText(2)); addReport(result,row->columnText(3)); }
    else summary(result, source, "notImported");
    if (row->failed()) return Status::failure(row->error());
    bool eligible=false;
    if (const auto checked=canInitializeSettings(store.database(),eligible); !checked) return checked;
    result.set("canInitializeSettings",JsonValue::makeBool(eligible));
    return Status::success();
}

Status importLegacy(storage::Store& store, const JsonValue& params, core::TimePoint now, JsonValue& result, std::string& code)
{
    code.clear();
    const auto source = params.stringOr("sourceId");
    const auto* raw = params.find("stateJson");
    if (source.empty() || !raw || !raw->isString()) return invalid(code, "需要 sourceId 和原始 stateJson 字符串。");
    for (const char* key : {"settingsJson", "appUsageJson"})
        if (params.has(key) && !params.find(key)->isString()) return invalid(code, std::string(key) + " 必须是原始 JSON 字符串。");
    if (params.has("allowInitialSettings") && !params.find("allowInitialSettings")->isBool()) return invalid(code,"allowInitialSettings 必须为布尔值。");
    const auto* policy=params.find("overlapPolicy");
    if (policy && (!policy->isString() || (policy->asString()!="reject" && policy->asString()!="keep-existing")))
        return invalid(code,"overlapPolicy 必须是 reject 或 keep-existing。");
    const bool keepExisting=policy && policy->asString()=="keep-existing";
    const auto text = raw->asString();
    const auto settingsText = params.stringOr("settingsJson");
    const auto appsText = params.stringOr("appUsageJson");
    auto& db = store.database();
    if (const auto initialized=ensureProxySchema(db); !initialized) return initialized;
    storage::Transaction transaction(db);
    if (!transaction.active()) return Status::failure(db.lastError());
    Status status;
    auto previous = db.prepare("SELECT state_json, settings_json, app_usage_json, network_count, daily_count, imported_at, report_json FROM legacy_imports WHERE source_id = ?1", status);
    if (!previous) return status;
    if (!previous->bind(1, source)) return Status::failure(previous->error());
    if (previous->step())
    {
        if (previous->columnText(0) != text || previous->columnText(1) != settingsText || previous->columnText(2) != appsText ||
            previous->columnIsNull(1) == params.has("settingsJson") || previous->columnIsNull(2) == params.has("appUsageJson"))
        {
            code = "LegacySourceChanged";
            return Status::failure("该 sourceId 已导入，但原始内容已变化；拒绝重复计数。请保留旧文件并人工核对。");
        }
        summary(result, source, "completed", previous->columnInt64(3), previous->columnInt64(4), previous->columnText(5));
        addReport(result,previous->columnText(6));
        result.set("alreadyImported", JsonValue::makeBool(true));
        return transaction.commit();
    }
    if (previous->failed()) return Status::failure(previous->error());
    previous.reset();
    const bool allowInitialSettings=params.boolOr("allowInitialSettings");
    if (allowInitialSettings)
    {
        bool eligible=false;
        if (const auto checked=canInitializeSettings(db,eligible); !checked) return checked;
        if (!eligible) { code="LegacyInitialSettingsConflict"; return Status::failure("数据库已有历史或非默认设置，拒绝首次设置迁移。"); }
    }
    auto report=JsonValue::makeObject();
    report.set("skippedDayCount",JsonValue::makeInt(0));
    report.set("settingsApplied",JsonValue::makeBool(false));
    report.set("proxySettingsApplied",JsonValue::makeBool(false));
    report.set("appRecordCount",JsonValue::makeInt(0));
    report.set("appArchivedOnlyCount",JsonValue::makeInt(0));
    report.set("warnings",JsonValue::makeArray());
    std::string error;
    const auto state = parseLegacyJson(text, error);
    std::int64_t version = 0;
    if (!state || !count(*state, "SchemaVersion", version) || version != 1 ||
        !timestamp(*state, "StartedAt") || !timestamp(*state, "UpdatedAt") ||
        !state->find("Networks") || !state->find("Networks")->isArray())
        return invalid(code, "旧版 state.json 格式、版本或时间无效。" + error);
    std::optional<JsonValue> settings;
    if (params.has("settingsJson"))
    {
        settings = parseLegacyJson(settingsText, error);
        if (!settings || !settings->isObject()) return invalid(code, "settingsJson 必须包含有效 JSON 对象。");
    }
    std::optional<JsonValue> apps;
    if (params.has("appUsageJson"))
    {
        apps = parseLegacyJson(appsText, error);
        if (!apps || !apps->isObject()) return invalid(code, "appUsageJson 必须包含有效 JSON 对象。");
    }
    auto existing = store.networks().all(status);
    if (!status) return status;
    std::set<std::string> names;
    std::map<std::string,std::string> createdNetworks;
    std::int64_t days = 0;
    for (const auto& network : state->find("Networks")->items())
    {
        const auto* ssidValue = network.find("SSID");
        const auto ssid = network.stringOr("SSID");
        std::int64_t rx = 0, tx = 0;
        if (!ssidValue || !ssidValue->isString() || !names.insert(ssid).second ||
            !count(network, "RxBytes", rx) || !count(network, "TxBytes", tx) ||
            !timestamp(network, "FirstSeen") || !timestamp(network, "LastSeen") ||
            !network.find("Days") || !network.find("Days")->isArray())
            return invalid(code, "旧版网络名称、累计值或每日记录无效。");
        const std::string type = ssid.rfind("Ethernet:", 0) == 0 ? "ethernet" : "wifi";
        std::string key;
        for (const auto& record : existing)
            if (record.ssid == ssid && record.type == type)
            {
                if (!key.empty()) { code = "LegacyOverlap"; return Status::failure("相同 SSID 存在多个网络 key，无法无损分辨：" + ssid); }
                key = record.key;
            }
        if (key.empty())
        {
            key = ssid.empty() ? "legacy_empty_ssid" : (type == "ethernet" ? "ethernet_" : "") + core::fallbackKeyForSsid(ssid);
            for (const auto& record : existing)
                if (record.key == key) { code = "LegacyOverlap"; return Status::failure("网络 key 冲突：" + ssid); }
            status = execute(db, "INSERT INTO networks(key,ssid,type,first_seen_at,last_seen_at) VALUES(?1,?2,?3,?4,?5)",
                {key, ssid, type, network.stringOr("FirstSeen"), network.stringOr("LastSeen")});
            if (!status) return status;
            createdNetworks.emplace(ssid,key);
            storage::NetworkRecord added; added.key = key; added.ssid = ssid; added.type = type; existing.push_back(added);
        }
        auto mapping = db.prepare("SELECT network_key FROM legacy_network_keys WHERE ssid=?1", status);
        if (!mapping) return status;
        if (!mapping->bind(1, ssid)) return Status::failure(mapping->error());
        if (mapping->step())
        {
            if (mapping->columnText(0) != key) { code = "LegacyOverlap"; return Status::failure("SSID 映射已变化。"); }
        }
        else
        {
            if (mapping->failed()) return Status::failure(mapping->error());
            status = execute(db, "INSERT INTO legacy_network_keys(ssid,network_key) VALUES(?1,?2)", {ssid,key});
            if (!status) return status;
        }
        std::int64_t sumRx = 0, sumTx = 0;
        std::set<std::string> dates;
        for (const auto& day : network.find("Days")->items())
        {
            const auto date = day.stringOr("Date");
            core::TimePoint ignored;
            std::int64_t dayRx = 0, dayTx = 0;
            if (!core::parseDayKey(date, ignored) || !dates.insert(date).second ||
                !count(day, "RxBytes", dayRx) || !count(day, "TxBytes", dayTx) ||
                dayRx > std::numeric_limits<std::int64_t>::max() - sumRx || dayTx > std::numeric_limits<std::int64_t>::max() - sumTx)
                return invalid(code, "每日日期、字节数无效或累计值超出 64 位范围。");
            sumRx += dayRx; sumTx += dayTx;
            auto overlap = db.prepare("SELECT 1 FROM daily_usage WHERE network_key=?1 AND day=?2 UNION ALL SELECT 1 FROM hourly_usage WHERE network_key=?1 AND day=?2 LIMIT 1", status);
            if (!overlap) return status;
            if (!overlap->bind(1,key) || !overlap->bind(2,date)) return Status::failure(overlap->error());
            if (overlap->step())
            {
                if (!keepExisting) { code = "LegacyOverlap"; return Status::failure("已有相同网络日期的数据，无法无损分辨，已取消整个导入：" + ssid + " " + date); }
                report.set("skippedDayCount",JsonValue::makeInt(report.intOr("skippedDayCount")+1));
                migrationWarning(report,"已有 SQLite 网络日期记录，保留现有每日及小时数据，跳过旧日记录并保留原文："+ssid+" "+date);
                // 上方已累计旧日记录；跳过写入仍须通过整份旧网络累计校验。
                continue;
            }
            if (overlap->failed()) return Status::failure(overlap->error());
            auto insert = db.prepare("INSERT INTO daily_usage(network_key,day,rx_bytes,tx_bytes) VALUES(?1,?2,?3,?4)", status);
            if (!insert) return status;
            if (!insert->bind(1,key) || !insert->bind(2,date) || !insert->bind(3,dayRx) || !insert->bind(4,dayTx)) return Status::failure(insert->error());
            if (const auto saved = insert->run(); !saved) return saved;
            ++days;
        }
        if (rx != sumRx || tx != sumTx) return invalid(code, "旧累计总额与每日记录不一致，已取消整个导入：" + ssid);
    }
    if (apps)
    {
        if (const auto imported=importCachedDays(store,*apps,report); !imported) return imported;
    }
    if (const auto imported=importNetworkPolicies(store,settings ? &*settings : nullptr,*state,createdNetworks,report); !imported) return imported;
    if (const auto imported=importTotalQuota(store,settings ? &*settings : nullptr,*state,allowInitialSettings,now,report); !imported) return imported;
    if (!settings && allowInitialSettings) settings=JsonValue::makeObject();
    // 原文始终保留；已有设置只允许在调用方明确标记首次创建数据库时初始化。
    if (settings)
    {
        auto row = db.prepare("SELECT 1 FROM settings WHERE id=1", status);
        if (!row) return status;
        const bool exists = row->step();
        if (row->failed()) return Status::failure(row->error());
        if (!exists || allowInitialSettings)
        {
            storage::SettingsRecord value;
            value.language = settings->stringOr("Language", "en");
            std::int64_t retention = 0;
            if (settings->has("RetentionDays") && (!count(*settings, "RetentionDays", retention) || retention > 36500))
                return invalid(code, "RetentionDays 超出 0..36500。");
            if (value.language != "en" && value.language != "zh-CN") return invalid(code, "Language 无效。");
            value.retentionDays = static_cast<int>(retention);
            if (const auto saved = store.settings().save(value); !saved) return saved;
            report.set("settingsApplied",JsonValue::makeBool(true));
        }
    }
    if (settings && allowInitialSettings && settings->has("Proxy"))
    {
        const auto& legacy=*settings->find("Proxy");
        if (!legacy.isObject()) return invalid(code,"旧 Proxy 必须是对象。");
        auto value=JsonValue::makeObject();
        if (const auto* ports=legacy.find("Ports")) value.set("ports",*ports);
        if (const auto* processNames=legacy.find("ProcessNames")) value.set("processNames",*processNames);
        platform::ProxyOptions options;
        if (const auto valid=validateProxyOptions(value,options); !valid) return invalid(code,valid.message);
        // 首次设置资格已在事务开始时检查；保存与原始网络、账本和导入档案一起提交。
        if (const auto saved=saveProxyOptions(db,options); !saved) return saved;
        report.set("proxySettingsApplied",JsonValue::makeBool(true));
    }
    const auto at = core::isoUtcOf(now);
    auto archive = db.prepare("INSERT INTO legacy_imports(source_id,state_json,settings_json,app_usage_json,imported_at,network_count,daily_count,report_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", status);
    if (!archive) return status;
    if (!archive->bind(1,source) || !archive->bind(2,text) ||
        !(params.has("settingsJson") ? archive->bind(3,settingsText) : archive->bindNull(3)) ||
        !(params.has("appUsageJson") ? archive->bind(4,appsText) : archive->bindNull(4)) ||
        !archive->bind(5,at) || !archive->bind(6,static_cast<std::int64_t>(names.size())) || !archive->bind(7,days) || !archive->bind(8,report.dump()))
        return Status::failure(archive->error());
    if (const auto saved = archive->run(); !saved) return saved;
    if (const auto committed = transaction.commit(); !committed) return committed;
    summary(result,source,"completed",static_cast<std::int64_t>(names.size()),days,at);
    addReport(result,report.dump());
    result.set("alreadyImported",JsonValue::makeBool(false));
    return Status::success();
}

Status mapLegacyNetworks(storage::Database& db, platform::SampleReport& report)
{
    Status status;
    auto rows = db.prepare("SELECT m.ssid, m.network_key, COALESCE(n.type, CASE WHEN substr(m.ssid,1,9)='Ethernet:' THEN 'ethernet' ELSE 'wifi' END) FROM legacy_network_keys m LEFT JOIN networks n ON m.network_key=n.key", status);
    if (!rows) return status;
    std::map<std::pair<std::string,std::string>,std::string> keys;
    while (rows->step()) keys.emplace(std::make_pair(rows->columnText(0),rows->columnText(2)),rows->columnText(1));
    if (rows->failed()) return Status::failure(rows->error());
    const auto map = [&](platform::NetworkIdentity& identity) {
        if (!identity.ssid) return;
        const auto found = keys.find({*identity.ssid,identity.type});
        if (found != keys.end()) identity.profileUuid = found->second;
    };
    for (auto& sample : report.samples) map(sample.identity);
    for (auto& link : report.links) map(link.identity);
    return Status::success();
}
}
