# WiFiMeter documentation

[简体中文](README.md) | English

The [project homepage](../README.en.md) has downloads, a feature demo, and installation steps. The guides below cover common usage and development tasks.

## Using WiFiMeter

- [Floating window](FLOATING_WINDOW.md): check live speeds and application usage; adjust position, shape, and edge hiding.
- [Data migration and recovery](MIGRATION.md): import older records, create complete backups, use WebDAV, and restore data.
- [Windows application capture](WINDOWS_APP_CAPTURE.md): enable application statistics and understand permissions and coverage.
- [Linux application capture](LINUX_APP_CAPTURE.md): configure eBPF capture and permissions.
- [Linux application icons](LINUX_APPLICATION_ICONS.md): understand how application names and icons are matched.
- [Changelog](../CHANGELOG.md) and [platform support](PACKAGING-MATRIX.md): review version changes and current release targets.

## Development

- [Development workflow](DEVELOPMENT.md): branches, commits, reviews, and documentation maintenance.
- [Architecture](ARCHITECTURE.md): responsibilities of the renderer, desktop host, and collection backend.
- [Data contracts](../contracts/README.md): protocol fields, byte counters, and compatibility requirements.
- [Build and packaging](../packaging/README.md): install dependencies, run from source, and create installers.
- [Testing](TESTING.md): choose checks for a change and distinguish browser tests from native validation.
- [CI and releases](PACKAGING-MATRIX.md): build targets, artifact checks, and publication steps.
- [Demo assets](DEMO.md): regenerate the README GIFs and screenshots with synthetic traffic.

## Maintaining documentation

English and Chinese documents are maintained together. Read the [bilingual conventions](i18n/README.md) before editing and use the [terminology table](i18n/terminology.md) for reference. [Agent Notes](../.agents/notes/README.md) record the reasoning behind lasting design decisions.

[Open an issue](https://github.com/chronicle12345/WiFiMeter/issues) if something is missing or the application behaves differently from the documentation.
