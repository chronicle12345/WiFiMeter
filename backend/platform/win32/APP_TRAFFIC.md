# Windows Live Application Sampling and Proxy Client Contract

English | [简体中文](APP_TRAFFIC.zh-CN.md)

## Data sources

The v1.1.1 implementation in `src/AppNetworkSampler.cs` and `src/AppMonitor.psm1` sampled TCP EStats once per second and calculated differences between data-byte counters, including loopback connections. The first sample and any counter rollback only established a baseline. Connection snapshots and historical estimates weighted by connection counts form a separate data path.

The current implementation retains ETW for non-loopback network events. Within the running helper, `TcpEStatsCapture` reads IPv4/IPv6 loopback TCP EStats once per second and identifies connections by process creation time and the four-tuple. It establishes a new baseline when a connection first appears, sampling is interrupted, the process instance changes, or counters roll back. ETW explicitly excludes loopback events to avoid counting the same traffic twice. If ETW cannot start but EStats is available, loopback sampling remains available, with a `partial` status and the reason for the ETW failure.

EStats accumulates differences in `DataBytesIn` and `DataBytesOut`; it does not estimate connection byte counts or recover bytes transferred before a new connection is first discovered. Native IPC uses `interfaceId=loopback`. Its `connectionKey` uses the same address-length, address, and port encoding as proxy connection snapshots. This identifier does not represent a Wi-Fi interface and is not mapped to any Wi-Fi `networkId`. Native helper IPC also includes a `source` field: `WindowsEtw` for ETW rows and `WindowsTcpEStats` for EStats rows. Native validation uses it to distinguish the actual source; older snapshots without the field remain parseable.

## Client JSON

Loopback rows in `snapshot.appProcesses` and `live.appProcesses`:

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

Each loopback row represents one current connection endpoint, rather than an application aggregate. `rxBytes` and `txBytes` are measured cumulative values for that connection since the current service baseline. Rates use B/s and the actual interval between snapshots received by the service. When the first sample, a counter reset, or another condition prevents a valid difference, `measurementAvailable=false` and the rates are `null`. Pausing, clearing counters, re-enabling capture, restoring the database, and a capture `generation` change all clear live baselines. The row disappears when its connection disappears; no final cumulative value is provided after closure.

Existing Wi-Fi rows continue to use their actual `networkId` and add `name`, `source=native`, and `scope=wifi`, retaining their existing rate semantics. Loopback-specific cumulative values, `connectionKey`, and `measurementAvailable` are not guaranteed on rows from other sources. The UI must not add loopback bytes to Wi-Fi or physical-interface totals.

`live.proxy` and `snapshot.proxy` have the same structure. `proxy.clients` retains `appId`, `name`, `proxyName`, `connections`, and `pathAvailable`, and adds:

- `source=WindowsTcpEStats`, `scope=loopback`, and `estimated=false`.
- `measurementAvailable`: at least one current client four-tuple has a usable counter difference.
- `sampledConnections`: the number of distinct client connections with byte evidence in this sample; it may be lower than `connections`.
- `rxBytes`, `txBytes`, `rxPerSecond`, and `txPerSecond`: decimal strings; all are `null` when there is no byte evidence.

Proxy client bytes are matched only by `appId` and the complete client-direction four-tuple. The proxy executable path does not have to be readable. When a listener PID is known but its path cannot be read, `detectedClients` still retains client four-tuples and uses the same matching rules. Reverse server-side connections and the proxy's physical-interface bytes are excluded from measured client values.

The cumulative values in `proxy.clients` sum currently observed, measurable connections, rather than the day's total. They may decrease after a connection closes, the proxy snapshot is replaced, or counters are cleared. Connection discovery retains its 5-second cache; EStats samples at 1-second intervals, and `live` updates on each service sample. A new connection may appear in `appProcesses` before it appears in `proxy.clients`. Historical `proxyEstimatedRecords` remains `estimated=true` and must not be added to live measured values.

