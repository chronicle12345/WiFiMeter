# Version 1.2 integration acceptance plan

Retain the Electron interface and C++ sampling/storage backend. JavaScript handles UI and operating-system integration; SQLite stores counters transactionally.

- Import legacy state and settings without changing source files, rounding counters, duplicating imports or overwriting overlapping SQLite data. Preserve original documents and a recovery backup.
- Preserve application records, quota ledgers, hourly rows and coverage gaps across backup/restore. Keep existing database profiles discoverable.
- Restore stable Windows features: application network controls, date/month history, bilingual UI, total quotas, wired accounting and proxy attribution where supported.
- Measure idle CPU, memory, IPC and package sizes. Reduce unbounded logs, repeated history reloads and hidden-window rendering. Report Electron runtime overhead honestly.
- Build packages with matching executable architectures. Verify supported Windows and Linux targets in CI; do not publish untested architectures.
- Use synthetic fixtures. Exclude credentials, personal paths, local data, logs and machine configuration from commits and packages.
- Merge main and publish v1.2.0 only after migration, regression, interface and packaging checks pass. Missing parity requirements or failed tests block release.
