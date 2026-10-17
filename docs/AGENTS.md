# Documentation scope

- Keep maintained guides in the responsibility boundaries defined by [Development](DEVELOPMENT.md#where-information-belongs); link to the owner instead of repeating changing details.
- Follow [Bilingual documentation](i18n/README.md) for pairs and review records. Preserve historical release facts and the original license material.
- Keep protocol and accounting statements aligned with [Contracts](../contracts/README.md). Update commands, platform limits, and evidence claims together.
- Use [Testing](TESTING.md#verification-by-scope) for documentation checks. Keep application test claims specific to the checks actually run.
- Keep documents within the visible-prose limits in [budgets.json](../tools/docs/budgets.json). Place content with its owner, remove duplication, then shorten it; change a limit only when necessary content needs a documented reason. Run `npm run docs:budget` and `npm run check:docs`.
