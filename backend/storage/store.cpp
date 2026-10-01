#include "store.h"

#include <utility>

namespace wifimeter::storage
{

std::optional<CoverageReason> coverageReasonOf(core::CounterEventKind kind)
{
    switch (kind)
    {
        case core::CounterEventKind::counterReset:
            return CoverageReason::counterReset;
        case core::CounterEventKind::reattributed:
            return CoverageReason::reattributed;
        case core::CounterEventKind::detached:
            return CoverageReason::detached;
        case core::CounterEventKind::baseline:
            break;  // 首次建立基线不算缺口
    }
    return std::nullopt;
}

Store::Store(std::unique_ptr<Database> database)
    : database_(std::move(database)),
      usage_(*database_),
      networks_(*database_),
      settings_(*database_),
      totalQuota_(*database_)
{}

std::unique_ptr<Store> Store::open(const std::string& path, Status& status)
{
    auto database = Database::open(path, status);
    if (!database)
        return nullptr;

    auto store = std::unique_ptr<Store>(new Store(std::make_unique<Database>(std::move(*database))));
    // 保证 settings 始终有一行，后续读取不必处理“还没有设置”的情况。
    store->settings().load(status);
    if (!status)
        return nullptr;
    status = store->totalQuota().ensureSchema();
    if (!status) return nullptr;
    return store;
}

Status Store::applyUsage(const core::AccumulateResult& result, core::TimePoint now, ApplySummary& summary)
{
    summary = ApplySummary{};
    if (result.deltas.empty() && result.events.empty())
        return Status::success();

    const std::string seenAt = core::isoUtcOf(now);
    Transaction transaction(database());
    if (!transaction.active()) return Status::failure(database().lastError());

    for (const core::UsageDelta& delta : result.deltas)
    {
        bool created = false;
        if (const Status observed = networks_.observe(delta.network, seenAt, created); !observed)
            return observed;

        if (const Status total = totalQuota_.addUsage(delta); !total)
            return total;

        if (const Status added = usage_.add(delta.network, core::localStampOf(delta.at), delta.rxBytes, delta.txBytes); !added)
            return added;

        // 额度账本按网络自己的周期滚动。
        Status findStatus;
        const auto record = networks_.find(delta.network.key, findStatus);
        if (!findStatus)
            return findStatus;

        core::QuotaSettings quotaSettings;
        if (record)
        {
            quotaSettings.capGb = record->capGb;
            quotaSettings.warnPercent = record->warnPercent;
            quotaSettings.period = record->quotaPeriod;
        }

        Status ledgerStatus;
        const auto stored = networks_.ledger(delta.network.key, ledgerStatus);
        if (!ledgerStatus)
            return ledgerStatus;

        core::QuotaLedger ledger;
        if (stored)
        {
            ledger.periodKey = stored->periodKey;
            ledger.usedBytes = stored->usedBytes;
        }
        const bool rolled = core::addToLedger(ledger, quotaSettings, delta.rxBytes + delta.txBytes, delta.at);
        if (rolled)
            summary.rolledPeriods.push_back(delta.network.key);

        if (const Status saved = networks_.saveLedger(QuotaLedgerRecord{delta.network.key, ledger.periodKey, ledger.usedBytes}); !saved)
            return saved;

        ++summary.recordedNetworks;
    }

    for (const core::CounterEvent& event : result.events)
    {
        const auto reason = coverageReasonOf(event.kind);
        if (!reason)
            continue;
        CoverageGap gap;
        gap.networkKey = event.network.key;
        gap.reason = *reason;
        gap.span = event.span;
        gap.startedAt = now - event.span;
        gap.endedAt = now;
        if (const Status added = usage_.addGap(gap); !added)
            return added;
        ++summary.gapsRecorded;
    }

    return transaction.commit();
}

Status Store::pruneByRetention(core::TimePoint now, std::size_t& removedDaily, std::size_t& removedHourly)
{
    removedDaily = 0;
    removedHourly = 0;

    Status status;
    const SettingsRecord settings = settings_.load(status);
    if (!status)
        return status;
    if (settings.retentionDays <= 0)
        return Status::success();

    // 保留期含当天：cutoff = 今天 - (retentionDays - 1)，按本地日期做减法，
    // 由 mktime 处理月份、年份与夏令时。
    const std::string cutoff = core::dayKeyOf(core::shiftLocalDays(core::localStampOf(now), -(settings.retentionDays - 1)));
    Transaction transaction(database());
    if (const Status pruned = usage_.pruneBefore(cutoff, removedDaily, removedHourly); !pruned)
        return pruned;
    return transaction.commit();
}

Status Store::clearUsage()
{
    Transaction transaction(database());
    if (!transaction.active()) return Status::failure(database().lastError());
    if (const Status cleared = totalQuota_.clearUsage(); !cleared)
        return cleared;
    if (const Status cleared = usage_.clearUsage(); !cleared)
        return cleared;
    return transaction.commit();
}

Status Store::closeOpenGaps(core::TimePoint now, std::size_t& closed)
{
    return usage_.closeOpenGaps(now, closed);
}

Status Store::backupTo(const std::string& path) const
{
    return database_->backupTo(path);
}

}  // namespace wifimeter::storage
