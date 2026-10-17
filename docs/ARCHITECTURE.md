# Project architecture

English | [简体中文](ARCHITECTURE.zh-CN.md)

The shared desktop application is in `apps/desktop/`. Windows and Linux share the renderer and host. Tauri/Rust provides the system WebView and desktop capabilities; Node runs business modules; the local C++ backend owns native collection and business storage. See the [CI and release matrix](PACKAGING-MATRIX.md) for active targets.

## Current data flow

```text
renderer/app.js → data/backend-client.js → tauri/bridge.js → Rust → Node → wifimeter-backend (JSON Lines)
       └──────────────────────────────────→ data/model.js
renderer → tauri/bridge.js → Rust → dialogs, windows, tray, notifications
                                → Node → autostart, migration, file I/O, updates, traffic control
```

`renderer/app.js` composes navigation, rendering, and events. Reusable input/display belongs in `renderer/ui/`; queries and calculations belong in `renderer/data/`. `ui/form-autosave.js` owns validation, save state, retries, retention cleanup, and draft discard through callbacks; the entry point owns confirmations and refreshes. Synthetic snapshots in `tests/fixtures/snapshot.js` are excluded from production assets.

`ui/application-workspace.js` and `ui/application-table.js` share view controls and five-column rows. The application page starts live; the network drawer starts with history. Each view keeps its own search, sort, and source selection. Speed and byte preferences format live and historical values respectively. Missing measurements display a dash; badges distinguish measured/unavailable rates, native records, and estimates. Both views use the same application drawer and controls.

`data/proxy-live.mjs::proxyLiveProcesses`, called through `data/application-view.js` and the floating window, allocates an identified proxy's measured physical-network rates by current client TCP connection counts. Direct client rows remain, estimated shares are marked, and attributed proxy rates are replaced to count them once. Unknown clients and unallocated shares remain estimated unattributed traffic. Missing identities, weights, or measurements preserve native/unavailable values. Adapter counters, quotas, and stored records are unchanged. The application page and network drawer retain independent live choices for the session and restart with native capture. The floating window persists `miniIncludeProxyEstimates` separately from proxy exclusion; accumulated usage reads actual minute records.

`data/history.js` aggregates applications; `data/application-view.js` derives rows, unsearched totals, and export availability per render. `ui/app-icons.js` shares pending requests, limits concurrency, and drops queued requests without a connected matching avatar. `data/application-proxy.js` matches known application/proxy identifiers and paths, never inferring identity from a display name. Historical estimates replace proxy rows only when download and upload totals each match the same network/date/proxy's native totals. Direct client traffic remains; partial-day and minute/hour details omit daily estimates. Local TCP rates remain separate from historical bytes, adapter totals, and quotas. Fields are defined in [Contracts](../contracts/README.md).

Proxy detail validation checks candidate groups and retains one result keyed by history revision, source arrays, identity, and selected range. Snapshots, application increments, estimate replacement, clears, and proxy configuration saves advance that revision; speed events do not. Current clients and measurement availability are reread. Closing the drawer releases history references. Callers without a revision are not cached because their arrays may mutate.

Node's `host/backend.cjs` starts the backend and matches responses by request id; events are separate. Failures reach the renderer as `{ ok: false, error }`, retaining codes and messages. C++ is authoritative for history, quotas, and network settings. `host/desktop-runtime.cjs` receives capabilities from `tauri/native-adapter.cjs`; `host/main.cjs` composes them without intercepting module loading or using the Electron SDK. Browser tests run the real renderer/bridge and isolated Node host with system substitutes; native-host coverage is separate.

`promptAppCollection` in `window-preferences.json` defaults to `true`. After successful startup/migration and showing the main window, the host asks about session capture. Only acceptance sends `setAppCollection({ enabled: true })` and permits helper authorization. Declining either question leaves capture off without another automatic attempt; adapter statistics continue. Unavailable capture or failed migration skips the question. Disabling the preference suppresses future questions; manual controls do not change it. The backend switch defaults off each session.

`host/updates.cjs` separates `updates:check`, `updates:download`, and `updates:install`. Checks read official metadata and select the matching asset; startup checks notify only. Confirmed downloads verify length/SHA-256, reuse intact cache, and stop at `downloaded` without stopping collection. Installation requires a separate confirmation and cache revalidation before settings/database save, graceful shutdown, and installer handoff. Deferral retains the candidate. After asynchronous settings confirmation, the host rechecks import, exit, and recovery state before stopping collection.

