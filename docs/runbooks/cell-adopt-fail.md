# Runbook: cell-adopt-fail

## When this fires

CI logs that match any of these patterns (case-insensitive) trigger this runbook:

- `adopt.*(fail|timeout)`
- `cell .* still on v`
- `version mismatch.*cell`
- `cell .* up .* (expected `
- `cell .* down:`

## Steps

1. Halt the staged rollout at the current stage.
2. Redeploy the prior tag to the failing cell with the rollback command and `--cells <cell>`.
   A cell is redeployed with its fleet: `owner` alone, or `person` and `household` together.
3. Run the cell, alarm, and heartbeat checks (`check:cells`, `check:alarms`, `check:heartbeats`) against the failing cell.
4. If the deploy refuses the downgrade at a contract step, or the cell data is corrupt, follow [cell-restore](cell-restore.md). Do not restore in any other case.

## Notes

`mise run check:cells` prints `cell <name> up <version> (expected <tag>)` for a cell still on the
old version, and `cell <name> down: <reason>` for a cell that does not answer.

_Seeded from ship plan `recovery-playbooks[cell-adopt-fail]`. Update this file as the playbook evolves._
_Last synced from plan version: 2_
