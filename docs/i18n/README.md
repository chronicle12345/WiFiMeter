# Bilingual documentation

English | [简体中文](README.zh-CN.md)

English and Simplified Chinese have equal authority. Either language may be written first. Keep meaning, commands, constraints, and evidence consistent using the [terminology table](terminology.md).

## Files and scope

Maintain `<name>.md`, `<name>.zh-CN.md`, and generated `<name>.i18n.json` together in one directory. Both Markdown files include language switches; do not hand-edit the review record.

Pairing and prose budgets cover non-vendor README/CONTRIBUTING files, active `docs/` and `.agents/notes/`, and maintained technical documents in `contracts/`, `backend/platform/`, and `packaging/`, including project-maintained dependency notices.

| Exception | Convention |
| --- | --- |
| `AGENTS.md` and adjacent `CLAUDE.md` | English instruction source and synchronized mirror |
| `CHANGELOG.md` and historical `docs/releases/` | English then Chinese in one file |
| [terminology.md](terminology.md) | One bilingual table |
| Archived Notes | Frozen reviewed three-file set |
| Vendor sources and original third-party licenses | Preserve upstream material |

Shared rules/Notes are versioned; personal configuration, credentials, sessions, and diagnostics remain ignored. See [Development](../DEVELOPMENT.md#shared-rules-and-private-state).

## Editing and review

Edit either language, then make the smallest corresponding edit in the other. Preserve identifiers, paths, commands, options, quantities, platform limits, and runtime contracts. Use natural wording rather than literal translation.

Review both versions for behavior, conditions, exceptions, evidence, terminology, links, tables, lists, and examples. Do not refresh a record merely to silence a check. After semantic review:

```sh
npm run docs:pair -- docs/DEVELOPMENT.md --reviewed
npm run check:docs
```

One or more Markdown paths may identify either language. `--reviewed` confirms semantic review. Commit both Markdown files with the generated record; later edits require review before renewal.

## What the checks establish

This repository deliberately uses whole-file JSON records with LF-normalized SHA-256, not interchangeable section-level YAML records. Hashes detect edits since review; they cannot prove translation quality, facts, or example correctness.

`check:docs` checks pair records, heading hierarchy, lists/tables, code blocks, links, active Notes, repository file policy, instruction mirrors, and prose budgets. Run `test:docs` after changing these tools.

Limits live in [budgets.json](../../tools/docs/budgets.json); `npm run docs:budget` reports usage. First place content with its owner, remove duplication, and shorten it. Explain any necessary exception before adjusting a limit. The checker enforces limits on actual visible prose.

Commands and tool paths are in [package.json](../../package.json). [Testing](../TESTING.md) separates these checks from runtime verification.

## Instruction mirrors and archived records

Edit `AGENTS.md`, then run `npm run docs:instructions`. New `CLAUDE.md` mirrors prefer real symlinks; unavailable support produces a marked copy whose body matches the source. Existing generated copies stay copies on Linux. `check:docs` rejects missing/divergent mirrors. This Windows setup versions marked ordinary copies.

If `core.symlinks=false` checks out a tracked symlink as a stub, synchronization refuses to write prose into that link entry. Restore a real link or deliberately convert its index entry. Instruction files remain English without pair records.

Active Notes follow the same review process. After their current facts enter maintained guides, archive with `npm run notes:archive -- <implemented-note-path>`. Keep implemented status, archive date, and reviewed three-file set together. Archives retain historical content, exempt from active synchronization. See the [Notes conventions](../../.agents/notes/README.md).