## Permissions, limitations, and validation

Enabling EStats requires an administrator token. The sampling module does not trigger UAC; the existing helper authorization flow obtains permission. A non-administrator token explicitly returns `permission`. To avoid affecting concurrent consumers, the collector does not disable the system-level per-connection EStats switch on exit. The system releases those statistics when the connection closes.

Polling can miss short-lived connections opened and closed between samples, bytes transferred before first discovery, and the final bytes before closure. If a four-tuple is quickly reused without an observed disconnection and its counters do not roll back, the reuse cannot be reliably identified. Loopback UDP/QUIC is outside this implementation's scope. Non-loopback ETW sampling retains its event-loss and unreadable-process limitations.

Test entry points:

- `loopback_live_test`: separation of cumulative values and rates, first-sample baselines, counter rollback, PID instance changes, disappearing connections, counter clearing, source restarts, permissions, four-tuple deduplication, and native IPC serialization.
- `proxy_service_test`: an isolated SQLite database verifies live loopback bytes, byte matching when the proxy path is unreadable, `live.proxy`, and the absence of writes to `app_usage`.
- `windows_app_network_event_test`: IPv4, IPv6, and IPv4-mapped IPv6 loopback recognition.
- `windows_app_capture_smoke.py`: required ETW coverage of non-loopback IPv4/IPv6 TCP/UDP, followed by EStats byte and closure validation after long-lived loopback TCP connections warm up. At least one non-loopback address family must complete both TCP and UDP validation; the entire group cannot be skipped. See the [Windows capture guide](../../../docs/WINDOWS_APP_CAPTURE.md).
- `windows_app_capture_smoke_test.py`: without elevated permissions, verifies the warm-up handshake, open-connection lifetime, and explicit failure when there are no non-loopback addresses.
- `windows_estats_smoke_test`: in an administrator environment, creates isolated IPv4/IPv6 local connections and checks client `tx=65536`, `rx=32768` bytes and process identity. Without administrator permission, it returns 77 and is marked skipped by `ctest`; it does not trigger UAC or access a database.

## 2026-10-02 sampling timing fix

The UI fixed the settings proxy list remaining on its first snapshot. The backend had a separately reproducible sampling issue: after waiting 100 milliseconds, `WindowsAppTrafficSource` could return the same helper report. EStats updated its cache once per second, so a new ETW report could also carry unchanged EStats counters. Previously, each read advanced the counter and time baselines, causing repeated reads to return 0 B/s and the next increment to use the wrong interval. Wi-Fi application rows also calculated rates using whole-second intervals.

Helper reports add two optional JSON integer fields. `sampledAtMs` records the ETW snapshot time in milliseconds from the collector's `GetTickCount64` monotonic clock; `loopbackSampledAtMs` records when the EStats cache was actually updated. They are equal when only EStats is running. A missing field or a value of 0 indicates the old format, which continues to use the service read time. These fields are not Unix timestamps and must not be directly subtracted from date fields in `snapshot`. Update both the backend and app-capture binaries to obtain the complete fix.

Reports with the same or an earlier timestamp within a `generation` do not advance the baseline; EStats uses `loopbackSampledAtMs` independently. A new snapshot calculates B/s from the byte increment divided by the actual millisecond interval. A new snapshot with unchanged bytes still returns 0. Generation changes, pausing, permission failures, and storage failures continue to clear baselines. No database fields were added.

The rate field names and units in live `appProcesses` and `proxy.clients` remain unchanged. Repeated snapshots temporarily retain the last valid rate. If no new sample arrives for more than `max(5 seconds, 2 × intervalSeconds)`, `measurementAvailable` becomes `false`, and `rxPerSecond` and `txPerSecond` become `null`. Wi-Fi rows may also contain these unavailable-measurement values. Expiration uses elapsed service time since that snapshot was first received; it is not mixed with the collector's monotonic clock. Sampling intervals of 2, 5, and 10 seconds use expiration thresholds of 5, 10, and 20 seconds, respectively, so a newly arrived valid snapshot is not treated as expired because of a longer sampling interval.

