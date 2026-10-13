# Multi-architecture packaging

English | [简体中文](README.zh-CN.md)

## Tauri installers

Run commands from the repository root; the version is read from package metadata. Windows x64, x86, and ARM64 use Node.js for the target architecture, a Rust MSVC toolchain, CMake, and a C++20 compiler. Linux x64 and ARM64 use native toolchains and WebKitGTK 4.1. See the [platform documentation](../docs/PACKAGING-MATRIX.md) for the complete release matrix.

```powershell
npm ci --prefix apps/desktop --ignore-scripts
npm run dist:windows
```

Windows generates only an NSIS installer by default; Linux generates deb, rpm, and AppImage packages. Portable ZIP files have been discontinued. Internal SHA-256 manifests remain part of build and CI validation, but are not Release attachments.

```text
dist/windows/WiFiMeter-1.3.3-windows-x64-Tauri-Setup.exe
```

Tauri uses the system WebView and bundles the Node business process and C++ collector. The Windows installer downloads WebView2 when it is missing; Linux uses system WebKitGTK 4.1. User data retains its original directory.

Packaging uses the current Node.js executable unless `WIFIMETER_NODE_EXECUTABLE` is set. Release CI uses the official Node.js 22.23.3 binaries supplied by `actions/setup-node`. The target architecture must match Node.js, Rust, and the C++ collector. [runtime-check.cjs](tauri/runtime-check.cjs) validates actual capabilities including TLS, Chinese collation, atomic file saves, subprocesses, and download streams. Release packages also retain the corresponding Node.js license.

Legacy runtime trimming and cross-compilation tools have been archived. Current sources retain native Tauri builds, validation, and installation helpers used by the current application. NSIS uses a 64 MiB LZMA dictionary. Linux RPM uses XZ compression, AppImage uses ZSTD supported by the official plugin, and deb retains Tauri's compression configuration.

To reproduce the CI release configuration locally, run these commands from the repository root. The current Node.js architecture must match the target. Windows also requires Python 3, a complete 7-Zip installation, and the Visual Studio C++ toolchain; native validation requires WebView2 Runtime.

```powershell
$nodeArch = node -p 'process.arch'
$rustTarget = @{ x64 = 'x86_64-pc-windows-msvc'; ia32 = 'i686-pc-windows-msvc'; arm64 = 'aarch64-pc-windows-msvc' }[$nodeArch]
rustup target add $rustTarget
if ($LASTEXITCODE) { throw 'Rust target installation failed' }
node packaging/tauri/runtime-check.cjs
if ($LASTEXITCODE) { throw 'Official Node runtime validation failed' }
node -e "require('./packaging/tauri/prepare.cjs').nodeLicense(); require('./packaging/tauri/verify-windows.cjs').sevenZipExecutable()"
if ($LASTEXITCODE) { throw 'Node license or 7-Zip lookup failed' }
node packaging/tauri/build.cjs --platform win32 --arch $nodeArch --target $rustTarget --formats nsis
if ($LASTEXITCODE) { throw 'Tauri build failed' }
node packaging/tauri/verify-windows.cjs --arch $nodeArch --target $rustTarget
```

When specifying a target architecture explicitly, Node.js must use that architecture and the Rust target must match:

```powershell
node packaging/tauri/build.cjs --platform win32 --arch ia32 --target i686-pc-windows-msvc --formats nsis
```

On Linux, run on a host with the target architecture and first install the system dependencies listed in [tauri-linux-deps.sh](../.github/workflows/scripts/tauri-linux-deps.sh):

```bash
set -euo pipefail
node_arch=$(node -p 'process.arch')
node packaging/tauri/runtime-check.cjs
export WIFIMETER_NODE_LICENSE=$(node -p "require('./packaging/tauri/prepare.cjs').nodeLicense({ license: require('node:path').resolve(require('node:path').dirname(process.execPath), '..', 'LICENSE') })")
npm run dist:linux
cargo install tauri-driver --version 2.0.5 --locked
node packaging/tauri/verify-linux.cjs --arch "$node_arch"
```

Linux CI separates system installation (`tauri-linux-deps.sh system`) from verified libbpf cache reuse (`tauri-linux-deps.sh libbpf`); running the script without a mode still performs both. The libbpf cache contains only its static installation, while the pinned Tauri WebDriver uses an independent installation root. Restored entries undergo linker/ABI or Cargo receipt, executable digest, architecture, and CLI startup checks before use. Invalid entries are moved into a rejected-cache directory under `RUNNER_TEMP` and rebuilt. See the [CI matrix](../docs/PACKAGING-MATRIX.md) for cache keys and the required native validation scope. Local builds do not require these CI caches.

Windows package validation extracts the package, checks every runtime resource, and launches actual WebView2 with the bundled backend. Linux extracts and validates all three formats separately and runs actual WebKitGTK. See the [release notes](../docs/releases/v1.3.3.md) for current installation instructions and limitations; validation results are established by the corresponding commit's CI records.

RPM validation first checks package digests, then performs strict extraction using `bsdtar` from `libarchive-tools`, accommodating packages whose archive length fields are omitted by Tauri's packaging library. Any failed digest, extraction, resource, or native UI check prevents release.

Installation and system interaction validation uses separate test installations and data directories. Check installation, upgrades, shortcuts, the tray, a single startup registration, settings and backup restoration, and data integrity after exiting and reopening. Quota notifications, actual network disconnection, and download limiting require target-machine validation under actual permissions and network conditions. Uninstallation preserves user data. Record packaged WebView automation and complete installation/uninstallation validation separately; the former does not establish the latter's results.

## Testing and release

Shared desktop business logic is in `apps/desktop/host`; Tauri adaptation is in `apps/desktop/tauri`. Development page regression tests use headless browsers and the actual page bridge, running Node business logic and the C++ backend in isolated directories. Test doubles handle windows, dialogs, and system settings; Electron is not launched. Actual capture, Rust, and packaged WebView validation for all five platform targets remain required release checks. See the [CI and release matrix](../docs/PACKAGING-MATRIX.md) for the complete workflow.

Local work should reuse existing browsers, dependencies, and build caches. Store test screenshots, logs, and temporary data in the project's `del` directory; archive files by moving them only. Compare performance using the same test scope and actual CI durations. Development browser results do not establish native WebView validation.

## Icon sources and validation

The canonical logo is `docs/assets/logo.svg`. `node packaging/generate-icons.cjs` generates the desktop SVG, PNG, and Windows ICO. Windows, tray icons, and installers use the same resources. The Windows ICO contains seven sizes: 16, 24, 32, 48, 64, 128, and 256 px, retaining transparent rounded corners.

Icon checks validate actual ICO images, their correspondence with the SVG, and Tauri's installer icon configuration. On Windows with Microsoft Edge installed, run:

```powershell
$env:PLAYWRIGHT_CHANNEL = 'msedge'
node --test packaging/icons.test.cjs
```

The environment variable can be omitted when Playwright Chromium is installed. Release validation must still check the final PE icons and corresponding installer resources. Historical Electron build entry points have been archived; published version notes retain the facts of those releases.
