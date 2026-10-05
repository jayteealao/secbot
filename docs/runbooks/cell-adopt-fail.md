# Runbook: cell-adopt-fail

## When this fires

CI logs that match any of these patterns (case-insensitive) trigger this runbook:

- `adopt.*(fail|timeout)`
- `cell .* still on v`
- `version mismatch.*cell`

## Steps

1. Halt the staged rollout at the current stage.
2. Redeploy the prior tag to the failing cell with the rollback command and `--cells <cell>`.
3. Run the Block D checks against the failing cell.
4. If the deploy refuses the downgrade at a contract step, or the cell data is corrupt, follow [cell-restore](cell-restore.md). Do not restore in any other case.

## Notes

_Seeded from ship plan `recovery-playbooks[cell-adopt-fail]`. Update this file as the playbook evolves._
_Last synced from plan version: 2_
