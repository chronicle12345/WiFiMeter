# Agent Note: Repository documentation and development workflow

Status: implemented

English | [简体中文](2026-10-18-repository-workflow.zh-CN.md)

## Problem

Shared instructions were absent and their Claude companion had no target. Ignore rules hid all agent guidance. Bilingual guides had no recorded consistency check, workflow facts repeated across guides, and backend tests used the wrong platform directory.

## Decision

Daily development uses dev; validated work integrates into stable main. Rules, current documentation and decision rationale have separate maintained homes. Shared instructions and Notes are versioned; personal state stays local. Required CI metadata checks run repository-local Node tools for bilingual pairs, document budgets, instruction companions and Note lifecycle.

Existing .zh-CN.md names remain. Both languages have equal authority. A normalized whole-file SHA-256 JSON record confirms reviewed contents; structure and hash checks cannot establish accurate translation. Archive operations preserve complete triplets with append-only seals compared against a trusted Git baseline.

AGENTS.md is each scope's maintained source. This initial Windows checkout commits marked ordinary CLAUDE.md copies for portability. Synchronization preserves existing copies and recognizes valid links; it rejects regular-file bodies combined with Git's symbolic-link index mode.

## Alternatives considered

- Written conventions alone minimize maintenance, but cannot detect missing counterparts, stale confirmations or broken links.
- DSH's section-keyed YAML records and generator system reduce unrelated-section merge conflicts, but this guide corpus has no generated reference system requiring that machinery.
- Reading checks from CC Switch reuses installed tools, but clean clones and CI cannot rely on a developer's absolute path or skill version.

## Consequences

Checks expose incomplete pairs, excess prose and frozen-history changes before integration. Whole-file records can conflict when branches edit different parts of one guide. Semantic review remains necessary because a poor translation can be re-recorded. CI needs readable history for archive comparison. Windows hosts without symbolic-link permission can maintain checked generated copies.

## Verification

Maintenance regression tests exercise stale translations, structural differences, word limits, path boundaries, index modes and archive tampering. The platform-aware backend entry enables test targets and fails when CTest finds no tests. Release-helper regressions and actionlint verify the existing publication path. Privileged native checks and unsupported host capabilities are reported separately from passing results.

## Related

- [Development workflow](../../../../docs/DEVELOPMENT.md)
- [DSH bilingual specification](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/i18n/README.md)
- [Linux.do workflow analysis](https://linux.do/t/topic/2904342)
