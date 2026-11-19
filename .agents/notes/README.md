# Agent Notes

English | [简体中文](README.zh-CN.md)

Agent Notes preserve durable reasons, rejected options and trade-offs. Current facts belong in maintained guides; [Development](../../docs/DEVELOPMENT.md) owns the workflow.

## When to write and update

Search active folders by mechanism or module; use relative Markdown cross-links, without a global INDEX.md.

Add or update a Note in the same change when code, tests and existing documentation leave lasting reasoning unexplained. Use proposed before delivery and implemented afterward. Mechanical or local changes without lasting decisions need none.

Update unchanged decisions' paths, names, defaults and structure alongside code. A different decision needs a new linked record.

## Paths and classes

Use `.agents/notes/<lifecycle>/<class>/yyyy-mm-dd-topic.md`. Keep the first proposal date, verified from Git history, when moving. Create folders as needed.

Notes have English `.md`, Chinese `.zh-CN.md` and generated `.i18n.json` files. Lifecycles are `proposed`, `implemented`, `rejected` and `archived`.

| Class | Scope |
| --- | --- |
| `feature` | New capabilities |
| `bug-fix` | Defects or postmortem gaps |
| `simplification` | Removal or consolidation without added capability |
| `architecture` | Shipped source, module and runtime boundaries |
| `process` | Tooling, policies and development/release workflows |
| `testing` | Test infrastructure and strategy |

Architecture concerns shipped code; process concerns surrounding tools/workflows. Extend classes in both checker and guide.

## File format

The first three lines are strict, followed by a blank line and language switcher:

```markdown
# Agent Note: <title>

Status: proposed
```

One Status line matches the folder: `proposed`, `implemented`, or `rejected — <one-line reason>`. Status omits dates; qualifications belong in the body.

Proposed skeleton:

```markdown
## Problem
## Proposal
## Alternatives considered
## Acceptance criteria
## Risks
```

Problem explains the need independently of a solution. Proposal describes planned changes, migration and open questions. Acceptance criteria define observable completion; Risks covers failures and deliberately forgone capabilities.

Implemented skeleton:

```markdown
## Problem
## Decision
## Alternatives considered
## Consequences
```

Decision describes delivered behavior in present tense; Consequences records benefits and costs. Technical sections and Verification describe evidence, limits and coverage gaps. Proposal, Plan, Migration plan and Acceptance criteria headings are forbidden here.

Rejected Notes preserve the original proposal body and sections; only Problem, Proposal and Alternatives considered are mandatory. Record rejection in Status and retain existing plans, acceptance criteria and risks.

Record real alternatives and rejection reasons, using a bold-led paragraph or a `### Why not <X>?` subsection per option. Never invent missing history.

Both languages match in structure and meaning. Machine headers stay English; Chinese section names are 问题、方案、备选方案、验收标准、风险、决定、影响、验证.

## Moving and replacing

Move all three files together, preserve their date, update Status and incoming links, and satisfy the destination format.

For proposed → implemented, rewrite Proposal as present-tense Decision. Replace plans with delivered facts; fold acceptance criteria and risks into Consequences or factual Testing/Verification, recording actual results and gaps.

For proposed → rejected, add the rejection reason to Status and preserve the proposal.

Partial replacement keeps both records, reciprocal links and current surviving facts. Complete absorption permits deleting the old triplet only after the current owner preserves every unique rationale, alternative, consequence, required verification and coverage gap. Repair incoming links together; Git history cannot be the sole rationale. Never rewrite an old record into its opposite.

## Removing capabilities

An introducing Note can merge into a removal Note only after the capability disappears from production code, configuration, schemas, persistence/protocol formats, migration and compatibility behavior, current availability guides and tests asserting supported behavior.

Removing one transport, default, implementation or view is partial replacement. Remaining stored data or compatibility handling also prevents complete removal.

The removal record preserves the original motivation, why it no longer justifies retention, alternatives to removal, forgone capabilities, reintroduction conditions and evidence of complete removal. Removal-verification tests may remain; obsolete implementation lists and tests of deleted behavior are not current evidence.

## Archiving or deleting

Delete purely mechanical or small UI triplets; repair or remove incoming links. Small bug fixes, performance changes, new capabilities and substantive behavior decisions do not qualify merely by size.

Archive implemented Notes only when delivery is complete, future guidance value is low and historical value remains. Keep active records whose alternatives, ownership, guarantees, persistence/protocol semantics, security or reintroduction conditions still matter. Do not use age, length or quotas as criteria.

Obsolete proposals become rejected; retain rejections only while they prevent a plausible consequential mistake, otherwise delete the triplet and repair links.

Archive with `npm run notes:archive -- <implemented-note-path>`. It moves the reviewed triplet to `archived/<class>/`, retains implemented status and adds the same `Archived: YYYY-MM-DD` on line 4 in both languages. The date cannot precede the proposal. Only archive metadata and the pair record change; repair incoming links.

Archived triplets are frozen: no editing, translation, formatting, moving, deletion or rerecording. Cite them only as history. [notes.cjs](../../tools/docs/notes.cjs) validates archived content.

## Review and commands

Review both languages under the [bilingual contract](../../docs/i18n/README.md), then run `npm run docs:pair -- <path> --reviewed`. Use `npm run check:notes`, `npm run docs:budget` and `npm run check:docs` for validation; [budgets.json](../../tools/docs/budgets.json) owns limits.