The regression was reproduced before the fix: over 1250 milliseconds with a 1000-byte increment, the original loopback path first returned 500 B/s, then 0 on a repeated read, then 1111 on the next sample. The fixed path consistently returns 800 B/s using source sampling times. The service Wi-Fi path previously returned 500, 0, and 1000; after the fix it returns 800, 800, and 800, while the database cumulative value remains 2000 bytes. Tests also cover a new zero increment, expiration, out-of-order reports, generation restarts, and 2/5/10-second settings.

## 2026-10-02 proxy identity completion and historical estimate events

The backend running without elevation can identify the proxy PID through `GetExtendedTcpTable`, while `QueryFullProcessImageName` may fail. When only ports were configured and `processNames` was empty, the previous implementation produced only `detectedClients` and did not save `proxy_apps` or `proxy_observations`. Historical estimates had neither a path nor a configured name to match, so they were empty. This prevented existing native proxy records from matching client estimates.

`detectedClients` now retains `proxyProcessId` internally in the backend. The service completes identity only from a newly arrived helper EStats snapshot in the current sample: it requires a nonempty `generation` and increasing `loopbackSampledAtMs`; the same snapshot must contain both the complete client four-tuple and the proxy's reverse four-tuple, with the proxy PID matching the TCP query result. Process instances include creation time. Identity is not completed if the same PID has different creation times or paths, the client endpoint is missing, the path is unknown, the source is incorrect, or the snapshot is repeated or out of order. There is no PID-to-path cache across samples. A new generation revalidates evidence from the current sample and does not reuse an old connection identity.

After validation, the actual proxy path and deduplicated connection keys for the observation date are saved to existing tables. Client weights for past dates are not backfilled, and `app_usage` is not modified. Old records without observations on their date can only produce `proxy/unattributed`; today's client connections are not used for past dates. Historical estimates still allocate traffic by connection count and do not represent measured per-client history.

`live` adds the optional `proxyEstimatedUpdates` field:

```json
{"proxyEstimatedUpdates":[{"networkId":"network-key","date":"2026-10-02","proxyAppId":"C:\\proxy.exe","records":[]}]}
```

Each `records` group contains cumulative estimate rows for that network, date, and complete proxy path, using the same fields as `snapshot.proxyEstimatedRecords`. Consumers replace the entire group rather than add it as an increment; an empty array clears the matching group. The backend recalculates only application records for the sampling date and compares each group with the last group sent. Changes in native cumulative values or observation weights cause changed groups to be sent. Crossing midnight does not clear the previous day's history. The first sample may send all estimate groups for the current date; complete history still comes from `snapshot`. Path comparison ignores case and does not substitute a filename for a full path. The frontend must verify RX and TX conservation separately before replacing native proxy rows, and must not accumulate estimate rows together with the original rows for the same proxy.

Upload-direction checks: `GetIfEntry2` maps `InOctets` to RX and `OutOctets` to TX. ETW events 10/26 are sends and 11/27 are receives; TCP retransmission events 14/30 count toward sends, while connection and copy events do not count toward bytes. The network-interface core establishes only a baseline on its first read and records differences thereafter. Application records, live loopback data, and proxy estimates are not added to network-interface totals.

Loopback is used only for live display. `AppUsageAccumulator` does not map loopback to a Wi-Fi `networkId`. A long-term approach that avoids double counting should retain the network-interface and native proxy ledgers and store verified client loopback bytes as history in a separate scope. If used to attribute external-network traffic, it should allocate the proxy's external-network amount to clients using the same time window and direction, preserve the unattributed remainder, and mark the allocation as estimated. The values must not be directly added together. This work did not extend the database or change that contract.
