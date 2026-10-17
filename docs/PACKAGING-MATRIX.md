# CI and release matrix

English | [简体中文](PACKAGING-MATRIX.zh-CN.md)

## Active Tauri release target

Version 1.3.6 temporarily builds and publishes only Windows x64. Windows x86/ARM64 and Linux x64/ARM64 entries are commented out in CI, with source build helpers retained for resuming those targets. See the [1.3.6 release notes](releases/v1.3.6.md) and [Releases](https://github.com/chronicle12345/WiFiMeter/releases) for installation instructions and limitations. Historical performance and artifact records apply only to their respective versions.

| System and architecture | Artifacts | Current CI status |
| --- | --- | --- |
| Windows x64 | NSIS Setup.exe | Active; one public installer |
| Windows x86 (ia32) | NSIS Setup.exe | Temporarily commented out |
| Windows ARM64 | NSIS Setup.exe | Temporarily commented out |
| Linux x64 | deb, rpm, AppImage | Temporarily commented out |
| Linux ARM64 | deb, rpm, AppImage | Temporarily commented out |

[tauri.yml](../.github/workflows/tauri.yml) uses an x64 Windows runner, x64 Node and the `x86_64-pc-windows-msvc` Rust target for the active product build. The paused target definitions retain 32-bit Node and `i686-pc-windows-msvc` on x64 Windows for x86, native ARM64 runners, and the Ubuntu 22.04 / glibc 2.35 Linux baseline. Metadata, check aggregation and publishing can run on Ubuntu without building a Linux product.

Pushes to main and dev, pull requests, manual runs, and `v1.3.*` tags share one Desktop CI workflow. Windows x64 builds the actual backend, Rust host and NSIS installer, then checks executable architecture and runtime resources. Backend unit tests, actual ETW/EStats helper checks, Rust tests and packaged WebView2 integration remain required. UI regression checks verify the number of tests executed and reject unexpected skips, failures or flaky retries. Any failed required check prevents release.

Development Playwright checks discover every `*.spec.js` in `apps/desktop/tests/` and run the full suite in two parallel Windows x64 headless-browser shards. The Linux browser entry is temporarily commented out. Tests load the actual Tauri page bridge and an isolated Node business host; C++ data fixtures still execute, while system capabilities use test doubles. Browser regressions and the Windows x64 product build run independently. The final required check collects both browser shards and the Windows x64 result. Mainline CI does not install or launch Electron.

Native WebView integration tests save `promptAppCollection: false` in their isolated desktop preferences before launch and verify the saved value, avoiding startup questions and system authorization during UI automation. They use synthetic capture fixtures with the real Tauri host, WebView2 and SQLite backend. Separate Windows helper tests verify actual ETW and EStats capture. Windows test cleanup waits for child-process closure, and CSV export checks wait for IPC completion before reading the output. Linux eBPF and WebKitGTK checks resume with the paused Linux product jobs; their diagnostic path remains `build/tauri-smoke-linux/`.

Tags first try to reuse the Windows x64 artifact from a successful main CI run for the same commit. Before reuse, the workflow checks the repository, workflow, commit, metadata job, both Windows browser shards, Windows x64 product checks, Required checks, and the single unexpired `tauri-release-windows-x64` artifact. It runs the active checks if those conditions are not met. Release rechecks the single installer's internal SHA-256, avoiding duplicate compilation of unchanged code for a tag.

CI reuses a validated Node runtime and caches Rust build results by system, architecture, Rust compiler, and Cargo dependency configuration. The Rust cache retains dependency sources, compiled output, build fingerprints, and build script output. Test builds disable debug symbols and incremental caching to reduce transfer size. Builds, tests, and package validation still execute after cache restoration.

The paused Linux jobs retain their isolated `tauri-driver` 2.0.5 and libbpf 1.3.3 caches under `RUNNER_TEMP`. Driver reuse requires the exact Cargo installation receipt, executable SHA-256, ELF architecture and a successful `--help` startup check; this version does not support `--version`. Restored libbpf headers and static libraries must compile, link and run an ABI probe. Keys include the platform, toolchain, pinned source or driver version, and validation scripts. Invalid caches are archived before rebuilding. These caches do not replace native capture, browser or packaged WebView checks when Linux CI resumes; timing conclusions require actual CI runs.

When WebView2 is missing on Windows, CI downloads the bootstrapper from Microsoft, checks its Microsoft signature, installs it, and rechecks the version. Integration checks use isolated profiles and random local ports. Microsoft's [elevated host guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags) states that elevated processes ignore `WEBVIEW2_*` environment overrides. Dedicated debugging arguments take effect only when both background testing and profile isolation are enabled.

Tauri uses the system WebView and bundles the Node business process, C++ backend, capture helper, and licenses. Release resources contain neither Electron nor Chromium. The Windows installer can download missing WebView2; Linux requires WebKitGTK 4.1. WinDivert download limiting is currently unavailable on Windows ARM64. The floating window currently supports Windows only. Linux integration checks validate application minute queries, preference persistence and reload, and confirm that requesting the mini window does not create a native window.

Release CI uses the official Node.js 22.23.3 binaries supplied by `actions/setup-node`. `runtime-check.cjs` validates required capabilities, and the workflow checks target architecture and licenses. Runtime source trimming, Zig/Wine cross-compilation, and standalone legacy product build tools have been archived. Current Windows and Linux targets use their respective native toolchains. See [packaging instructions](../packaging/README.md#tauri-installers) for runtime configuration and local builds.

NSIS uses a 64 MiB LZMA dictionary. Retained Linux build helpers use XZ for RPM and ZSTD supported by the official plugin for AppImage. When Linux jobs resume, RPM digest validation and `bsdtar` extraction must both succeed, and all three formats require their own complete resource and native UI checks.

Portable archives have been discontinued. The Windows x64 CI artifact retains its installer and internal SHA-256 manifest. The release job revalidates names, counts and checksums, requiring exactly one Windows x64 NSIS installer. Only that installer is uploaded to the Release; checksum TXT files are not public download attachments. GitHub Actions verifies the public download after publication.

`packaging/tauri/release.cjs` requires matching versions in the root package, desktop package, Tauri configuration, and Cargo metadata. The release tag and notes must also match. Tag releases check both README files' version badges, alternative text, and corresponding release note links. After all checks pass, the workflow creates a draft, uploads all attachments, and publishes it. An existing Release or draft with the same name causes creation to fail; it is not overwritten. Permissions default to `contents: read`; only the release job uses `contents: write` and the current run's `GITHUB_TOKEN`.

## Pre-release checklist

Before creating or pushing a `v<version>` tag, check the following in order:

1. Synchronize the project's version in `package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`, and lockfiles. The tag must match these files. Third-party dependency versions do not change with the project's version.
   CMake reads the backend build version from the root `package.json`; neither platform entry point hardcodes a release version. Run the compiled backend's `--version` and check it against the desktop metadata before publishing.
2. In the same commit, update the version badges, release note links, features, installation and upgrade instructions, supported platforms, and limitations in `README.md` and `README.zh-CN.md`, and record the version in `CHANGELOG.md`. Update related documentation when architecture, packaging, or data formats change.
3. Save release notes as `docs/releases/v<version>.md`, placing `## English` first and `## 中文` second. Features, fixes, installation instructions, and limitations must correspond in both languages. Use the same file as the GitHub Release body. Record unreleased changes only under Unreleased.
4. The tagged commit must pass all active required CI/CD checks. Prefer artifacts already validated for the same commit. Attachment names, sizes, internal SHA-256 values and validation results must come from actual artifacts, not an older version's records. Version 1.3.6 has exactly one public Windows x64 NSIS installer.
5. Validate the active installer and verify its public download after release in GitHub Actions. Local work should query necessary metadata and reuse caches, avoiding repeated downloads. Restoring additional targets requires corresponding build, native validation, artifact-count and release checks before they can publish.

Installation and update tests must use isolated installations and data directories, or system interface test doubles. Background tests disable visible windows, native dialogs, and system notifications. Version control includes only necessary code, tests, licenses, and product and maintenance documentation. `.gitignore` excludes agent rules, personal editor configuration, credentials, user databases, logs, and build output; already tracked personal files must also be untracked.

## Local validation

Before checking Windows x64 locally, prepare the target architecture's Node runtime and dependencies using the [packaging instructions](../packaging/README.md#tauri-installers):

```powershell
npm run test:packaging:tauri
npm run dist:windows
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --features custom-protocol --locked
node packaging/tauri/verify-windows.cjs
```

Complete NSIS installation and uninstallation, download limit throughput, and actual driver loading require validation on target machines. Running an extracted application does not validate installation or uninstallation.

Electron 1.2.x users should obtain the Tauri installer for their system and CPU from [Releases](https://github.com/chronicle12345/WiFiMeter/releases). Windows continues to read `%APPDATA%\WiFiMeter Demo\wifimeter.db`; subsequent updates select the corresponding Tauri installer.

Version 1.3.5 changes the Windows update flow to check → confirm download → verify length and SHA-256 → confirm automatic installation → save settings and database → silent installation and restart. Checks, including startup checks, read only release metadata. Declining downloading must transfer no installer data. Postponing installation keeps the verified download for later; installation revalidates its length and SHA-256 before any shutdown. Update validation must cover both confirmations, verified-cache reuse, unsaved changes, save failures and installer handoff recovery. Linux continues to use the official release page for manual installation.
