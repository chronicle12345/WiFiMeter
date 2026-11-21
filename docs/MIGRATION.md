# Data migration and recovery

English | [简体中文](MIGRATION.zh-CN.md)

## Importing the file-based Windows version

Close the old collector before starting the new application. By default, WiFiMeter reads `%LOCALAPPDATA%\WiFiMeter\data`. For a portable installation or custom directory, open Settings > Data & migration and choose the legacy-directory import. The directory must contain `state.json` or a recoverable `state.json.bak`.

Import leaves the source files unchanged. Before saving records, it copies the original documents and backs up the current database to `migration-backups` in the new profile. If the old collector still holds its lock, or the source data is invalid, import stops.

Records for a network and date already in the database are rejected by default. If automatic import finds such a conflict in an existing SQLite profile, current collection continues. Resolve the conflict manually in Settings > Data & migration. Manual import lets you keep existing dates and import only the others. The report lists skipped dates; their bytes and quota counters are not added again. A database transaction prevents partial imports.

Byte counts are parsed as exact decimal integers in C++, without passing through JavaScript floating-point numbers. Importing the same source again does not add its traffic twice. If the source has changed since a successful import, WiFiMeter asks you to review it. Legacy import does not replace an existing SQLite profile.

Network notes, compatible quota policies and independent quota counters are converted to the new format. Original settings and cache files stay in the migration archive. Application-cache entries without a clear assignment to a complete day are archived and listed in the report; they are excluded from complete native-capture history.

The old JSON directory remains as a copy of the original records. New samples go only to SQLite. If you reopen the old release, it will show the old records without any traffic subsequently collected by the new application.

## Backups

A complete backup includes network records, hourly data, application history, coverage gaps, settings, quota ledgers and migration archives. It also includes proxy configuration and observations when present. Restoring replaces the current dataset and leaves collection paused. Invalid input rolls back, preserving the existing records. Usage-only CSV and JSON exports cannot be restored as complete backups.

Keep the existing profile directory when reinstalling: `%APPDATA%\WiFiMeter Demo` on Windows, or the existing Electron profile on Linux. Backups and import reports may contain network names and local paths. Review this private data before committing a file or attaching it to a public issue.

### WebDAV cloud backups

In Settings > Cloud backup, enter the WebDAV address and credentials, select content and recent days, test the connection, then back up or list remote files. Automatic backups run while the application is open, at the selected hourly, daily or weekly interval. Retention removes only that device's excess backups. File names have a unique suffix; older names remain readable.

Restoring a cloud backup replaces only the data it contains. For dated data, it replaces records from the backup's starting day onward. Earlier records and data omitted from the backup stay in place. Backups containing application or minute data include one copy of minute proxy weights. Restoring an older selected backup without these weights clears them for the covered dates, so local weights cannot be applied to another device's records.

System settings include backend preferences, proxy configuration, window preferences, the log recording level and saved application restrictions. Restoring restriction records does not apply firewall or speed-limit policies; review and set them on the Rules page. Logs retain timestamps, levels and sources, with support for structured snapshots and older text exports. Windows protects the WebDAV password with DPAPI; Linux restricts file access to the owner. Credentials are excluded from backups.

Desktop settings and logs are validated before any data is replaced. Restore first pauses collection and saves `before-cloud-restore.json.gz`, containing the complete backend dataset, portable desktop settings and logs. You can open this compressed restore point through the ordinary file-restore action. After a successful restore, collection stays paused. If restore fails, WiFiMeter attempts to recover the previous data and collection state. Incomplete recovery leaves collection paused and reports the local restore point it has kept.

## Backend migration interface

`importLegacy` accepts `{ sourceId, stateJson, settingsJson?, appUsageJson?, allowInitialSettings? }`. JSON parameters preserve the original file contents and numeric precision and allow a UTF-8 BOM. Importing the same `sourceId` again returns only the original result; changes to previously imported source contents return `LegacySourceChanged`. `allowInitialSettings` is used only for a new profile confirmed to have had no database before startup. The backend still checks that the current dataset is empty and preferences have not been modified.

Application-cache entries that cannot be mapped to a complete day or an unambiguous network are archived without contributing to usage. Old caches do not overwrite existing network settings, usage or ledgers. The import report stores `settingsApplied`, conversion counts and `warnings`, and can be read through `migrationStatus`. Complete backups preserve the original migration documents, reports and network mappings. Older backups that lack new fields retain their original precision; no minute data is fabricated.
