# Project architecture

English | [简体中文](ARCHITECTURE.zh-CN.md)

The shared Tauri desktop application lives in `apps/desktop/`. Windows and Linux use the same renderer and host code. Rust provides the system WebView and native desktop capabilities, while a Node helper process reuses the existing business modules. The local C++ backend handles native network collection and business storage; both platform implementations are in place. Current releases cover Windows x64, x86 and ARM64, plus Linux x64 and ARM64. See the [build and release matrix](PACKAGING-MATRIX.md) for capabilities and verification limits.

## Current data flow

```text
renderer/app.js → data/backend-client.js → tauri/bridge.js → Rust → Node business process → wifimeter-backend (JSON Lines)
       └──────────────────────────────────→ data/model.js (validation and calculations)
renderer → tauri/bridge.js → Rust → system file dialogs, windows, tray, system notifications
                                → Node → autostart, data import, file I/O, updates and traffic control
```

The renderer creates data objects and reads the local backend through `backend-client.js`. Data definitions and calculations live in `model.js`. Synthetic snapshots live in `tests/fixtures/snapshot.js`; test fixtures are not copied into production renderer assets.

`renderer/app.js` composes page rendering, navigation and events. Reusable input and display logic belongs in `renderer/ui/`; data access and calculations belong in `renderer/data/`. `ui/form-autosave.js` manages field validation, save state, retries, retention cleanup and draft discard for settings, network quota, total quota and proxy forms. It calls existing host and data interfaces through callbacks; the page entry point handles confirmation dialogs and interface refreshes. New business logic should go into the module responsible for it, with tests that call the module interface directly.

The application page and the network drawer share view tabs and filters from `ui/application-workspace.js`, together with the five-column row layout in `ui/application-table.js`. The application page initially shows live traffic; the network drawer initially shows usage history. Live and historical search and sort selections are kept separately. History supports application summaries and minute, hour, day and month groupings; its date range and native/estimated source selection do not change the live measurements. Page composition and event routing remain in `app.js`.

The shared table formats live values with the speed-unit preference and historical values with the byte-unit preference. Missing measurements display a dash. Row badges distinguish measured or unavailable rates from native records and proxy estimates. Local TCP connections remain separate from adapter usage and quota totals; sharing the display does not add rates to historical bytes. The same application drawer provides details and existing network controls from either view.

`data/application-view.js` derives rows, unsearched totals and export availability once for each application render pass. Application aggregation belongs to `data/history.js`; presentation modules consume the result. `ui/app-icons.js` shares pending requests, limits concurrency and drops queued work when no matching avatar remains connected.

`data/application-proxy.js` matches detail records by application identifiers and known paths, including the explicit proxy identifier when available. Live local TCP connections and validated historical estimates occupy separate detail sections. Historical estimates must match native download and upload totals for the same network, date and proxy before they can replace native proxy rows; direct client traffic remains. Partial-day and minute/hour details omit daily estimates because those estimates cannot establish usage for the shorter interval. Unknown proxy identities are not inferred from display names. The [data contracts](../contracts/README.md) define the proxy fields and measurement limits.

Proxy detail validation visits only candidate groups and retains a single result keyed by the application history revision, source arrays, identity and selected range. The data client increments that revision for applied snapshots, application increments, estimate replacements, clears and proxy configuration saves. Pure speed events retain the revision; current clients and measurement availability are always read afresh. Closing the drawer releases the cached history references. The resolver does not cache callers that provide no revision, since their arrays may be modified in place.

The Node business process uses `host/backend.cjs` to launch the backend and match requests with responses by id. Events (`live`, `usage`, `alert`) are pushed separately. Backend failures reach the renderer as `{ ok: false, error }`, preserving their error codes and messages. The C++ backend is authoritative for history, quotas and network settings.

`host/desktop-runtime.cjs` explicitly receives the desktop capabilities provided by `tauri/native-adapter.cjs`. `host/main.cjs` uses that interface to compose business behavior without intercepting Node module loading or depending on the Electron SDK. Business unit tests use interface substitutes. Development UI regression tests load the real renderer and Tauri bridge in a headless browser and run an isolated Node business host; test substitutes handle operating-system windows, tray and dialogs. Integration tests of each platform's installation packages continue to verify the real WebView, windows, installed resources and native collection.

