# Windows application traffic contract

English | [简体中文](APP_TRAFFIC.zh-CN.md)

## Sources and accounting

`TcpEStatsCapture` reads IPv4/IPv6 loopback TCP each second inside the native helper. Process creation time and four-tuples distinguish connections. First discovery, interruption, instance change, and counter rollback establish baselines; pre-discovery bytes are not reconstructed. ETW supplies non-loopback events and excludes loopback. If ETW fails but EStats works, loopback remains available with `partial` and the ETW error.

Native IPC uses `interfaceId=loopback`, never a Wi-Fi `networkId`; `connectionKey` shares the proxy snapshot's address-length/address/port encoding. `source` is `WindowsEtw` or `WindowsTcpEStats`; older snapshots without it remain parseable. Loopback is live-only: `AppUsageAccumulator` does not write it into Wi-Fi `app_usage`, and consumers never add it to physical totals or history estimates.

`GetIfEntry2` maps `InOctets` to RX and `OutOctets` to TX. ETW 10/26 are sends, 11/27 receives, and 14/30 TCP retransmissions count as sends; connection/copy events add no bytes. Adapter accounting establishes a first baseline then records differences. Application records and proxy estimates do not increase adapter totals.

## Client rows

`snapshot.appProcesses` and `live.appProcesses` represent each current loopback endpoint:

```json
{
  "networkId": "",
  "appId": "C:\\Apps\\client.exe",
  "name": "client.exe",
  "processId": 123,
  "instanceId": "123:processCreationTime:socketGeneration",
  "connectionKey": "9:127.0.0.1:50001>9:127.0.0.1:8080",
  "source": "WindowsTcpEStats",
  "scope": "loopback",
  "measurementAvailable": true,
  "rxBytes": "600",
  "txBytes": "200",
  "rxPerSecond": "300",
  "txPerSecond": "100"
}
```

`rxBytes`/`txBytes` are measured cumulative values since the service baseline, not application aggregates. Rates are B/s. Invalid differences produce `measurementAvailable=false` and `null` rates. Pause, clear, re-enable, database restore, and generation changes clear baselines. Rows disappear with their connections; closure provides no final cumulative row.

Wi-Fi rows retain their actual `networkId` with `name`, `source=native`, and `scope=wifi`. Loopback cumulative fields, `connectionKey`, and `measurementAvailable` are not guaranteed for other sources. Wi-Fi rate fields can also become unavailable as described below.

## ETW retirement acknowledgement

A helper may declare `retirementSupported=true`. Only after the application transaction commits does the backend send `acknowledge <report JSON>` for saved inactive `WindowsEtw` samples. The helper releases confirmed counters, retains later increments in independent application/interface streams with stable generation-local `retired:` identifiers, and bounds recent process identities.

An old acknowledgement cannot retire either RX or TX from a newer report already emitted. Acknowledgements are idempotent and generation-specific. The backend retains an acknowledged baseline until a subsequent supported report omits that instance. Older helpers omit the capability and keep inactive cumulative samples; EStats lifecycle is unchanged.

## Sampling clocks and rate expiration

Helper reports optionally contain JSON integers `sampledAtMs` for the ETW snapshot and `loopbackSampledAtMs` for actual EStats cache updates. They use the collector's `GetTickCount64` monotonic milliseconds, not Unix/date time. EStats-only operation sets both equally. Missing/zero fields use service read time for old-format compatibility; updating both binaries enables source-clock behavior.

Within a generation, repeated/earlier timestamps do not advance baselines. EStats independently uses `loopbackSampledAtMs`; a newer ETW report may still contain unchanged EStats data. Fresh samples calculate B/s from byte increments over the actual millisecond interval; a fresh zero increment returns zero. Generation changes, pause, permission failures, and storage failures clear live rate baselines. Failed application writes retain the original report, Wi-Fi attribution, and time; accounting baselines advance only after successful commit. No new database field is required.

Repeated samples retain the last valid rate temporarily. More than `max(5 seconds, 2 × intervalSeconds)` without a new sample makes `measurementAvailable=false` and both rates `null`. Expiration uses service elapsed time since first receipt, independently of collector clocks. Intervals of 2/5/10 seconds expire after 5/10/20 seconds; a freshly received valid snapshot is not already expired because its interval is longer. Field names and B/s units remain unchanged.

## Live proxy clients

`live.proxy` and `snapshot.proxy` share a structure. `proxy.clients` retains `appId`, `name`, `proxyName`, `connections`, and `pathAvailable`, with:

- `source=WindowsTcpEStats`, `scope=loopback`, `estimated=false`.
- `measurementAvailable`: at least one current client four-tuple has a usable difference.
- `sampledConnections`: distinct connections with byte evidence, potentially fewer than `connections`.
- `rxBytes`, `txBytes`, `rxPerSecond`, `txPerSecond`: decimal strings, all `null` without evidence.

Match only client `appId` plus the complete client-direction four-tuple. An unreadable proxy path does not prevent byte matching; `detectedClients` retains tuples when listener PID is known. Reverse server connections and proxy physical bytes are excluded.

Cumulative values sum currently observed measurable connections and may decrease after closure, proxy snapshot replacement, or reset; they are not daily totals. Discovery caches for 5 seconds, EStats samples each second, and live events follow service samples. A connection can reach `appProcesses` before `proxy.clients`. [Proxy attribution](PROXY_ATTRIBUTION.md) owns identity completion and historical `estimated=true` groups; estimates must not be added to measured live values.

## Permissions, limits, and validation

EStats requires an administrator token; the sampling module never triggers UAC and explicitly returns `permission` without authorization. The helper authorization flow obtains it. Exit leaves the system EStats switch enabled for concurrent consumers; connection closure releases it.

Polling may miss short-lived connections, pre-discovery bytes, and final bytes. Four-tuple reuse without observed disconnection or counter rollback cannot be reliably identified. Loopback UDP/QUIC is unsupported. ETW retains unreadable-process and event-loss limits.

CTest entry points include:

- `loopback_live_test`: baselines, rates, resets, process instances, disappearance, generation/permission changes, deduplication, and IPC.
- `proxy_service_test`: isolated live-byte matching with unreadable proxy paths and no `app_usage` writes.
- `windows_app_network_event_test`: IPv4/IPv6 and IPv4-mapped loopback recognition.

Actual ETW/EStats and helper-script validation are maintained in [Windows capture](../../../docs/WINDOWS_APP_CAPTURE.md#building-and-validation). [Testing](../../../docs/TESTING.md) defines broader entry points and evidence limits; privileged skips do not establish native success.
