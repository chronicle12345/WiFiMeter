# Data migration and recovery / 数据迁移与恢复

## Importing the file-based Windows version

Close the previous collector, then start the new application. The default source is `%LOCALAPPDATA%\WiFiMeter\data`. For a portable or custom source directory, open Settings > Data & migration and use the legacy-directory import action. The source must contain `state.json` or its recoverable `state.json.bak`.

The importer reads source files without modifying them. It saves the original documents and a pre-import database backup under the new profile's `migration-backups` directory before committing imported records. A locked old collector or invalid data stops the import. Overlapping network/day records are rejected by default. When automatic import encounters overlapping dates in an existing SQLite database, current traffic collection continues and the conflict remains available under Settings > Data & migration for manual resolution. During a manual import, you can explicitly choose to retain existing dates and import only non-conflicting dates. The report lists skipped dates; neither their bytes nor their quota counters are added again. The database transaction prevents a half-imported dataset.

Bytes are parsed by C++ as exact decimal integers rather than JavaScript floating-point numbers. Repeating the same source import is idempotent. A source that changed after its successful import is reported for reconciliation instead of being added a second time. An existing SQLite profile is not replaced by a legacy import.

Network notes, eligible quota policies and independent quota counters are mapped to their new equivalents. Original settings and cache documents remain in the migration archive. Application-cache entries that cannot be assigned unambiguously to a complete day are preserved as archived source data and listed in the report; they are not presented as complete native-capture history.

The old JSON directory is a retained copy, not a second live database. New samples are written to SQLite only. Reopening the old release shows the old directory's records, not samples subsequently collected by the new application.

## Custom data location

Settings > Data & storage shows the folder that holds `wifimeter.db` and lets you change it. Switching stops the collector first, copies the current database (including an unmerged `-wal` file) into the selected folder, verifies the copy and only then records the new location in `data-location.json` inside the default profile directory. The original database file is kept, and the result names its path. Window preferences, migration backups, update downloads and WebView data always stay in the default profile directory; only the database moves.

A folder that already contains `wifimeter.db` is never overwritten silently. The confirmation lets you use the database in that folder (the current one stays where it is), or replace it: the existing target database is first renamed to `wifimeter.db.replaced-<UTC timestamp>` in the same folder. Cancelling changes nothing.

If the copy fails (no space, no permission, unreadable source, or a failed verification) the partial copy is removed, an archived target database is restored, the recorded location is unchanged and collection continues from the previous database.

When a custom folder cannot be created or written at startup, the app asks whether to choose another folder or to use the default location for that run. Choosing the default for one run does not change the recorded location, and the next start tries the custom folder again. Data collected during that run is stored in the default profile, so the two databases can differ until the custom folder is available again. A database adopted from another folder keeps its own settings (language, units, retention), so the interface reloads them after switching. The legacy directory import runs once per session, so an adopted database does not import `%LOCALAPPDATA%\WiFiMeter\data` again.

Filesystems without the locking and shared-memory support SQLite expects (some network shares and removable media) may fall back to a slower journal mode. The application does not block such folders, but a local disk is recommended.

## Backups

A complete backup includes network records, hourly data, application history, coverage gaps, settings, quota ledgers and migration archives. Proxy configuration and observations are included when present. Restoring is an intentional replacement of the current dataset and leaves sampling paused. Invalid input rolls back rather than partially replacing existing records. A usage-only CSV or JSON export is not a complete backup.

The application retains the cross-platform profile location. The Windows profile is `%APPDATA%\WiFiMeter Demo`; Linux retains its existing Electron profile. Keep these directories when reinstalling. Backups and import reports can contain network names and local paths; they are private user data and must not be committed or attached to public issues without review.

## 导入旧 Windows 文件版

先退出旧采集器，再启动新版。默认读取 `%LOCALAPPDATA%\WiFiMeter\data`；便携版或自定义目录可在设置中选择。目录需要包含 `state.json`，或可恢复的 `state.json.bak`。

导入只读取原文件，不修改原目录。提交新记录前，程序会在新配置目录的 `migration-backups` 中保存原文及迁移前数据库备份。旧采集器占用、数据无效或同一网络日期发生冲突时会停止导入，数据库事务避免只写入一半。

字节数由 C++ 按精确十进制整数解析，不经过 JavaScript 浮点转换。重复导入同一来源不会重复累计。成功导入后若原来源又有变化，会提示核对，避免再次相加。已有 SQLite 配置不会被旧目录直接覆盖。

网络备注、可转换的额度策略及独立额度账本会映射到新格式。原设置和缓存原文仍保存在迁移档案中。无法确定完整日期或归属的应用缓存会在报告中列出并保留原文，不会伪装成完整的原生应用采集历史。

原 JSON 目录只作为保留副本，新采集记录写入 SQLite，不会继续同步回旧目录。重新运行旧版时，看到的是旧目录中的记录，不包含新版随后采集的数据。

## 自定义数据位置

「设置 → 数据与存储」显示 `wifimeter.db` 所在文件夹，并可更改。切换时先停止采集器，把当前数据库（含尚未合并的 `-wal`）复制到所选文件夹，校验通过后才把新位置记到默认配置目录的 `data-location.json`。原数据库文件保留，结果中会给出它的路径。窗口偏好、迁移备份、更新下载和 WebView 数据始终留在默认配置目录，只有数据库会移动。

目标文件夹已有 `wifimeter.db` 时不会静默覆盖。确认框可以选择使用该文件夹中的数据库（当前数据库留在原位置），或先用当前数据替换：替换前会把目标数据库改名为同目录下的 `wifimeter.db.replaced-<UTC 时间戳>`。取消不会改动任何文件。

复制失败（空间不足、没有权限、源文件读不到或校验不通过）时会删除半成品副本、把已归档的目标数据库还原，记录的位置不变，采集仍使用原数据库继续。

自定义文件夹在启动时无法创建或写入时，程序会询问是重新选择文件夹，还是本次运行改用默认位置。选择默认位置不会改动已记录的位置，下次启动仍会先尝试自定义文件夹；本次运行的数据写入默认配置目录，因此在自定义文件夹恢复可用之前，两个数据库的内容可能不同。采用其他文件夹中的数据库后，语言、单位、保留时长等设置以该数据库为准，界面会在切换后重新读取。旧版目录导入每次会话只执行一次，采用的新数据库不会再导入 `%LOCALAPPDATA%\WiFiMeter\data`。

缺少 SQLite 所需锁与共享内存支持的文件系统（部分网络共享和可移动介质）可能回退到较慢的日志模式。程序不会禁止这类文件夹，但建议使用本机磁盘。

## 备份与恢复

完整备份包含网络记录、小时明细、应用历史、缺失区间、设置、额度账本和迁移档案；有代理配置及观测时也会包含它们。恢复会替换当前数据，并暂停采集。无效输入会回滚，不会只替换部分记录。只导出用量的 CSV 或 JSON 不能当作完整备份恢复。

Windows 配置目录仍为 `%APPDATA%\WiFiMeter Demo`，Linux 沿用已有的 Electron 配置目录，重新安装时请保留。备份和导入报告可能包含网络名及本地路径，属于用户私有数据，不应直接提交到仓库或附在公开 issue 中。
