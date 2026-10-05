## Summary

<!-- What changes, and why. -->

## Linked issue

<!-- Closes #… (or "none") -->

## Testing

<!-- What you ran, and what you observed. -->

## Checklist

- [ ] The PR title is a conventional commit (for example `feat(server): add the job board`).
- [ ] `mise run check` passes (Biome, tsc).
- [ ] `mise run test` passes with 80% line coverage or more.
- [ ] `mise run check:app` passes, if the app changed (ktlint, detekt).
- [ ] No secret, hostname, IP address, or household detail is in the diff.
- [ ] If the PR touches a safety path (rules, tool hook, reviewer, secrets cell, budgets) or a gate (`.github/`, `lefthook.yml`, `renovate.json`, the ship plan), the owner reviews it.
