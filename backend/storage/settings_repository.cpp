#include "settings_repository.h"

#include <algorithm>

namespace wifimeter::storage
{
namespace
{

const char* kUnitName(DisplayUnit unit)
{
    return unit == DisplayUnit::gib ? "GiB" : "GB";
}

const char* kSpeedUnitName(SpeedUnit unit)
{
    return unit == SpeedUnit::megabitsPerSecond ? "Mbps" : "MB/s";
}

}  // namespace

SettingsRecord SettingsRepository::sanitize(SettingsRecord settings)
{
    // 与 apps/desktop/renderer/data/model.js 的校验范围保持一致：
    // 采样间隔只允许 2/5/10 秒，保留期只允许 0/30/90/365 天。
    if (settings.intervalSeconds != 2 && settings.intervalSeconds != 5 && settings.intervalSeconds != 10)
        settings.intervalSeconds = 5;
    if (settings.retentionDays != 0 && settings.retentionDays != 30 && settings.retentionDays != 90 && settings.retentionDays != 365)
        settings.retentionDays = 90;
    return settings;
}

SettingsRecord SettingsRepository::load(Status& status)
{
    SettingsRecord settings;
    auto statement = database_.prepare("SELECT unit, speed_unit, interval_seconds, retention_days, auto_start, minimize_to_tray, notifications FROM settings WHERE id = 1;", status);
    if (!statement)
        return settings;

    if (statement->step())
    {
        settings.unit = statement->columnText(0) == "GiB" ? DisplayUnit::gib : DisplayUnit::gb;
        settings.speedUnit = statement->columnText(1) == "Mbps" ? SpeedUnit::megabitsPerSecond : SpeedUnit::megabytesPerSecond;
        settings.intervalSeconds = static_cast<int>(statement->columnInt64(2));
        settings.retentionDays = static_cast<int>(statement->columnInt64(3));
        settings.autoStart = statement->columnInt64(4) != 0;
        settings.minimizeToTray = statement->columnInt64(5) != 0;
        settings.notifications = statement->columnInt64(6) != 0;
        status = Status::success();
        return sanitize(settings);
    }
    if (statement->failed())
    {
        status = Status::failure(statement->error());
        return settings;
    }

    // 首次运行时写入默认值，之后始终只有这一行。
    const Status saved = save(settings);
    status = saved;
    return saved ? settings : SettingsRecord{};
}

Status SettingsRepository::save(const SettingsRecord& settings)
{
    const SettingsRecord clean = sanitize(settings);
    Status status;
    auto statement = database_.prepare(
        "INSERT INTO settings(id, unit, speed_unit, interval_seconds, retention_days, auto_start, minimize_to_tray, notifications) "
        "VALUES(1, ?1, ?2, ?3, ?4, ?5, ?6, ?7) "
        "ON CONFLICT(id) DO UPDATE SET unit = excluded.unit, speed_unit = excluded.speed_unit, interval_seconds = excluded.interval_seconds, "
        "retention_days = excluded.retention_days, auto_start = excluded.auto_start, minimize_to_tray = excluded.minimize_to_tray, notifications = excluded.notifications;",
        status);
    if (!statement)
        return status;
    if (!statement->bind(1, std::string(kUnitName(clean.unit))) || !statement->bind(2, std::string(kSpeedUnitName(clean.speedUnit))) || !statement->bind(3, static_cast<std::int64_t>(clean.intervalSeconds)) || !statement->bind(4, static_cast<std::int64_t>(clean.retentionDays)) ||
        !statement->bind(5, static_cast<std::int64_t>(clean.autoStart ? 1 : 0)) || !statement->bind(6, static_cast<std::int64_t>(clean.minimizeToTray ? 1 : 0)) || !statement->bind(7, static_cast<std::int64_t>(clean.notifications ? 1 : 0)))
        return Status::failure(statement->error());
    return statement->run();
}

}  // namespace wifimeter::storage
