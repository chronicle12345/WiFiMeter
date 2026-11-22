#include "settings_repository.h"

#include <algorithm>
#include <cmath>

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
    if (unit == SpeedUnit::automatic) return "auto";
    return unit == SpeedUnit::megabitsPerSecond ? "Mbps" : "MB/s";
}

}  // namespace

SettingsRecord SettingsRepository::sanitize(SettingsRecord settings)
{
    // 与 apps/desktop/renderer/data/model.js 的校验范围保持一致：
    // 采样间隔允许 0.25..3600 秒，最多三位小数；保留期允许 0..36500 天。
    if (!validIntervalSeconds(settings.intervalSeconds))
        settings.intervalSeconds = 5;
    else settings.intervalSeconds = std::round(settings.intervalSeconds * 1000.0) / 1000.0;
    if (settings.retentionDays < 0 || settings.retentionDays > 36500)
        settings.retentionDays = 90;
    if (settings.language != "en" && settings.language != "zh-CN") settings.language = "en";
    return settings;
}

bool SettingsRepository::validIntervalSeconds(double seconds)
{
    return std::isfinite(seconds) && seconds >= 0.25 && seconds <= 3600.0 &&
        std::abs(seconds * 1000.0 - std::round(seconds * 1000.0)) < 0.000001;
}

SettingsRecord SettingsRepository::load(Status& status)
{
    SettingsRecord settings;
    auto statement = database_.prepare("SELECT unit, speed_unit, interval_seconds, retention_days, auto_start, minimize_to_tray, notifications, language FROM settings WHERE id = 1;", status);
    if (!statement)
        return settings;

    if (statement->step())
    {
        settings.unit = statement->columnText(0) == "GiB" ? DisplayUnit::gib : DisplayUnit::gb;
        const auto speedUnit = statement->columnText(1);
        settings.speedUnit = speedUnit == "auto" ? SpeedUnit::automatic :
            speedUnit == "Mbps" ? SpeedUnit::megabitsPerSecond : SpeedUnit::megabytesPerSecond;
        settings.intervalSeconds = statement->columnDouble(2);
        settings.retentionDays = static_cast<int>(statement->columnInt64(3));
        settings.autoStart = statement->columnInt64(4) != 0;
        settings.minimizeToTray = statement->columnInt64(5) != 0;
        settings.notifications = statement->columnInt64(6) != 0;
        settings.language = statement->columnText(7);
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
        "INSERT INTO settings(id, unit, speed_unit, interval_seconds, retention_days, auto_start, minimize_to_tray, notifications, language) "
        "VALUES(1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) "
        "ON CONFLICT(id) DO UPDATE SET unit = excluded.unit, speed_unit = excluded.speed_unit, interval_seconds = excluded.interval_seconds, "
        "retention_days = excluded.retention_days, auto_start = excluded.auto_start, minimize_to_tray = excluded.minimize_to_tray, notifications = excluded.notifications, language = excluded.language;",
        status);
    if (!statement)
        return status;
    if (!statement->bind(1, std::string(kUnitName(clean.unit))) || !statement->bind(2, std::string(kSpeedUnitName(clean.speedUnit))) || !statement->bind(3, clean.intervalSeconds) || !statement->bind(4, static_cast<std::int64_t>(clean.retentionDays)) ||
        !statement->bind(5, static_cast<std::int64_t>(clean.autoStart ? 1 : 0)) || !statement->bind(6, static_cast<std::int64_t>(clean.minimizeToTray ? 1 : 0)) || !statement->bind(7, static_cast<std::int64_t>(clean.notifications ? 1 : 0)))
        return Status::failure(statement->error());
    if (!statement->bind(8, clean.language)) return Status::failure(statement->error());
    return statement->run();
}

}  // namespace wifimeter::storage