Version 1.3.5 saves the desktop preference `promptAppCollection` in `window-preferences.json`, defaulting to `true`. Settings > General exposes it as Ask about application capture at startup. After startup and migration succeed and the main window is shown, the host asks whether to enable collection for that session. Only acceptance sends `setAppCollection({ enabled: true })` and allows the native helper's system authorization. Declining the question or system authorization leaves application capture off without another automatic request in that session; adapter statistics continue. When the backend reports application capture as unavailable, the host skips the question. Failed migrations also skip it. Disabling the preference suppresses future startup questions, and manual application-page controls do not change it. The backend's capture switch remains disabled by default and applies only to its current session.

Version 1.3.5 separates the update operations in `host/updates.cjs` behind `updates:check`, `updates:download` and `updates:install`. Checks only select official release metadata and the matching asset. An explicit download validates length and SHA-256, reuses an intact cache and stops at `downloaded`; it never stops collection or launches the installer. The renderer asks for download and installation separately. Installation revalidates the cached asset before settings/database saving and the existing graceful shutdown and installer handoff. Declining installation retains the downloaded candidate for later use. Startup checks only notify about an available update.

The renderer completes the current range query before loading minute history as needed. Concurrent minute queries for the same range share a request, and late responses from older requests cannot replace the current range. The backend handles hourly exports: complete dates can export existing hourly records, while partial ranges aggregate hours at minute boundaries. Custom ranges use local dates and hours/minutes and include the entire ending minute.

After initial backend initialization fails, a refresh repeats the handshake and restores the live subscription. A date selection made during that handshake remains the current query. The update host rechecks import, exit and recovery state after asynchronous settings confirmation, before stopping the collector.

## C++ backend

`backend/platform/network_platform.h` defines platform-independent interfaces for collection, identity lookup and disconnect control, with two implementations:

| Implementation | Counter source | Identity source | Disconnect method |
| --- | --- | --- | --- |
| `backend/platform/linux/` | `/proc/net/dev` | `nmcli` (only locale-independent output is parsed) | `nmcli dev disconnect`, followed by verification |
| `backend/platform/win32/` | IP Helper `GetIfTable2` | WLAN API `WlanQueryInterface` | `WlanDisconnect`, followed by polling to verify the result |

These interfaces report facts and typed failures without generating UI text. They confirm identity before and after reading counters and discard a sample if the network changes between those checks. Disconnect control first checks the connection, then performs the operation and verifies the result; it acts only when the interface is associated with the expected network.

The Windows implementation has two layers so that its decision logic can be tested:

```text
platform/win32/      System calls and field transfer only (WlanOpenHandle, GetIfTable2, WlanDisconnect)
platform/windows/    Sampling and disconnect decisions, with SystemApi dependency injection and no Win32 API calls
```

Decisions such as discarding samples after a network switch, waiting for asynchronous disconnect results and distinguishing an unassociated state can be verified on a Linux development machine. `platform/win32/` handles the system calls. Identity conversion (UTF-16 to UTF-8, surrogate pairs and invalid bytes) and counter conversion also live in `platform/windows/`, without dependencies on Windows types.

`core/` implements platform-independent business rules: byte formatting, local calendar keys, network key mapping, usage accumulation and quotas. When counters fall, identity changes or an adapter disappears from a complete report, it discards the accumulation baseline and emits a typed event so that unassignable traffic is not attributed to the wrong network.

`storage/` incrementally stores daily, hourly, minute and application usage in SQLite, together with networks, quota ledgers and preferences. Schema 6 adds `minute_usage` and `app_minute_usage`; existing data retains its original precision. Samples spanning minutes allocate bytes by time while preserving their total. Minute records participate in complete backups, restoration, clearing, network deletion and retention policies. `coverage_gaps` records missing intervals separately so that the interface can distinguish them from actual zero traffic. Linux uses the system `libsqlite3`; Windows uses the amalgamated source in `backend/third_party/sqlite`.

`ipc/` implements the protocol and event loop: requests are `{id, method, params}`, responses are `{id, ok, result|error}`, and events are `{event, ...}`. The I/O loop is selected by platform: POSIX uses `poll` to wait for standard input and the sampling timer, while Windows uses `WaitForSingleObject` on the pipe handle. The protocol and business logic are shared in full.

If network-usage persistence fails, the service holds one pending batch with its original sample time. It retries that batch before reading new counters, preserving attribution and minute allocation without growing an unbounded queue. Successful clear or restore operations discard it; import, retention cleanup and normal shutdown operations must flush it first. The batch is in memory and does not survive forced process termination. Gap queries use local calendar-day boundaries and include the entire retained history.