The renderer completes the current range query before loading minutes. Same-range minute requests are shared; late responses cannot replace a newer range. Complete-day hourly exports can use older hourly records; partial ranges aggregate at minute boundaries. Local ranges include the entire ending minute. Refresh after initialization failure repeats the handshake and restores subscriptions, preserving a date chosen during that handshake.

## C++ backend

`backend/platform/network_platform.h` defines platform-independent collection, identity, and disconnect interfaces:

| Implementation | Counters | Identity | Disconnect |
| --- | --- | --- | --- |
| `backend/platform/linux/` | `/proc/net/dev` | Locale-independent `nmcli` output | `nmcli dev disconnect`, then verification |
| `backend/platform/win32/` | IP Helper `GetIfTable2` | WLAN `WlanQueryInterface` | `WlanDisconnect`, then polling |

Adapters report facts/typed failures without UI text. They check identity before and after counters and discard samples spanning a switch. Disconnect requires the expected association, performs the operation, then verifies it. Windows separates system calls from testable decisions:

```text
platform/win32/      Win32 system calls and field transfer
platform/windows/   Sampling/disconnect decisions through injected SystemApi; UTF-16/UTF-8 and counter conversion
```

`core/` owns byte formatting, local calendar/network keys, accumulation, and quotas. First samples, counter rollback, identity changes, or confirmed adapter disappearance rebuild baselines; temporarily unreadable identity retains a baseline for a bounded interval. Unassignable traffic is discarded with typed gap events. Quota ledgers are independent of historical aggregation. Byte interfaces use decimal strings and JavaScript `BigInt`; SQLite writes reject values outside signed 64-bit range.

`storage/` incrementally persists daily, hourly, minute, and application records, networks, ledgers, and preferences. Schema 6 adds `minute_usage` and `app_minute_usage`; existing records retain precision. Time-based minute allocation preserves sample totals. Backup, restore, clear, network deletion, and retention include minutes. `coverage_gaps` distinguishes missing intervals from actual zero. Linux uses system SQLite; Windows uses the bundled amalgamation.

A failed network-usage write retains one in-memory batch with its original time and attribution. Retry precedes new sampling, without unbounded queuing. Successful clear/restore discards it; import, retention cleanup, and normal shutdown must flush it. Forced termination can lose this pending batch. Gap queries follow local calendar-day boundaries across retained history.

`ipc/` uses `{id, method, params}` requests, `{id, ok, result|error}` responses, and `{event, ...}` events. POSIX waits with `poll`; Windows uses `WaitForSingleObject`. Collection uses local pipes and initiates no external requests. The Node host explicitly supplies the database path; startup/exit failures retain errors and trigger recovery. Network access belongs to update metadata/downloads, user-opened release pages, and missing WebView2 installation. [Contracts](../contracts/README.md) and [Migration](MIGRATION.md) own protocol and import guarantees.

## Responsibility boundaries

| Module | Responsibility |
| --- | --- |
| Renderer | Display, input, filters, interaction state |
| Tauri / Rust | System WebView, windows, tray, dialogs, restricted IPC |
| Node business host | Processes, migration, updates, files, system settings, traffic control |
| C++ backend | Native collection, accounting, quotas, business storage |
| Platform adapters | Windows/Linux API isolation |
| contracts | Shared fields and protocol conventions |
| packaging | Target installer assembly |

Add platform adaptation only for an actual platform difference.

## Build layout and compatibility

Root npm commands provide entry points; desktop dependencies/lockfile stay in `apps/desktop/`. Backend output uses `build/` on Linux and `build/windows/` on Windows. Packages include the matching backend; Windows never reads Linux runtime paths.

Product identity is centralized in `apps/desktop/host/product.cjs` and tested. Both platforms use `WiFiMeter`. Preserve Windows identifier `io.wifimeter.demo` and `%APPDATA%\WiFiMeter Demo` across display-name changes; Linux uses standard XDG directories. Before starting Node/backend, Windows holds the Electron-compatible, user-data-scoped `lockfile`, preventing simultaneous collectors. Process exit releases it; WebView2 uses a separate `webview2` subdirectory. Legacy recovery is maintained in [Migration](MIGRATION.md).

Build commands belong to [Packaging](../packaging/README.md), verification/evidence to [Testing](TESTING.md), and active targets/publication to the [CI matrix](PACKAGING-MATRIX.md). Rules and decision records follow [Development](DEVELOPMENT.md); translation maintenance follows [Bilingual documentation](i18n/README.md).
