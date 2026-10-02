# Data migration and recovery / 数据迁移与恢复

## Importing the file-based Windows version

Close the previous collector, then start the new application. The default source is `%LOCALAPPDATA%\WiFiMeter\data`. For a portable or custom source directory, open Settings > Data & migration and use the legacy-directory import action. The source must contain `state.json` or its recoverable `state.json.bak`.

The importer reads source files without modifying them. It saves the original documents and a pre-import database backup under the new profile's `migration-backups` directory before committing imported records. A locked old collector or invalid data stops the import. Overlapping network/day records are rejected by default. When automatic import encounters overlapping dates in an existing SQLite database, current traffic collection continues and the conflict remains available under Settings > Data & migration for manual resolution. During a manual import, you can explicitly choose to retain existing dates and import only non-conflicting dates. The report lists skipped dates; neither their bytes nor their quota counters are added again. The database transaction prevents a half-imported dataset.

Bytes are parsed by C++ as exact decimal integers rather than JavaScript floating-point numbers. Repeating the same source import is idempotent. A source that changed after its successful import is reported for reconciliation instead of being added a second time. An existing SQLite profile is not replaced by a legacy import.

Network notes, eligible quota policies and independent quota counters are mapped to their new equivalents. Original settings and cache documents remain in the migration archive. Application-cache entries that cannot be assigned unambiguously to a complete day are preserved as archived source data and listed in the report; they are not presented as complete native-capture history.

The old JSON directory is a retained copy, not a second live database. New samples are written to SQLite only. Reopening the old release shows the old directory's records, not samples subsequently collected by the new application.

## Backups

A complete backup includes network records, hourly data, application history, coverage gaps, settings, quota ledgers and migration archives. Proxy configuration and observations are included when present. Restoring is an intentional replacement of the current dataset and leaves sampling paused. Invalid input rolls back rather than partially replacing existing records. A usage-only CSV or JSON export is not a complete backup.

The application retains the cross-platform profile location. The Windows profile is `%APPDATA%\WiFiMeter Demo`; Linux retains its existing Electron profile. Keep these directories when reinstalling. Backups and import reports can contain network names and local paths; they are private user data and must not be committed or attached to public issues without review.

## 导入旧 Windows 文件版

先退出旧采集器，再启动新版。默认读取 `%LOCALAPPDATA%\WiFiMeter\data`；便携版或自定义目录可在设置中选择。目录需要包含 `state.json`，或可恢复的 `state.json.bak`。

导入只读取原文件，不修改原目录。提交新记录前，程序会在新配置目录的 `migration-backups` 中保存原文及迁移前数据库备份。旧采集器占用、数据无效或同一网络日期发生冲突时会停止导入，数据库事务避免只写入一半。

字节数由 C++ 按精确十进制整数解析，不经过 JavaScript 浮点转换。重复导入同一来源不会重复累计。成功导入后若原来源又有变化，会提示核对，避免再次相加。已有 SQLite 配置不会被旧目录直接覆盖。

网络备注、可转换的额度策略及独立额度账本会映射到新格式。原设置和缓存原文仍保存在迁移档案中。无法确定完整日期或归属的应用缓存会在报告中列出并保留原文，不会伪装成完整的原生应用采集历史。

原 JSON 目录只作为保留副本，新采集记录写入 SQLite，不会继续同步回旧目录。重新运行旧版时，看到的是旧目录中的记录，不包含新版随后采集的数据。

## 备份与恢复

完整备份包含网络记录、小时明细、应用历史、缺失区间、设置、额度账本和迁移档案；有代理配置及观测时也会包含它们。恢复会替换当前数据，并暂停采集。无效输入会回滚，不会只替换部分记录。只导出用量的 CSV 或 JSON 不能当作完整备份恢复。

Windows 配置目录仍为 `%APPDATA%\WiFiMeter Demo`，Linux 沿用已有的 Electron 配置目录，重新安装时请保留。备份和导入报告可能包含网络名及本地路径，属于用户私有数据，不应直接提交到仓库或附在公开 issue 中。
