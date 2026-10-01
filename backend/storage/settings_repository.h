#pragma once

// 偏好设置仓储：整个应用只有一行设置。

#include <string>

#include "database.h"

namespace wifimeter::storage
{

enum class DisplayUnit
{
    gb,   // 10^9 字节
    gib,  // 2^30 字节
};

enum class SpeedUnit
{
    megabytesPerSecond,  // MB/s，字节速率
    megabitsPerSecond,   // Mbps，比特速率
};

struct SettingsRecord
{
    std::string language = "en";
    DisplayUnit unit = DisplayUnit::gb;
    SpeedUnit speedUnit = SpeedUnit::megabytesPerSecond;
    int intervalSeconds = 5;
    int retentionDays = 90;  // 0 表示长期保留
    bool autoStart = false;
    bool minimizeToTray = false;
    bool notifications = true;
};

class SettingsRepository
{
public:
    explicit SettingsRepository(Database& database)
        : database_(database)
    {}

    // 读取设置；没有记录时返回默认值（并写入，保证只有一行）。
    SettingsRecord load(Status& status);
    Status save(const SettingsRecord& settings);

    // 取值合法性：非法值回退到默认，避免坏数据一路传到界面。
    static SettingsRecord sanitize(SettingsRecord settings);

private:
    Database& database_;
};

}  // namespace wifimeter::storage
