# Runbook: conformance-fail

## When this fires

CI logs that match any of these patterns (case-insensitive) trigger this runbook:

- `conformance.*(fail|FAIL)`
- `storage conformance suite`
- `adapter.*(mismatch|violat)`

## Steps

1. Stop the release; do not promote past the test cell.
2. Keep the production cells on the current tag.
3. If a fork bump caused it, revert the pin to the prior fork tag in a PR.
4. Open an issue with the failing conformance cases and the fork tags involved.

## Notes

_Seeded from ship plan `recovery-playbooks[conformance-fail]`. Update this file as the playbook evolves._
_Last synced from plan version: 1_
