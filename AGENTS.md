# WiFiMeter project instructions

WiFiMeter is a Tauri desktop application with a JavaScript renderer, Rust host, Node business process and C++ collection backend. Read [architecture](docs/ARCHITECTURE.md) before changing boundaries and [development](docs/DEVELOPMENT.md) for the working process.

## Development

- Start daily work on `dev`, synchronized with `origin/dev`. Keep `main` stable; integrate validated work from `dev` before release. Base any task branches on `dev` and integrate them there first.
- Inspect the working tree before editing. Preserve unrelated work and commits. Delete temporary branches only after their commits are integrated and no worktree uses them.
- Complete authorized, reversible work without repeated permission requests. Ask when an unresolved decision changes scope or an action would discard work.
- Use Conventional Commits. Group one logical change with its tests, documentation and decision records; inspect the staged diff before committing.

## Ownership and compatibility

- Follow the nearest subtree instructions in `apps/desktop/`, `backend/`, `packaging/`, `docs/` and `.agents/notes/`.
- Keep renderer calculations and display separate from native capabilities, Node business operations and C++ collection/storage. Use the existing IPC boundaries.
- Preserve data-directory identities, byte-counter precision, backup compatibility and application/network accounting. [Contracts](contracts/README.md) own the protocol; [migration](docs/MIGRATION.md) owns recovery rules.
- Keep product copy in the existing English/Chinese localization mechanism. Do not expose implementation details in product flows without a user need.

## Verification

- Select checks from [testing](docs/TESTING.md) according to the changed behavior. `npm test` does not include CTest, Rust or package verification.
- Run focused checks locally and report commands actually run. Broaden or repeat passing checks only for new changes, failures or a remaining concern; CI owns the complete enabled platform matrix.
- Tests use isolated profiles and synthetic data. Background processes and native checks must not open visible windows, dialogs or system notifications.
- Run `npm run check:docs` for instructions, documentation or Notes changes. New maintenance behavior needs meaningful negative-case tests under `tools/docs/`.

## Documentation and decisions

- [Documentation rules](docs/AGENTS.md) assign each fact one maintained home. Describe current behavior; link its rationale instead of duplicating it.
- Maintain English and Simplified Chinese as equally authoritative pairs under the [bilingual contract](docs/i18n/README.md). Review meaning before recording hashes; a green check does not certify translation quality.
- Read relevant active [Agent Notes](.agents/notes/README.md) before changing a lasting decision. Record rationale that code, tests and current documentation cannot explain; mechanical and local changes are exempt.
- Update facts in the owning implemented Note with the code. A changed decision gets a new linked Note. Archived triplets are frozen history and never current authority.
- The optional `write-notes-like-deepseek` skill supplies writing guidance. This repository's paths, bilingual format, commands and user instructions take precedence over its defaults.

## Repository files

- Version shared `AGENTS.md` files, their `CLAUDE.md` companions, public documentation, decision Notes and maintenance tools. Keep credentials, personal agent/editor state, databases, traces and build output local.
- `CLAUDE.md` shares its directory's `AGENTS.md`. Run `npm run docs:instructions` after checkout or instruction edits; the command preserves a real symlink or produces a marked copy when symlinks are unavailable.
- Installation resources remain controlled by packaging allowlists. Repository guidance and development tools are not application runtime resources.
