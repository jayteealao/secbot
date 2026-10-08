# Runbook: cell-restore

## When this fires

CI logs that match any of these patterns (case-insensitive) trigger this runbook:

- `downgrade.*contract step`
- `refus.*contract`
- `(database|sqlite).*(corrupt|malformed)`
- `integrity_check.*(fail|not ok)`
- `restore .* failed`
- `snapshot .* not found`
- `snapshot digest mismatch`

A restore is a disaster step, not a rollback step. A normal rollback is a redeploy of the prior tag and restores no data. See [cell-adopt-fail](cell-adopt-fail.md).

## Steps

1. Take the VPS deploy lock, so no deploy or rollback runs during the restore.
2. Read the snapshot id `pre-<tag>-<run-id>` from the deploy ledger.
3. State the data-loss window: the snapshot time to now.
4. Ask the owner for a yes for each cell, with the window. Restore only the cells that get a yes.
5. Do not restore the secrets cell. If the secrets cell is damaged, rebuild it and rotate its credentials.
6. Run the restore command for the approved cells: `mise run restore -- --env production --cells <cell> --snapshot <id>`.
   It prints `restore <cell> ok digest <digest> rows <n>` when the loaded rows match the snapshot's
   digest. It refuses `snapshot <id> not found for cell <cell>`, `refusing a snapshot past contract step
   <n> (snapshot <id> has step <m>)`, and `snapshot digest mismatch`; a refused restore changes nothing.
7. Confirm that each restored cell reads the outbound-effects log and repeats no sent mail or calendar write.
   Until a tool has an outside effect, the restore prints `outbound-effects log: none in this release`.
8. Run the cell, alarm, and heartbeat checks against the restored cells (`check:cells`, `check:alarms`, `check:heartbeats`).

## Notes

The `restore.yml` workflow runs steps 1 to 8 for one cell per run. Its first job writes the data-loss window to the run summary before the production approval. Steps 1 and 7 run inside the `restore` task on the VPS.

The monthly restore drill (`restore-drill.yml`, or `mise run restore:drill`) proves this path on the test cell with a real snapshot; see [How to operate the cells](../how-to/operate-cells.md#run-the-restore-drill). Snapshots are whole-database dumps under `snapshots/<id>/<cell>.json` in each fleet's bucket.

_Seeded from ship plan `recovery-playbooks[cell-restore]`. Update this file as the playbook evolves._
_Last synced from plan version: 2_
