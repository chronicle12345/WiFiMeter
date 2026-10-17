<!-- Generated from AGENTS.md by npm run docs:instructions. -->

# Backend scope

- Follow [Architecture](../docs/ARCHITECTURE.md#c-backend) and [Contracts](../contracts/README.md) for collection, accounting, storage, events, and compatibility.
- Preserve decimal-string byte interfaces, checked signed-64-bit storage, independent quota ledgers, transaction boundaries, and migration guarantees.
- Keep platform APIs in their adapters. Keep application collection session-scoped and disabled by default; never synthesize missing native measurements from adapter totals.
- Use [Testing](../docs/TESTING.md) and the [Windows](../docs/WINDOWS_APP_CAPTURE.md) or [Linux](../docs/LINUX_APP_CAPTURE.md) capture guide. Report privileged skips separately from native success.
- Preserve vendored sources and license notices under [third_party](third_party/README.md); document deliberate dependency updates.
