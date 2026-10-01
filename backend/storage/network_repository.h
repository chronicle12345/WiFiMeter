#pragma once

// 网络与额度账本仓储。
//
// 网络条目有两个来源：采集器“见过”它就登记一条（ssid、最近出现时间），用户在界面上
// 补充的备注与额度则由用户设置维护。两者分开更新，避免采集刷新把用户设置覆盖掉。

#include <optional>
#include <string>
#include <vector>

#include "../core/byte_count.h"
#include "../core/network_key.h"
#include "../core/quota.h"
#include "database.h"

namespace wifimeter::storage
{

struct NetworkRecord
{
    std::string key;
    std::string ssid;
    std::string alias;
    std::string type = "wifi";
    double capGb = 0.0;
    double warnPercent = 80;
    core::QuotaPeriod quotaPeriod = core::QuotaPeriod::month;
    bool notify = false;
    bool autoDisconnect = false;
    std::string firstSeenAt;  // ISO8601，可为空
    std::string lastSeenAt;
};

struct QuotaLedgerRecord
{
    std::string networkKey;
    std::string periodKey;
    core::ByteCount usedBytes = 0;
};

class NetworkRepository
{
public:
    explicit NetworkRepository(Database& database)
        : database_(database)
    {}

    // 采集到某个网络时登记：不存在则新建，存在则只更新 ssid 与最近出现时间，
    // 保留用户设置与首次出现时间。created 表示本次是否新建。
    Status observe(const core::NetworkRef& network, const std::string& seenAtIso, bool& created);

    std::vector<NetworkRecord> all(Status& status) const;
    std::optional<NetworkRecord> find(const std::string& key, Status& status) const;

    // 用户可改的部分。alias 允许为空（回退到 ssid 显示）。
    Status updateUserSettings(const std::string& key, const std::string& alias, double capGb, double warnPercent, core::QuotaPeriod period, bool notify, bool autoDisconnect);

    Status remove(const std::string& key);

    // 整条写入（含首次与最近出现时间），用于恢复备份；不会清掉其他网络。
    Status replace(const NetworkRecord& record);

    // 删除全部网络，恢复备份前先清空。
    Status removeAll();

    std::optional<QuotaLedgerRecord> ledger(const std::string& key, Status& status) const;
    std::vector<QuotaLedgerRecord> allLedgers(Status& status) const;
    Status saveLedger(const QuotaLedgerRecord& record);
    Status clearLedger(const std::string& key);

private:
    Database& database_;
};

}  // namespace wifimeter::storage
