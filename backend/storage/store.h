#pragma once

// 存储门面：打开数据库、暴露各仓储，并把累计器的输出落库。
//
// 采集循环只需要调用 applyUsage：增量进每日/小时记录与额度账本，需要留痕的事件
// 变成覆盖空档，整体在一个事务里完成，避免只写了一半。

#include <chrono>
#include <cstddef>
#include <memory>
#include <string>
#include <vector>

#include "../core/network_key.h"
#include "../core/quota.h"
#include "../core/usage_accumulator.h"
#include "database.h"
#include "network_repository.h"
#include "settings_repository.h"
#include "usage_repository.h"

namespace wifimeter::storage
{

struct ApplySummary
{
    std::size_t recordedNetworks = 0;        // 本次写入用量的网络数
    std::size_t gapsRecorded = 0;            // 本次记录的覆盖空档数
    std::vector<std::string> rolledPeriods;  // 发生额度周期滚动的网络键
};

class Store
{
public:
    // 打开（必要时创建并迁移）数据库。
    static std::unique_ptr<Store> open(const std::string& path, Status& status);

    Store(const Store&) = delete;
    Store& operator=(const Store&) = delete;

    Database& database()
    {
        return *database_;
    }
    UsageRepository& usage()
    {
        return usage_;
    }
    NetworkRepository& networks()
    {
        return networks_;
    }
    SettingsRepository& settings()
    {
        return settings_;
    }

    // 把一次采样的累计结果写入数据库。
    Status applyUsage(const core::AccumulateResult& result, core::TimePoint now, ApplySummary& summary);

    // 按偏好设置里的保留期裁剪历史；retentionDays 为 0 表示长期保留。
    Status pruneByRetention(core::TimePoint now, std::size_t& removedDaily, std::size_t& removedHourly);

    // 清空用量记录并重置账本，保留网络与偏好。
    Status clearUsage();

    // 采集恢复时闭合未结束的覆盖空档。
    Status closeOpenGaps(core::TimePoint now, std::size_t& closed);

    // 备份数据库文件（含 WAL 中尚未合并的内容）。
    Status backupTo(const std::string& path) const;

private:
    explicit Store(std::unique_ptr<Database> database);

    std::unique_ptr<Database> database_;
    UsageRepository usage_;
    NetworkRepository networks_;
    SettingsRepository settings_;
};

// 把累计事件映射为覆盖空档的原因。
std::optional<CoverageReason> coverageReasonOf(core::CounterEventKind kind);

}  // namespace wifimeter::storage
