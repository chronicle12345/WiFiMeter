# CI and release matrix

English | [简体中文](PACKAGING-MATRIX.zh-CN.md)

## Complete Tauri release matrix

The 1.3.x series provides the complete Windows and Linux build and release targets below. See the [1.3.4 release notes](releases/v1.3.4.md) and [Releases](https://github.com/chronicle12345/WiFiMeter/releases) for the current stable version's features, installation instructions, and limitations. Historical performance and artifact records apply only to their respective versions.

| System and architecture | Artifacts |
| --- | --- |
| Windows x64 | NSIS Setup.exe |
| Windows x86 (ia32) | NSIS Setup.exe |
| Windows ARM64 | NSIS Setup.exe |
| Linux x64 | deb, rpm, AppImage |
| Linux ARM64 | deb, rpm, AppImage |

[tauri.yml](../.github/workflows/tauri.yml) uses native environments for each architecture. Windows x86 runs 32-bit Node and test executables on x64 Windows with the `i686-pc-windows-msvc` Rust target. ARM64 uses GitHub ARM64 runners. Linux retains the Ubuntu 22.04 and glibc 2.35 build baseline.

Pushes to main, pull requests, manual runs, and `v1.3.*` tags share one Desktop CI workflow. The complete matrix builds the actual backend, Rust host, and installers, then checks each executable's architecture and runtime resources. UI regression checks verify the number of tests executed and reject unexpected skips, failures, or flaky retries. Windows uses actual WebView2; Linux launches actual WebKitGTK. Any failed required check prevents release.

Development Playwright checks discover every `*.spec.js` in `apps/desktop/tests/` and run the full suite in headless browsers on both Windows x64 and Linux x64, using two parallel shards per system. Tests load the actual Tauri page bridge and an isolated Node business host; C++ data fixtures still execute, while system capabilities use test doubles. Browser regression checks and builds for the five platform targets run independently. The final required check collects all shard and platform results. Mainline CI does not install or launch Electron.

Tags first try to reuse complete artifacts from a successful main CI run for the same commit. Before reuse, the workflow checks the repository, workflow, commit, full browser regression results, five platform checks, and unexpired artifacts. It runs the complete matrix if those conditions are not met. Release still rechecks the internal SHA-256 values of all nine installers, avoiding duplicate compilation of unchanged code for a tag.

CI reuses a validated Node runtime and caches Rust build results by system, architecture, Rust compiler, and Cargo dependency configuration. The Rust cache retains dependency sources, compiled output, build fingerprints, and build script output. Test builds disable debug symbols and incremental caching to reduce transfer size. Builds, tests, and package validation still execute after cache restoration.

Linux also caches the isolated `tauri-driver` 2.0.5 installation under `RUNNER_TEMP`, keyed by runner, architecture, Rust compiler, pinned driver version, and cache validation code. Reuse requires the exact Cargo installation receipt, executable SHA-256, ELF architecture, and a successful `--help` startup check; this driver version does not support `--version`. A missing or invalid installation is archived and installed again with locked dependencies. The separate libbpf 1.3.3 static installation cache includes the Ubuntu 22.04 baseline, architecture, GCC and binutils versions, prerequisite ABI versions, pinned source SHA-256, and dependency scripts in its key. Its restored headers and static library must compile, link, and run an ABI probe. Invalid libbpf caches are archived before the existing verified download and build path runs. These caches do not replace native capture, browser regression, or package WebView checks; timing conclusions require actual cold and warm CI runs.

When WebView2 is missing on Windows, CI downloads the bootstrapper from Microsoft, checks its Microsoft signature, installs it, and rechecks the version. Integration checks use isolated profiles and random local ports. Microsoft's [elevated host guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags) states that elevated processes ignore `WEBVIEW2_*` environment overrides. Dedicated debugging arguments take effect only when both background testing and profile isolation are enabled.

Tauri uses the system WebView and bundles the Node business process, C++ backend, capture helper, and licenses. Release resources contain neither Electron nor Chromium. The Windows installer can download missing WebView2; Linux requires WebKitGTK 4.1. WinDivert download limiting is currently unavailable on Windows ARM64. The floating window currently supports Windows only. Linux integration checks validate application minute queries, preference persistence and reload, and confirm that requesting the mini window does not create a native window.

Release CI uses the official Node.js 22.23.3 binaries supplied by `actions/setup-node`. `runtime-check.cjs` validates required capabilities, and the workflow checks target architecture and licenses. Runtime source trimming, Zig/Wine cross-compilation, and standalone legacy product build tools have been archived. Current Windows and Linux targets use their respective native toolchains. See [packaging instructions](../packaging/README.md#tauri-installers) for runtime configuration and local builds.

NSIS uses a 64 MiB LZMA dictionary. Linux RPM uses XZ; AppImage uses ZSTD supported by the official plugin. RPM digest validation and `bsdtar` extraction must both succeed. All three Linux formats continue to receive complete resource and native UI checks individually.

Portable archives have been discontinued. Each CI artifact set retains its installers and internal SHA-256 manifest. The release job revalidates the names, counts, and checksums of all five sets, uploading only the nine application installers to the Release. Checksum TXT files are not public download attachments.

`packaging/tauri/release.cjs` requires matching versions in the root package, desktop package, Tauri configuration, and Cargo metadata. The release tag and notes must also match. Tag releases check both README files' version badges, alternative text, and corresponding release note links. After all checks pass, the workflow creates a draft, uploads all attachments, and publishes it. An existing Release or draft with the same name causes creation to fail; it is not overwritten. Permissions default to `contents: read`; only the release job uses `contents: write` and the current run's `GITHUB_TOKEN`.

## Pre-release checklist

Before creating or pushing a `v<version>` tag, check the following in order:

1. Synchronize the project's version in `package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`, and lockfiles. The tag must match these files. Third-party dependency versions do not change with the project's version.
   CMake reads the backend build version from the root `package.json`; neither platform entry point hardcodes a release version. Run the compiled backend's `--version` and check it against the desktop metadata before publishing.
2. In the same commit, update the version badges, release note links, features, installation and upgrade instructions, supported platforms, and limitations in `README.md` and `README.zh-CN.md`, and record the version in `CHANGELOG.md`. Update related documentation when architecture, packaging, or data formats change.
3. Save release notes as `docs/releases/v<version>.md`, placing `## English` first and `## 中文` second. Features, fixes, installation instructions, and limitations must correspond in both languages. Use the same file as the GitHub Release body. Record unreleased changes only under Unreleased.
4. The tagged commit must pass all required CI/CD checks. Prefer artifacts already validated for the same commit. Attachment names, sizes, internal SHA-256 values, and validation results must come from actual artifacts, not an older version's records. Public attachments contain only the nine installers listed above.
5. Download the complete installer set, validate it across platforms, and verify public downloads after release in GitHub Actions. Local work should query necessary metadata and reuse caches, avoiding repeated downloads of the complete set.

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

The current source changes the Windows update flow to check → confirm download → verify length and SHA-256 → confirm automatic installation → save settings and database → silent installation and restart. This flow is unreleased; published 1.3.4 retains automatic download and installation. Checks, including startup checks, read only release metadata. Declining downloading must transfer no installer data. Postponing installation keeps the verified download for later; installation revalidates its length and SHA-256 before any shutdown. Update validation must cover both confirmations, verified-cache reuse, unsaved changes, save failures and installer handoff recovery. Linux continues to use the official release page for manual installation.
