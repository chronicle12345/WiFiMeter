# Development workflow

English | [简体中文](DEVELOPMENT.zh-CN.md)

This guide owns the development, review, and project-record workflow. Use the [testing guide](TESTING.md) for verification, the [architecture](ARCHITECTURE.md) for module boundaries, and the [CI and release matrix](PACKAGING-MATRIX.md) for publication.

## Branches, commits, and pull requests

Start daily work on `dev` and synchronize it with `origin/dev` before editing. Keep `main` stable. An isolated task branch starts from the current `dev` and returns to `dev` through a pull request. Validate the resulting `dev` before merging it into `main`; release tags follow the release checklist. Do not overwrite another contributor's commits or discard unrelated local changes when synchronizing.

Keep commits focused and use Conventional Commits, such as `fix(backend): preserve the application baseline on retry`. Describe the changed behavior and its reason. Split unrelated work when it can be reviewed and validated independently. A pull request identifies the problem, resulting behavior, relevant documentation and Notes, verification actually performed, and remaining limits. A change to a development process includes the corresponding rules and command documentation.

Delete a temporary branch after its changes are merged and it has no unique commits. Check local and remote branches separately; retain branches with unfinished work. Remove a remote branch only after checking its current head and protect the deletion against a concurrent update.

## Work and verification

Read the applicable `AGENTS.md`, the relevant maintained guide, and any implemented Notes before changing behavior. Follow module boundaries and preserve existing protocol, storage, migration, and permission guarantees. Reproduce a defect before choosing a fix. Update documentation with the implementation when commands, behavior, limits, or responsibilities change.

Choose checks by the changed behavior using [verification by scope](TESTING.md#verification-by-scope). Report the exact checks run and any skipped or unavailable coverage. Ordinary documentation edits do not require a complete installer build. Changes to a checking tool need its own regression tests as well as a check of the real repository. Passing browser fixtures does not establish native collection or packaged WebView results.

## Where information belongs

| Information | Maintained location |
| --- | --- |
| Product introduction, installation entry, documentation index | Root README pair |
| Module responsibilities and runtime data flow | [Architecture](ARCHITECTURE.md) |
| Protocol, fields, accounting, compatibility | [Data contracts](../contracts/README.md) and platform contracts |
| Development and review process | This guide |
| Verification entry points and limits | [Testing](TESTING.md) |
| Build prerequisites and source-package commands | [Packaging](../packaging/README.md) |
| Active CI targets, required checks, release procedure | [CI and release matrix](PACKAGING-MATRIX.md) |
| Translation maintenance and vocabulary | [Bilingual documentation](i18n/README.md) and [terminology](i18n/terminology.md) |
| Long-lived decision context and alternatives | [Agent Notes](../.agents/notes/README.md) |
| Version-specific public changes | `CHANGELOG.md` and `docs/releases/` |

Keep current facts in their maintained guide and link to it elsewhere. Notes explain decisions; they do not replace product or protocol documentation. Release notes describe their historical version and are not rewritten to match the current development environment.

## Agent Notes

Before making a lasting decision, check existing active and rejected Notes for context. Write a Note only when future contributors need its reasoning, constraints, or alternatives. Mechanical renaming, formatting, and local changes without a lasting decision need no Note.

Keep current facts synchronized across code, the owning guide, and any affected implemented Note in the same change. An important decision reversal gets a new Note linking the earlier decision; factual updates that preserve the reasoning update the implemented Note in place. The [Notes conventions](../.agents/notes/README.md) own categories, metadata, lifecycle, templates, and archival commands. Use that guide instead of duplicating those definitions here.

## Shared rules and private state

Shared `AGENTS.md` files and `.agents/notes/` belong in Git. Keep local overrides, personal agent or editor configuration, credentials, databases, diagnostics, and generated builds ignored. Existing personal skills remain personal; repository checks use tools committed with this project. A shared rule must not depend on an uncommitted personal skill.

`AGENTS.md` is the sole maintained instruction source in each scope. After edits, run `npm run docs:instructions` to synchronize the adjacent `CLAUDE.md`; review checks reject a divergent mirror. Link, generated-copy, and checkout-stub handling are defined in [bilingual documentation](i18n/README.md#instruction-mirrors-and-archived-records).

Use synthetic fixtures and isolated profiles for tests. Keep local screenshots, logs, and temporary records in ignored `del/` or the tool's isolated output directory. Move files when archiving local diagnostics. Preserve user data and keep private network details out of committed examples and Notes.
