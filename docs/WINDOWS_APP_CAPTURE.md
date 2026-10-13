# Windows Application Capture

English | [简体中文](WINDOWS_APP_CAPTURE.zh-CN.md)

Application capture combines non-loopback ETW and loopback TCP EStats. Capture is disabled by default, and its setting applies only to the current backend session. The backend running without elevation starts `wifimeter-app-capture.exe` through a dedicated local pipe. When needed, the user authorizes this helper through UAC; the desktop application and ordinary backend retain the caller's permissions. An already elevated backend starts the helper directly without a visible window.

Stopping, pausing, or exiting closes the pipe. The helper stops its EStats sampling thread and ends its own ETW session. If capture is canceled while authorization is in progress, a helper that starts later exits because the pipe is already closed and does not create a capture session. Backend sessions cannot share an already connected helper; the pipe verifies its owning process.

## Measurement semantics

ETW uses a SystemTraceProvider session with a dedicated name and GUID, subscribes only to TCP/IP network events, and does not control the global Kernel Logger. It parses non-loopback IPv4/IPv6 TCP and UDP send/receive events. TCP retransmissions count toward sends; connection, failure, and copy events do not count toward bytes. Cumulative values come from the system events' `size`, without additional protocol-header estimates, and may differ from Linux IP-layer counts and network-interface counters.

ETW uses the PID from the event payload. Executable paths group records by application, and process start times distinguish instances. The cache is updated when a process exits or a PID is reused, and counts from old instances are marked inactive. Local unicast addresses, interface LUIDs, and aliases from IP Helper associate traffic with interfaces. If duplicate IPv6 addresses lack scope information, interface ownership is not guessed. ETW bytes whose process cannot be identified are assigned to the unidentified application. Unknown event versions, unreadable interfaces, lost events, and similar conditions produce a `partial` status.

TCP EStats retains the v1.1.1 difference-based approach, reading `DataBytesIn` and `DataBytesOut` for IPv4/IPv6 loopback connections once per second. New connections, counter rollback, process instance changes, and sampling interruptions establish a new baseline. Bytes transferred before first discovery are not recovered. ETW explicitly excludes loopback events to avoid counting the same loopback traffic through both sources. If ETW cannot start but EStats is available, loopback data remains available with a `partial` status and the ETW error reason.

Exited process handles are closed after preserving their creation and exit identity. Final ETW counters remain available until a successful application transaction acknowledges their exact values. Confirmed instances are then retired; late events use independent cumulative counters grouped by application and interface. Recent exited identities are bounded, and events whose identity can no longer be established become unidentified application traffic with a `partial` status. Older helpers continue their existing behavior without acknowledgement. Failed application writes retain the original batch for retry before pause, capture stop or shutdown can clear its baseline.

Only application counts attributable to an associated Wi-Fi interface are written to network history. Intervals that cannot be attributed at a Wi-Fi switch are discarded and recorded as missing. Loopback rows use `networkId: ""`, `scope: "loopback"`, and `source: "WindowsTcpEStats"` for live local TCP display. They are not written to Wi-Fi application totals and do not affect network-interface statistics or quota ledgers.

## Proxy clients and the live protocol

`live.appProcesses` and `snapshot.appProcesses` include measured cumulative bytes and B/s rates for loopback connection endpoints. When a new baseline cannot produce a difference, `measurementAvailable=false` and the rates are `null`. Clients may aggregate these rows by application but must not add loopback totals to physical-interface totals.

`live.proxy` and `snapshot.proxy` use the same structure. `proxy.clients` matches EStats bytes by client `appId` and the complete four-tuple, without requiring the proxy process's executable path to be readable. It uses only client-direction loopback connections, excluding reverse server-side connections and the proxy's physical-interface bytes. Measured fields include `estimated=false`, `measurementAvailable`, and `sampledConnections`; bytes and rates are `null` without evidence. Connection discovery uses a 5-second cache, EStats samples once per second, and live events update with service sampling.

