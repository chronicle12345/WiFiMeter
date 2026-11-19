# Agent Note: Cloud backup recovery boundaries

Status: implemented

English | [简体中文](2026-11-19-cloud-backup-recovery.zh-CN.md)

## Problem

Selected backups combine authoritative traffic data with desktop preferences and logs. A backend-only restore point cannot undo every replaced part. Sampling or delayed desktop writes after the point is captured can also overwrite data that the user did not select for replacement.

## Decision

Keep the existing complete backend document and use explicit section selection and merging in the Node host. Preserve minute proxy byte evidence with its application/minute data. Restore portable preferences and logs through their owning modules, with validation before replacement. Saved restriction records are portable data; restoring them does not execute system policy commands. Credentials are stored locally and excluded from archives; WebDAV authentication sends them to the configured server.

Block new desktop mutations, drain admitted work and pause collection before taking a complete local restore point. Successful restoration remains paused. Recover the prior state on safe failure; preserve the point and remain paused if recovery is incomplete. The ordinary compressed-file restore path can read the same point. Current fields and recovery rules belong to [application contracts](../../../../contracts/APPLICATION_TRAFFIC.md#minute-proxy-backup-evidence) and [Migration](../../../../docs/MIGRATION.md#webdav-cloud-backups).

## Alternatives considered

**Copy the profile directory.** SQLite state, device-specific credentials and runtime files have different recovery rules. Explicit documents and owning modules retain transaction validation and avoid copying unrelated local state.

**Restore backend data alone.** This leaves replaced desktop preferences or logs without an undo source. A combined restore point keeps recovery usable through one existing file action.

**Replay saved network restrictions.** Permissions, program paths and policies differ between devices. Import saved records for inspection; system policy changes remain explicit application-control actions.

## Consequences

The existing full snapshot is reused for selection and recovery, so its memory and serialization cost remains. Collection is paused during recovery and its gap is represented by the existing accounting rules. Unknown write failures require compensating recovery across the backend and host files; an incomplete recovery is reported rather than treated as success. Old archives remain readable, but absent historical byte evidence cannot be reconstructed.
