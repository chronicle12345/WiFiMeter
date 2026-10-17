# CI and release matrix

English | [简体中文](PACKAGING-MATRIX.zh-CN.md)

## Active Tauri release target

Version 1.3.6 builds and publishes only Windows x64. Other product and Linux browser entries are commented out; their source helpers remain available. Installation and version-specific limits are in the [release notes](releases/v1.3.6.md) and [Releases](https://github.com/chronicle12345/WiFiMeter/releases). Historical performance and artifact records apply only to their versions.

| System and architecture | Artifacts | Current CI status |
| --- | --- | --- |
| Windows x64 | NSIS Setup.exe | Active; one public installer |
| Windows x86 (ia32) | NSIS Setup.exe | Temporarily commented out |
| Windows ARM64 | NSIS Setup.exe | Temporarily commented out |
| Linux x64 | deb, rpm, AppImage | Temporarily commented out |
| Linux ARM64 | deb, rpm, AppImage | Temporarily commented out |

[tauri.yml](../.github/workflows/tauri.yml) uses x64 Windows, x64 Node, and `x86_64-pc-windows-msvc` for the active product. Paused definitions retain x86 Node/MSVC on x64 Windows, native ARM64 runners, and Ubuntu 22.04 / glibc 2.35. Ubuntu metadata and release jobs do not build a Linux product.

## Checks and artifact reuse

Pushes to `main` and `dev`, pull requests, manual runs, and `v1.3.*` tags share Desktop CI. Ordinary branch pushes run checks; publication additionally requires a matching tag. Development and review rules are maintained in [Development](DEVELOPMENT.md).

Required checks include workflow/release metadata, both Windows browser shards, and Windows x64 backend CTest, actual ETW/EStats, desktop integration, Rust, executable architecture/resources, and packaged WebView2 checks. The final Required Tauri checks job rejects failed, cancelled, or unexpectedly skipped required jobs. Browser reports must contain actual tests with no unexpected skips, failures, global errors, or flaky retries. Repository documentation/policy checks use the entry points in [Testing](TESTING.md).

Browser shards and product compilation run independently after metadata. Tests use the actual page bridge, isolated Node/backend fixtures, and a locked Chromium runtime; packaged checks run the actual Tauri host, WebView2, and database. They disable `promptAppCollection` in isolated preferences to avoid startup authorization dialogs. Windows native collection runs separately. Linux eBPF/WebKitGTK coverage resumes with its paused jobs, retaining `build/tauri-smoke-linux/` diagnostics.

Tags first try to reuse a successful `main` push run for the same commit. Reuse verifies the repository, workflow, commit, metadata job, both browser shards, Windows product job, Required checks, and the single unexpired `tauri-release-windows-x64` artifact with matching source metadata. If verification fails, the tag runs all active checks. Release revalidates the installer and internal SHA-256.

CI uses official Node.js 22.23.3 and caches Rust dependencies/output by platform, architecture, compiler, and dependency configuration. Test profiles disable debug symbols and incremental caches. Restoring a cache never replaces execution of builds and checks. Missing Windows WebView2 is downloaded from Microsoft, signature-checked, installed, and rechecked. Integration uses random local ports and isolated profiles; dedicated elevated-host debugging arguments require both background testing and isolation.

Paused Linux jobs retain independent `tauri-driver` 2.0.5 and libbpf 1.3.3 caches under `RUNNER_TEMP`. Driver reuse checks the Cargo receipt, executable digest, ELF architecture, and `--help`; libbpf reuse compiles, links, and runs an ABI probe. Cache keys include the toolchain, pinned source/version, and verification scripts. Invalid entries are archived before rebuilding. Restored Linux jobs must still run their native checks.

## Publication

Portable archives are discontinued. The Windows CI artifact contains its installer and an internal SHA-256 manifest. Release validates the name, count, and checksum of exactly one Windows x64 NSIS installer, uploads only that installer, then checks its public download in GitHub Actions. Checksum TXT files are not public assets. Restoring targets requires matching build, native, resource, format, artifact-count, and publication checks first.

[release.cjs](../packaging/tauri/release.cjs) requires matching root, desktop, Tauri, and Cargo versions; tag and notes must match. Tagged builds also validate both README badges, alternative text, and release-note links. The workflow creates a draft with all verified attachments and then publishes it. An existing same-name Release/draft causes failure rather than an overwrite. Permissions default to `contents: read`; only publication uses `contents: write` and the current `GITHUB_TOKEN`.

## Pre-release checklist

Before creating or pushing a `v<version>` tag:

1. Synchronize project versions in root/desktop `package.json`, Tauri configuration, Cargo metadata, and lockfiles. Do not change dependency versions to match the product. CMake reads the root version; verify the compiled backend's `--version` against desktop metadata.
2. Update both README badges, release links, product/install/upgrade/platform limits, and `CHANGELOG.md` in the same change. Update the owning guides and affected implemented Notes. Review and register bilingual pairs, then pass repository documentation checks.
3. Write `docs/releases/v<version>.md` with `## English` before `## 中文`, matching features, fixes, installation, and limits. Use that file as the Release body. Keep unreleased changes under Unreleased.
4. Require every active CI check for the tagged commit. Reuse only verified same-commit artifacts. Names, sizes, checksums, timings, and validation claims come from actual artifacts and runs; 1.3.6 has one public Windows x64 installer.
5. Validate the installer and public download in GitHub Actions. Reuse caches and query necessary metadata locally. Record complete installation/uninstallation, driver loading, and download-limit throughput separately on target machines.

## Local validation

Use [Packaging](../packaging/README.md#tauri-installers) for target dependencies and build commands, and [Testing](TESTING.md#native-host-and-installers) for checks and evidence limits. Tests use isolated profiles, synthetic data, and ordinary application/backend permissions. Update validation covers both confirmations, length/SHA-256 revalidation, verified-cache reuse, unsaved changes, save failures, and installer-handoff recovery. Linux updates remain manual through the official release page.

Shared rules and Notes, private-state exclusions, and local diagnostic handling are maintained in [Development](DEVELOPMENT.md#shared-rules-and-private-state). Building a package or running an extracted application does not establish complete installation/uninstallation validation.