Client cumulative values sum currently observed, measurable connections. They may decrease when connections disappear or counters are cleared and must not be treated as the day's total. Historical `proxyEstimatedRecords` continues to use connection-weight estimates with `estimated=true`, separately from live measured values. See the [backend contract](../backend/platform/win32/APP_TRAFFIC.md) for complete fields and lifecycle rules.

## Permissions and sampling limitations

Enabling ETW and EStats requires the corresponding administrator permissions; the sampling module itself does not trigger UAC. Without elevated permissions, the real helper returns `permission` / error 5. To avoid affecting concurrent consumers, it does not disable the system-level EStats switch for a connection on exit. The system releases those statistics after the connection closes.

EStats polling may miss short-lived connections opened and closed between samples, bytes transferred before first discovery, and the final bytes before closure. When a four-tuple is quickly reused without an observed disconnection and its counters do not roll back, the connections cannot be reliably distinguished. Loopback UDP/QUIC is outside the current sampling scope. ETW's unreadable-process, event-loss, and interface-attribution limitations still apply, and application totals are not guaranteed to equal network-interface totals.

## Building and validation

Native Windows builds produce `wifimeter-app-capture.exe`, which is distributed with the backend in the installer. In an already authorized Windows administrator terminal, run the current EStats test on a real system:

```powershell
.\build\windows\tests\windows_estats_smoke_test.exe
```

The test creates isolated IPv4/IPv6 local TCP connections and verifies client `tx=65536`, `rx=32768` bytes and process identity without accessing the user database. Without elevated permissions it returns 77 and is marked skipped by `ctest`; a skip does not mean real measurements passed. Ordinary pipe, parsing, backend, and UI tests use fixtures and do not require elevation.

`backend/tests/windows_app_capture_smoke.py` now validates the production hybrid contract and continues to run as required native validation:

```powershell
python backend/tests/windows_app_capture_smoke.py build/windows/app/wifimeter-app-capture.exe --require-native
```

The ETW group enumerates locally configured, bindable non-loopback addresses and uses local TCP/UDP connections to verify IPv4/IPv6 bytes, attribution to two processes, repeated snapshots, and retained inactive counts after process exit. Each row must have `source=WindowsEtw`; EStats rows cannot satisfy ETW assertions. A missing address family is reported separately. The test fails if both address families lack non-loopback addresses. At least one address family must complete TCP and UDP validation; the entire group cannot be skipped. Address enumeration does not query DNS or send requests to external hosts.

The loopback group creates long-lived IPv4/IPv6 TCP connections and transmits only after both endpoints have an EStats zero baseline. Each endpoint must report exactly `rx=65536`, `tx=65536`, with `source=WindowsTcpEStats` and no duplicate ETW row. Connections remain open until all readings are complete. After closure, sampling rows may disappear; ETW-style final rows are not required. The test uses the production helper without a test switch that bypasses loopback filtering.

Run `python backend/tests/windows_app_capture_smoke_test.py` without administrator permissions to verify warm-up waiting, connection lifetime, and explicit failure when no non-loopback addresses exist. The helper and address-query subprocesses use `CREATE_NO_WINDOW`. `--require-native` fails on a non-native system or without administrator permissions; skipped tests do not count as successful validation.

Native validation must record the non-loopback ETW and loopback EStats results separately and use CI and target-machine records for the corresponding commit. UI fixture tests, standalone EStats sampling, and records of real capture from older versions cannot replace full hybrid validation. Personal network sampling logs and historical local diagnostics remain in ignored local directories and are not committed; move them to `del/` when organizing files.

System API references:
[TCP/IP](https://learn.microsoft.com/en-us/windows/win32/etw/tcpip),
[UDP/IP](https://learn.microsoft.com/en-us/windows/win32/etw/udpip),
[SystemTraceProvider sessions](https://learn.microsoft.com/en-us/windows/win32/etw/configuring-and-starting-a-systemtraceprovider-session),
and [GetPerTcpConnectionEStats](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getpertcpconnectionestats).
