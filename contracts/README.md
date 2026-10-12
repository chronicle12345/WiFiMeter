# Data formats and protocol boundaries

English | [简体中文](README.zh-CN.md)

This document records data conventions shared by the frontend and backend. See `backend/ipc/messages.h` for the actual JSON Lines protocol and methods, and `apps/desktop/renderer/data/backend-client.js` for the desktop client.

## Snapshot format

Data validation is implemented by `validateSnapshot` in `apps/desktop/renderer/data/model.js`. Backend snapshots retain `version: 1` and use `backend` as their source.

| Field | Content |
| --- | --- |
| `version`, `source` | Data version and source; native collection uses `backend` |
| `networks` | Network identifiers, SSIDs, notes, quotas and warning settings |
| `records` | Upload and download bytes grouped by local date and network |
| `hourly` | Hourly details |
| `minuteRecords` | Network minute usage, including `date`, `time`, `hour`, `minute`, `networkId` and bytes in both directions |
| `appMinuteRecords` | Application minute usage, adding `appId` and `name` to the network minute fields |
| `usageRevision` | Sampling commit sequence for the current session, passed as a decimal string |
| `appRecords` | Independent daily application usage queried from SQLite, not added to adapter totals |
| `appCollection` | `enabled`, `available`, `state` and error detail in `detail` |
| `appProcesses` | Recently sampled process instances, PIDs, networks and download/upload rates |
| `appGaps` | Application collection gaps, separate from adapter coverage records |
| `settings` | Display units, refresh interval, retention duration and preferences |
| `live` | Local connections, collection state, rates and update time |

Byte counters use decimal strings, and JavaScript accumulation uses `BigInt`. Date keys use the local date in `YYYY-MM-DD` format. Usage exports use `type: "usage-export"` and are not complete backups. `wifimeter-ui-demo` is used only by legacy demo test fixtures.

Application records have the format `{networkId, date, appId, name, rxBytes, txBytes}`. `appId` is a stable application identifier; a PID must not be used as a historical identifier. `snapshot` queries matching application records with `networkKey`, `from` and `to`. Complete backend backups use `backupType: "wifimeter-backend-backup"` and include `appRecords`. Restoration accepts older backups that lack this field but rejects invalid dates, unknown networks, invalid byte values and duplicate daily application records. Native collection uses eBPF on Linux and ETW on Windows; adapter totals are not distributed proportionally among applications.

## Application collection pipeline

`setAppCollection` accepts `{enabled: boolean}`. Enabling collection applies only to the current backend session; it defaults to disabled after a restart. If there is no collection source, the result is `unavailable`. States include `disabled`, `starting`, `running`, `paused`, `permission`, `unavailable` and `partial`. Global `setPaused` also pauses application collection, which establishes a new baseline when resumed. Stopping application collection preserves existing history.

`live` events carry `appCollection` and `appProcesses`. Separate `appUsage` events carry daily increments in `records` and new gaps in `gaps`. Application increments do not update adapter totals or quota ledgers. Database schema version 3 adds `scope` to `coverage_gaps`; existing records migrate to `network`, while application records use `apps`.

The collection source outputs `{state, generation, detail, samples}`. Each sample contains `{interfaceId, appId, name, instanceId, processId, rxBytes, txBytes, active}`. Byte counters accumulate from the start of the same generation. The first snapshot establishes only a baseline; new process instances are subsequently counted from zero. `instanceId` distinguishes PID reuse, while `appId` groups usage across processes. Exited processes must retain their cumulative counters within the generation and set `active: false`. A changed or unknown Wi-Fi identity for an interface discards the boundary interval. Counter resets, source restarts and permission failures leave separate gap records.

Tests use `--fake-apps <JSON file>` or `WIFIMETER_FAKE_APPS` alongside the real process, IPC and database. The Linux native source is available only when the helper is built, and collection remains disabled by default; see [Linux application capture](../docs/LINUX_APP_CAPTURE.md) for accounting semantics and authorization verification. The Windows native source also defaults to disabled and connects to an authorized helper through a dedicated pipe; see [Windows application capture](../docs/WINDOWS_APP_CAPTURE.md).

## Proxy clients and application details

`proxy.clients` reports currently observed local proxy connections. Each entry includes `appId`, `name`, `proxyAppId`, `proxyName`, `connections`, `pathAvailable` and `measurementAvailable`, together with byte counters and rates when measurable. `proxyAppId` carries the observed proxy application identifier for a connection whose ownership is known. It is an empty string for a detected client whose proxy path is unavailable; `pathAvailable` is then `false`. Display names are not identity evidence and must not be used to infer this missing identifier. Identity availability and traffic measurement availability are separate facts.

Local TCP rates come from the measured connection data and use byte-per-second values. When `measurementAvailable` is false, the renderer shows a dash rather than zero, even if an older numeric field is present. Stopping or pausing collection makes the displayed proxy rates unavailable. These rates are separate from adapter totals, quota ledgers and stored historical estimates; they do not reconstruct UDP/QUIC traffic or exact historical per-client usage. Application detail matching uses the client `appId` or the explicit `proxyAppId`, with case-insensitive normalized matching for Windows paths.

