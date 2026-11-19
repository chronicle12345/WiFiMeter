# Windows Application Capture

English | [简体中文](WINDOWS_APP_CAPTURE.zh-CN.md)

Capture combines non-loopback ETW and loopback TCP EStats. The backend switch defaults off each session. The ordinary backend starts `wifimeter-app-capture.exe` over a dedicated local pipe; only the helper requests UAC when needed. The desktop and ordinary backend retain caller permissions. An already elevated backend starts the helper hidden.

After successful startup/migration and showing the main window, the host asks about session capture. Accepting permits helper authorization; declining either request leaves capture off without automatic retry while adapter statistics continue. Settings > General can disable the default-enabled startup question. Manual start/stop/retry does not change that preference. Unavailable capture or failed migration skips the question.

Stop, pause, or exit closes the pipe, stops the EStats thread, and ends the helper's own ETW session. Cancellation during authorization causes a late helper to exit without starting capture. A connected helper cannot be shared between backend sessions; the pipe verifies its owner.

## Measurement semantics

ETW uses a dedicated SystemTraceProvider name/GUID, subscribes to TCP/IP events, and never controls the global Kernel Logger. Non-loopback IPv4/IPv6 TCP/UDP send/receive sizes come from event `size`. TCP retransmissions count as sends; connection/failure/copy events add no bytes. No header estimate is added, so counts may differ from Linux IP-layer or adapter values.

Event payload PIDs identify processes; executable paths group applications and start times distinguish instances. Exit/PID reuse updates cached identities and marks old counts inactive. IP Helper unicast addresses, interface LUIDs, and aliases establish interface attribution; duplicate IPv6 addresses without scope are not guessed. Unknown processes become unidentified application traffic. Unknown event versions, unreadable interfaces, and lost events report `partial`.

EStats reads IPv4/IPv6 loopback `DataBytesIn`/`DataBytesOut` each second using differences. New connections, counter rollback, changed instances, and interruptions reset the baseline; bytes before discovery are not reconstructed. ETW excludes loopback, preventing duplication. EStats can continue when ETW fails, reporting `partial` with the ETW error.

Exited handles close after preserving identity. Final ETW counters remain until a successful application transaction acknowledges exact values, then retire; late events use separate application/interface counters. Exited-identity retention is bounded; later unidentifiable events report unidentified/`partial`. Older helpers retain their behavior without acknowledgement. Failed writes retain the original batch until retry succeeds before pause/stop/shutdown can clear its baseline.

Only counts attributable to associated Wi-Fi enter network history. Unattributable switch intervals are discarded and recorded as missing. Loopback rows use `networkId: ""`, `scope: "loopback"`, and `source: "WindowsTcpEStats"` for live local TCP display; they do not enter Wi-Fi application totals, adapter statistics, or quota ledgers.

## Proxy clients and the live protocol

`live.appProcesses` and `snapshot.appProcesses` include measured endpoint counters and B/s rates. A baseline without a valid difference has `measurementAvailable=false` and `null` rates. Application aggregation must not add loopback totals to physical interfaces.

`live.proxy` and `snapshot.proxy` share a structure. `proxy.clients` matches client `appId` and full four-tuple without requiring the proxy executable path. Only client-direction loopback connections contribute; reverse server connections and proxy physical bytes are excluded. Fields include `estimated=false`, `measurementAvailable`, and `sampledConnections`; missing evidence yields `null` bytes/rates. Discovery caches for 5 seconds; EStats samples each second and live events follow service sampling.

Cumulative client values sum currently observed measurable connections and may decrease on disappearance/reset; they are not daily totals. Historical `proxyEstimatedRecords` uses connection weights and `estimated=true`, separately from live measurements. Full fields/lifecycle are in the [backend contract](../backend/platform/win32/APP_TRAFFIC.md).

## Permissions and sampling limitations

ETW/EStats require administrator permissions; sampling itself never triggers UAC. Without elevation, the real helper returns `permission` / error 5. Exit does not disable the connection's system EStats switch, avoiding interference with other consumers; closure releases it.

Polling may miss connections entirely between samples, pre-discovery bytes, and final bytes. An unobserved four-tuple reuse without counter rollback is indistinguishable. Loopback UDP/QUIC is unsupported. ETW process-identity, event-loss, and interface-attribution limits remain; application and adapter totals need not match.

## Building and validation

Native builds distribute the helper with the backend. After a Visual Studio Release test build, an authorized Windows administrator terminal can run:

```powershell
./build/windows/tests/Release/windows_estats_smoke_test.exe
```

Single-configuration generators place it directly under `tests/`. The isolated IPv4/IPv6 TCP test verifies client `tx=65536`, `rx=32768`, and identity without the user database. Without elevation it returns 77 and CTest marks it skipped; ordinary fixture tests need no elevation.

Run the full production hybrid check separately:

```powershell
python backend/tests/windows_app_capture_smoke.py build/windows/app/wifimeter-app-capture.exe --require-native
```

The ETW group enumerates configured, bindable non-loopback addresses without DNS/external traffic. Local TCP/UDP verifies IPv4/IPv6 bytes, two-process attribution, repeated snapshots, and retained inactive counts. Rows require `source=WindowsEtw`; EStats cannot satisfy these assertions. Missing families are reported; at least one family must complete TCP and UDP, and the whole group cannot skip.

The loopback group holds IPv4/IPv6 TCP connections open, waits for both EStats zero baselines, then transfers. Each endpoint requires exactly `rx=65536`, `tx=65536`, `source=WindowsTcpEStats`, and no duplicate ETW row. Rows may disappear after closure; ETW-style final retention is not required. No production loopback filtering is bypassed.

`python backend/tests/windows_app_capture_smoke_test.py` needs no administrator rights and tests warm-up, connection lifetime, and failure without non-loopback addresses. Helper/address-query subprocesses use `CREATE_NO_WINDOW`. `--require-native` fails off Windows or without elevation; skips do not count as success.

Record ETW and EStats results separately for the current commit. Fixtures, standalone EStats, and old native results cannot replace full hybrid validation. Use [Testing](TESTING.md) for broader checks, isolated profiles, and private diagnostic handling.

System references: [TCP/IP](https://learn.microsoft.com/en-us/windows/win32/etw/tcpip), [UDP/IP](https://learn.microsoft.com/en-us/windows/win32/etw/udpip), [SystemTraceProvider](https://learn.microsoft.com/en-us/windows/win32/etw/configuring-and-starting-a-systemtraceprovider-session), and [GetPerTcpConnectionEStats](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getpertcpconnectionestats).