Cumulative adapter counters are used only to calculate increments between adjacent valid samples. The first sample, a counter rollback, an identity change or a confirmed adapter disappearance rebuilds the baseline so that historical counters are not attributed to the current network. If identity is temporarily unreadable, the baseline is retained for a limited time. Quota ledgers are stored independently for local daily, monthly or cumulative periods and are not recalculated from history within the retention period. Interfaces represent bytes as decimal strings, and JavaScript uses `BigInt`. Values are checked against the signed 64-bit range before SQLite writes; out-of-range values are rejected.

The collection process communicates over local pipes and does not initiate external network requests. Network access is used for version checks, installation-package downloads during updates and user actions that open the official release page. On Windows, the installer downloads Microsoft's WebView2 runtime if it is missing. Backend startup failures or unexpected exits preserve the error and trigger collection recovery. The Node business host always passes the database path explicitly. See the [data contracts](../contracts/README.md) for protocol and backup fields, and [migration and recovery](MIGRATION.md) for legacy data import rules.

## Responsibility boundaries

| Module | Responsibility |
| --- | --- |
| Renderer | Display, input, filtering and interaction state |
| Tauri / Rust | System WebView, windows, tray, dialogs and restricted IPC |
| Node helper process | Backend process management, migration, updates, file I/O, system settings and traffic control |
| C++ backend | Native collection, accumulation, quota decisions and business storage |
| Platform adapters | Isolation of Windows/Linux system APIs |
| contracts | Shared data and protocol conventions for the frontend and backend |
| packaging | Assembly of installation packages for each operating system |

Add platform adaptation code to the host or backend only when an actual platform difference requires it.

## Builds and separation from legacy versions

Root npm commands forward to the desktop application. Its lockfile and dependencies remain in the application directory.

- **Linux source build**: `npm run dist:linux` builds the collector and Tauri with the local toolchain, producing deb, rpm and AppImage packages.
- **Windows native build**: `npm run dist:windows` builds the backend with local CMake, prepares Node, native control modules and renderer assets, then uses the Tauri CLI to build an NSIS installer in `dist/windows/`.
- **UI regression tests**: `npm run test:ui` uses a headless browser. The current source, dependencies and build entry points do not require an Electron runtime.

C++ intermediate artifacts live under the root `build/` directory (`build/` on Linux and `build/windows/` on Windows). Installation packages include the corresponding `wifimeter-backend` executable. Windows uses its own application identifier and data directory and does not read Linux runtime-component paths.

Both platforms use the product name `WiFiMeter`. Windows retains the application identifier `io.wifimeter.demo` and the data directory `%APPDATA%\WiFiMeter Demo`; Linux uses `WiFiMeter` and standard XDG directories. Identity definitions are centralized in `apps/desktop/host/product.cjs` and have unit tests. Display-name updates preserve the existing Windows application identifier and data path so that upgrades can still read existing records.

Electron 1.2.x users migrate by downloading the Tauri installer for their operating system and CPU architecture. Subsequent Tauri updates select only the corresponding Tauri installation package.

Before starting Node and the backend, the Windows host holds the `lockfile` used by Electron, scoped to the user data directory. Old and new versions cannot collect into the same directory simultaneously. The operating system releases the lock when the process exits. WebView2 caches live in a separate `webview2` subdirectory of that directory.

`.github/workflows/tauri.yml` handles Tauri builds and tests for the current five platform targets and release publication for `v1.3.*` tags. Development UI regression tests run in parallel shards in separate Windows and Linux jobs. Packaging jobs can begin before the full UI regression suite finishes; aggregation and publication require both sets of checks to succeed. Production CI uses a pinned official Node.js runtime and reuses verified compilation caches and release artifacts from the same commit. The old UI, historical standalone product builds and cross-platform compilation tools are archived; version history remains in the corresponding tags and release notes. See the [build and release matrix](PACKAGING-MATRIX.md) for each workflow's scope.

Performance comparison tools live in `tools/performance/`: `ipc-and-autostart.cjs` compares processing of the same synthetic IPC messages and settings writes, while `renderer-history.mjs` compares event handling for the same history dataset. They are not included in installation packages, and their timings do not guarantee overall startup time or total memory usage. Local fixtures remain in `del/`. Historical baselines require the corresponding Git commit; results must identify the data volume, runtime environment and comparison commit.

Project documentation defaults to English. Main product, architecture, protocol, migration, platform and packaging documents have matching Simplified Chinese copies with the `.zh-CN.md` suffix and links between both versions. Private agent rules remain local and are not uploaded; public documentation must not depend on them.