`proxyEstimatedRecords` contains daily attribution rows with `{networkId, date, proxyAppId, appId, name, rxBytes, txBytes, estimated, unattributed}`. Historical attribution uses observed connection weights. Before the renderer substitutes these rows for native proxy records, both download and upload sums must independently match the native totals for the same network, date and proxy identifier. Otherwise, native records remain visible. Direct client records are preserved. Details apply the selected network and date range, and a selected day or month narrows the estimate rows further; partial-day ranges and minute/hour details omit daily estimates.

## Data and platform conventions

- Network identity: `core/network_key.h` defines the key strategy. It prefers the connection profile UUID, which is stable across restarts and naturally satisfies `network.id`'s `^[-a-zA-Z0-9_]+$` pattern. If unavailable, it falls back to `ssid_` followed by the FNV-1a hash of the SSID. Deleting and recreating a Wi-Fi profile therefore splits history into two records; the presentation layer can group them by `ssid`.
- Record storage: `storage/` incrementally stores daily, hourly, minute and application records. The ledger is authoritative for usage in the current period and resets at period boundaries instead of being recalculated from records. `snapshot` queries by date and network range, with minute queries enabled as needed. Complete backups are marked `wifimeter-backend-backup` and are separate from usage exports. See the sections below and [migration and recovery](../docs/MIGRATION.md) for query and backup fields.
- Coverage gaps: the database records `paused` / `offline` / `counter_reset` / `reattributed` / `detached` / `identity_unknown` in `reason`. These values appear in the protocol and are part of its public contract; changes require compatibility handling.
- `live.connections[].since`: the backend records when it first observed the current connection. This must not be treated as the actual connection start time reported by the operating system.
- `live.connections[].adapterAlias`: Linux uses the adapter's vendor and product name, falling back to the kernel interface name when unavailable.

## Multiple quota warning thresholds

Network settings and total WiFi quota settings return both `warnPercents` and the compatibility field `warnPercent`. `warnPercents` is a nonempty numeric array. Each item must be finite and within 1..100; fractional values are allowed. The backend removes duplicates and stores values in ascending order. There is no separate item-count limit; the existing IPC request-size limit applies. `warnPercent` returns the first sorted item.

An update containing both fields uses the array. An update containing only the legacy scalar upgrades it to a single-item array. Omitting both preserves the current setting. If a legacy scalar is supplied, it must also be valid. Networks use `quotaPeriod`; the total quota uses `period`.

For example, saving `{ "warnPercents": [90, 50, 75.5, 50] }` returns `{ "warnPercents": [50, 75.5, 90], "warnPercent": 50 }`. Each threshold warns only once per period for both network and total quotas. Crossing multiple thresholds emits one `quotaWarn` per threshold; the event's `warnPercent` identifies the threshold triggered. Notified thresholds are stored in the ledger's `notifiedWarnPercents`, preserving deduplication across restarts and backup restoration. Notification tracking starts again at a period boundary or after usage is cleared.

Reaching 100% of the total quota still emits the existing `quotaLimit` event. The 100% warning threshold and the quota-limit event are independent events. Adding or removing warning thresholds does not clear notification records for other thresholds. Changes to the total quota limit retain the existing notification-reset behavior.

Complete backups preserve both settings fields and the ledger's `notifiedWarnPercents`. Scalars from older backups and legacy imports are upgraded automatically. Legacy total-quota `warningNotified: true` is upgraded to a notification record for the corresponding single threshold, preventing another warning for that threshold after restoration.

## Minute queries

Database schema version 6 adds `minute_usage` and `app_minute_usage`. Upgrades do not distribute existing daily or hourly records into minutes; minute statistics start with actual collection after the upgrade. Samples spanning minutes are allocated according to the seconds covered in each minute. Integer remainders carry into subsequent minutes, and the sum of all minutes equals the original sample increment. Daily, hourly and minute statistics for new samples use the same allocation result; existing daily and hourly records keep their original values.

`snapshot` and `exportUsage` accept `fromTime` and `toTime` in `HH:mm` format, defaulting to `00:00` and `23:59`, respectively. Queries across dates trim only the starting and ending days and include the entire ending minute. For partial-day ranges, `records` and `appRecords` aggregate actual minute data; complete-day ranges continue to return the original daily statistics. `exportUsage` accepts `grouping` of `minute`, `hour` or the default `day`. Grouped details appear in `records`, and minute details also appear in `minuteRecords`.

`usage` and `appUsage` events add `minuteRecords` and `usageRevision`. Minute rows in application events include the application fields. Both events from the same sampling round share a sequence number. Sampling and requests execute on the same service thread, so snapshot reads cannot occur between network and application commits. The client replays only subsequent increments whose sequence exceeds the snapshot sequence. Complete backups include both types of minute data; restoration also accepts older backups without minute fields. Retention trimming, clearing and network deletion also process minute records.

To avoid reading large numbers of application minute rows automatically for daily, monthly and all-time statistics, `snapshot` does not read minute tables by default. It returns empty minute arrays and `minuteRecordsIncluded: false`. Pass `includeMinutes: true` for minute charts or details. Queries with `fromTime` or `toTime` automatically read minute data and return `minuteRecordsIncluded: true`. Minute increment events always include actual minute rows. Default daily exports do not read minute tables either.
