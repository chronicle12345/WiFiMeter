# Application traffic collection and proxy attribution

English | [简体中文](APPLICATION_TRAFFIC.zh-CN.md)

This reference expands the application traffic contracts in [data formats and protocol boundaries](README.md).

## Application collection pipeline

`setAppCollection` accepts `{enabled: boolean}`. Enabling collection applies only to the current backend session; it defaults to disabled after a restart. If there is no collection source, the result is `unavailable`. States include `disabled`, `starting`, `running`, `paused`, `permission`, `unavailable` and `partial`. Global `setPaused` also pauses application collection, which establishes a new baseline when resumed. Stopping application collection preserves existing history.

`live` events carry `appCollection` and `appProcesses`. Separate `appUsage` events carry daily increments in `records` and new gaps in `gaps`. Application increments do not update adapter totals or quota ledgers. Database schema version 3 adds `scope` to `coverage_gaps`; existing records migrate to `network`, while application records use `apps`.

The collection source outputs `{state, generation, detail, samples}`. Each sample contains `{interfaceId, appId, name, instanceId, processId, rxBytes, txBytes, active}`. Byte counters accumulate from the start of the same generation. The first snapshot establishes only a baseline; new process instances are subsequently counted from zero. `instanceId` distinguishes PID reuse, while `appId` groups usage across processes. Exited processes set `active: false` and retain their cumulative counters until confirmed saved. A changed or unknown Wi-Fi identity for an interface discards the boundary interval. Counter resets, source restarts and permission failures leave separate gap records.

Windows helper reports optionally declare `retirementSupported: true`. After a successful application transaction, the backend sends `acknowledge <report JSON>` for saved inactive ETW samples. The helper removes only their confirmed bytes; late increments continue in a separate cumulative application/interface stream with a `retired:` instance identifier. The backend retains the old instance baseline until a subsequent supported report confirms its disappearance. Older helpers omit the capability, receive no acknowledgement and retain their existing cumulative behavior. Failed application transactions retain the original report, network attribution and time for retry; no acknowledgement is sent before commit.

Tests use `--fake-apps <JSON file>` or `WIFIMETER_FAKE_APPS` alongside the real process, IPC and database. The Linux native source is available only when the helper is built, and collection remains disabled by default; see [Linux application capture](../docs/LINUX_APP_CAPTURE.md) for accounting semantics and authorization verification. The Windows native source also defaults to disabled and connects to an authorized helper through a dedicated pipe; see [Windows application capture](../docs/WINDOWS_APP_CAPTURE.md).

## Proxy clients and application details

`proxy.clients` reports currently observed local proxy connections. Each entry includes `appId`, `name`, `proxyAppId`, `proxyName`, `connections`, `pathAvailable` and `measurementAvailable`, together with byte counters and rates when measurable. `proxyAppId` carries the observed proxy application identifier for a connection whose ownership is known. It is an empty string for a detected client whose proxy path is unavailable; `pathAvailable` is then `false`. Display names are not identity evidence and must not be used to infer this missing identifier. Identity availability and traffic measurement availability are separate facts.

Local TCP rates come from the measured connection data and use byte-per-second values. When `measurementAvailable` is false, the renderer shows a dash rather than zero, even if an older numeric field is present. Stopping or pausing collection makes the displayed proxy rates unavailable. These rates are separate from adapter totals, quota ledgers and stored historical estimates; they do not reconstruct UDP/QUIC traffic or exact historical per-client usage. Application detail matching uses the client `appId` or the explicit `proxyAppId`, with case-insensitive normalized matching for Windows paths.

`proxyEstimatedRecords` contains daily attribution rows with `{networkId, date, proxyAppId, appId, name, rxBytes, txBytes, estimated, unattributed}`. Historical attribution uses observed connection weights. Before the renderer substitutes these rows for native proxy records, both download and upload sums must independently match the native totals for the same network, date and proxy identifier. Otherwise, native records remain visible. Direct client records are preserved. Details apply the selected network and date range, and a selected day or month narrows the estimate rows further; partial-day ranges and minute/hour details omit daily estimates.
