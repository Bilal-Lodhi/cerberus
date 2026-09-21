# Pull request

## Summary

<!-- What does this change do? Keep it to a few sentences. -->

## Motivation

<!-- Why is this change needed? What problem does it solve? Link the issue if there is one. -->

## Type of change

<!-- Tick exactly the ones that apply. -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds capability)
- [ ] Breaking change (fix or feature that changes existing behaviour or interfaces)
- [ ] Documentation
- [ ] Refactor (no behaviour change)
- [ ] Tests
- [ ] CI

## Scope boundaries

<!--
State what this PR deliberately does NOT do. This is the section reviewers use
to confirm the change stayed inside the agreed slice. Examples:
  - Does not change the MCP tool names or the persisted schema.
  - Does not add authentication roles; the baseline stays single-key.
  - Does not touch the Flutter console.
-->

## How this was tested

<!-- Give the exact commands you ran and their outcome. Do not write "tested locally". -->

```
# e.g.
npm run typecheck
npm test
npm run build
```

<!-- For console changes, also: -->
<!-- cd apps/console && flutter analyze -->

## Checklist

- [ ] Tests added or updated for any behaviour change.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `flutter analyze` passes, if `apps/console` changed.
- [ ] No secrets, credentials, tokens, `.env` files, or key material committed.
- [ ] Documentation updated for any behaviour, configuration, or interface change.
- [ ] `CHANGELOG.md` updated under `[Unreleased]` for user-visible changes.

## Related issues

<!-- e.g. Closes #12, Relates to #7 -->
