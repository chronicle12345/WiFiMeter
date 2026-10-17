# Desktop scope

- Follow the renderer, Tauri/Rust, and Node business-host boundaries in [Architecture](../../docs/ARCHITECTURE.md#responsibility-boundaries).
- Preserve the Windows application identity and compatible user-data path. Keep permission requests confined to the relevant native helper.
- Follow [Contracts](../../contracts/README.md) for byte values, snapshots, event replay, unavailable measurements, and estimates. Keep measured interface totals separate from application attribution.
- Select desktop, browser, Rust, and packaged-WebView checks using [Testing](../../docs/TESTING.md). Use isolated profiles and synthetic fixtures.
