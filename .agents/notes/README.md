# Agent Notes

English | [简体中文](README.zh-CN.md)

Agent Notes preserve a lasting decision's reasons, genuine alternatives, costs and required evidence. The [development workflow](../../docs/DEVELOPMENT.md) owns branches and review; current product and protocol facts belong in their maintained guides.

## Scope and discovery

Search active Notes by mechanism or module before creating one. Update the owning record when its decision still applies. Write a new Note only when code, tests and existing documentation cannot explain a lasting choice. Mechanical edits, styling and local changes without a durable decision need no Note. Do not reconstruct unknown historical reasons or invent alternatives.

Use lifecycle/class folders and repository search. Do not maintain a global INDEX.md. Archived records are historical evidence, excluded from current guidance.

## Paths and lifecycle

Use `.agents/notes/<lifecycle>/<class>/yyyy-mm-dd-topic.md`. The date is the first proposal date and remains unchanged when the record moves. Create folders only when needed. Every active Note includes its `.zh-CN.md` counterpart and `.i18n.json` record under the [bilingual contract](../../docs/i18n/README.md).

| Lifecycle | Meaning |
| --- | --- |
| `proposed` | A future decision with acceptance conditions and known risks |
| `implemented` | A shipped decision, with facts kept current alongside code |
| `rejected` | A declined proposal retained while its reason prevents a plausible mistake |
| `archived` | A completed implemented decision with historical value and no continuing guidance role |

| Class | Subject |
| --- | --- |
| `feature` | Product capabilities and behavior |
| `bug-fix` | A lasting defect correction strategy |
| `simplification` | Removal or consolidation and its trade-offs |
| `architecture` | Shipped module, data and protocol boundaries |
| `process` | Development, tooling and release rules |
| `testing` | Verification strategy and coverage |

## Format and maintenance

Both language files keep this machine-readable opening:

```markdown
# Agent Note: <title>

Status: implemented
```

Use `proposed` for a proposal or `rejected — <reason>` for a rejection. Add the language switcher after a blank line. English and Chinese headings follow the same section order.

| Lifecycle | Required sections |
| --- | --- |
| Proposed or rejected | Problem, Proposal, Alternatives considered, Acceptance criteria, Risks |
| Implemented | Problem, Decision, Alternatives considered, Consequences |

Chinese section names are 问题、方案、备选方案、验收标准、风险、决定、影响. Describe an implemented decision as current fact; record actual evidence in a Verification section. Replace proposal headings and plans when implementation finishes. Keep paths, defaults and names accurate in the same change as code. A changed decision or rationale gets a new cross-linked Note.

## Verification and archival

Run `npm run check:notes` for lifecycle and seal checks, and `npm run check:docs` for the complete documentation checks. Review both languages before `npm run docs:pair -- <path> --reviewed`. The [budget list](../../tools/docs/budgets.json) limits each Note; `npm run docs:budget` reports usage.

Archive only an implemented record that no longer guides active work. Run `npm run notes:archive -- <implemented-note-path>`. The command moves all three files, keeps the implemented status, adds matching archive dates, records normalized LF SHA-256 seals and refuses existing targets. Update incoming links in active documents in the same change.

The archive manifest is append-only against the Git baseline: local checks use HEAD, and CI supplies the PR base or pre-push commit through DOCS_BASE_REF. An explicit unreadable baseline fails. Frozen triplets cannot be edited, deleted or re-recorded; line-ending normalization supports Windows checkouts. A seal establishes unchanged recorded contents, not semantic correctness.
