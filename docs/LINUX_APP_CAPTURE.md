# Linux Application Capture

English | [简体中文](LINUX_APP_CAPTURE.zh-CN.md)

The backend application-capture switch is disabled by default and applies only to the current backend session. The application page provides manual start, stop and retry controls. System authorization is used only for `wifimeter-app-capture`; the Tauri desktop application and ordinary capture backend do not run as root. Stopping, pausing, or exiting closes the helper's pipe and unloads its own BPF links. Capture does not modify Wi-Fi settings, routes, or packet contents.

Version 1.3.5 asks whether to enable application capture after startup and migration succeed and the main window appears. Accepting then requests the helper's system authorization; declining either request leaves application capture off for that session, with no automatic retry. Network-interface statistics continue. Settings > General > Ask about application capture at startup is enabled by default and can suppress future startup questions. Manual capture controls do not change this preference. When the backend reports application capture as unavailable, the host skips the question. Failed migrations also skip it.

## Measurement semantics

- cgroup v2 ingress/egress hooks accumulate IPv4/IPv6 socket bytes, including IP and transport-layer headers, for TCP and UDP.
- Process identity is recorded when a socket is created and retained throughout its lifetime in kernel socket storage. Accepted sockets inherit the listening socket's identity. When a socket is shared through `fork` or file-descriptor passing, traffic remains attributed to its creator rather than the process receiving the descriptor.
- The executable path provides a readable application identifier. Process start time and executable inode are checked together to detect PID reuse and `exec`.
- Cumulative counters in the same `generation` are not cleared on reads. Exited processes retain their final counts, and history is grouped by application.
- Measured bytes with unreadable identities are assigned to the unidentified application. Insufficient counter capacity, unreadable interfaces, or unknown identity produces a `partial` status. Sockets that existed before capture was enabled may not be identified. Their traffic is not fabricated by subtracting identified application counts from network-interface totals.
- Only counts passing through an associated Wi-Fi interface are written to that network. Boundary intervals affected by a Wi-Fi switch or unknown identity are discarded and recorded as missing.
- VPN/proxy physical-interface traffic may be attributed to the tunnel or proxy process. Application totals and network-interface totals are displayed separately and are not required to be equal.
- Source stops, permission failures, and recovery establish new baselines. Application statistics do not affect network-interface records or quota ledgers.

## Build and runtime requirements

Capture requires a Linux kernel with BTF and cgroup v2, plus system authorization to load BPF. Build dependencies are BPF-capable clang, `libbpf-dev >= 1.0`, and `libelf-dev`; runtime authorization requires `pkexec`. When dependencies are found, the build produces the helper and `wifimeter-app-capture.bpf.o`. Explicitly setting `-DWIFIMETER_LINUX_APP_CAPTURE=ON` causes the build to fail if dependencies are missing.

The `.deb` package distributes the helper and BPF object. libbpf is statically linked with its BSD license notice, so runtime capture does not depend on an older system libbpf. The helper still uses the system `libelf1`. `dist:linux` requires a successful native capture build and does not produce an installer without the collector.

## Real-kernel validation

Build first, then run:

```bash
npm run test:backend
sudo python3 backend/tests/linux_app_capture_smoke.py build/app/wifimeter-app-capture
```

The script sends test data only over local loopback and verifies TCP/UDP, IPv4/IPv6, send/receive attribution to two processes, application grouping, repeated snapshots, and final counts after process exit. Tests that require system authorization are explicitly marked skipped in ordinary-user `ctest`; this does not establish that real capture passed. The Linux CI jobs are currently paused; their retained configuration runs this script separately as root when restored. The desktop application, ordinary backend, and remaining tests retain ordinary permissions. See the [CI matrix](PACKAGING-MATRIX.md) for status and [Testing](TESTING.md) for verification boundaries.
