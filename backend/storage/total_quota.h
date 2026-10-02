#pragma once

#include <optional>
#include <string>
#include <vector>

#include "../core/quota.h"
#include "../core/usage_accumulator.h"
#include "database.h"

namespace wifimeter::storage
{

struct TotalQuotaSettings
{
    double capGb = 0.0;  // 0 为不限量；合法范围 0..9e9 GB，正额度至少折算为 1 字节。
    double warnPercent = 80;
    core::QuotaPeriod period = core::QuotaPeriod::month;
    bool notify = false;
    bool autoDisconnect = false;
    std::vector<double> warnPercents = {};
};

struct TotalQuotaLedger
{
    core::QuotaPeriod period = core::QuotaPeriod::month;
    std::string periodKey;
    core::ByteCount usedBytes = 0;
    bool warningNotified = false;
    bool limitNotified = false;
    std::vector<double> notifiedWarnPercents = {};
};

// JSON 备份由调用者转换；保留所有周期账本，恢复后切换周期也不依赖已裁剪的历史。
struct TotalQuotaSnapshot
{
    TotalQuotaSettings settings;
    std::vector<TotalQuotaLedger> ledgers;
};

struct TotalQuotaView
{
    TotalQuotaSettings settings;
    TotalQuotaLedger ledger;
    core::QuotaState quota;
    bool warningPending = false;
    bool limitPending = false;
};

enum class TotalQuotaNotification { warning, limit };

class TotalQuotaRepository
{
public:
    explicit TotalQuotaRepository(Database& database) : database_(database) {}

    // Store::open 调用。幂等建表，不修改 PRAGMA user_version。
    Status ensureSchema();
    TotalQuotaView current(core::TimePoint now, Status& status);
    TotalQuotaSnapshot load(Status& status) const;

    // 首次从对应历史初始化，已有账本保留；修改 capGb 重置通知标志，修改提醒档位保留已提醒档位。
    // 使用 SAVEPOINT，可独立调用，也可加入调用者的事务。
    Status save(const TotalQuotaSettings& settings, core::TimePoint now);
    // 恢复时原样替换总额度设置及全部账本；历史用量由调用者在同一外层事务内恢复。
    Status save(const TotalQuotaSnapshot& snapshot);

    // 条件更新持久标志；marked=false 表示已标记、未到阈值或当前策略不适用。
    // 调用方只在 marked=true 时发出对应事件；发送与数据库提交不构成分布式事务。
    Status markNotified(core::QuotaPeriod period, const std::string& periodKey, TotalQuotaNotification notification, bool& marked, double threshold = 0);

private:
    friend class Store;
    // 必须在 Store 的用量事务内、usage.add 之前调用，避免历史初始化重复计入本次增量。
    Status addUsage(const core::UsageDelta& delta);
    Status clearUsage();
    Status ensurePeriods(core::TimePoint now);
    TotalQuotaSettings readSettings(Status& status) const;
    Status writeSettings(const TotalQuotaSettings& settings);
    std::optional<TotalQuotaLedger> readLedger(core::QuotaPeriod period, const std::string& key, Status& status) const;
    Status writeLedger(const TotalQuotaLedger& ledger);

    Database& database_;
};

}  // namespace wifimeter::storage
