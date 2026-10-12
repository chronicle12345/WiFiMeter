# Data migration and recovery

English | [简体中文](MIGRATION.zh-CN.md)

## Importing the file-based Windows version

Close the previous collector, then start the new application. The default source is `%LOCALAPPDATA%\WiFiMeter\data`. For a portable or custom source directory, open Settings > Data & migration and use the legacy-directory import action. The source must contain `state.json` or its recoverable `state.json.bak`.

The importer reads source files without modifying them. It saves the original documents and a pre-import database backup under the new profile's `migration-backups` directory before committing imported records. A locked old collector or invalid data stops the import. Overlapping network/day records are rejected by default. When automatic import encounters overlapping dates in an existing SQLite database, current traffic collection continues and the conflict remains available under Settings > Data & migration for manual resolution. During a manual import, you can explicitly choose to retain existing dates and import only non-conflicting dates. The report lists skipped dates; neither their bytes nor their quota counters are added again. The database transaction prevents a half-imported dataset.

Bytes are parsed by C++ as exact decimal integers rather than JavaScript floating-point numbers. Repeating the same source import is idempotent. A source that changed after its successful import is reported for reconciliation instead of being added a second time. An existing SQLite profile is not replaced by a legacy import.

Network notes, eligible quota policies and independent quota counters are mapped to their new equivalents. Original settings and cache documents remain in the migration archive. Application-cache entries that cannot be assigned unambiguously to a complete day are preserved as archived source data and listed in the report; they are not presented as complete native-capture history.

The old JSON directory is a retained copy, not a second live database. New samples are written to SQLite only. Reopening the old release shows the old directory's records, not samples subsequently collected by the new application.

## Backups

A complete backup includes network records, hourly data, application history, coverage gaps, settings, quota ledgers and migration archives. Proxy configuration and observations are included when present. Restoring is an intentional replacement of the current dataset and leaves sampling paused. Invalid input rolls back rather than partially replacing existing records. A usage-only CSV or JSON export is not a complete backup.

The application retains the cross-platform profile location. The Windows profile is `%APPDATA%\WiFiMeter Demo`; Linux retains its existing Electron profile. Keep these directories when reinstalling. Backups and import reports can contain network names and local paths; they are private user data and must not be committed or attached to public issues without review.

## Backend migration interface

`importLegacy` accepts `{ sourceId, stateJson, settingsJson?, appUsageJson?, allowInitialSettings? }`. JSON parameters preserve the original file contents and numeric precision and allow a UTF-8 BOM. Importing the same `sourceId` again returns only the original result; changes to previously imported source contents return `LegacySourceChanged`. `allowInitialSettings` is used only for a new profile confirmed to have had no database before startup. The backend still checks that the current dataset is empty and preferences have not been modified.

Application-cache entries that cannot be mapped to a complete day or an unambiguous network are archived without contributing to usage. Old caches do not overwrite existing network settings, usage or ledgers. The import report stores `settingsApplied`, conversion counts and `warnings`, and can be read through `migrationStatus`. Complete backups preserve the original migration documents, reports and network mappings. Older backups that lack new fields retain their original precision; no minute data is fabricated.
