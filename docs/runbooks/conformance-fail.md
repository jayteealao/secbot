# Runbook: conformance-fail

## When this fires

CI logs that match any of these patterns (case-insensitive) trigger this runbook:

- `conformance.*(fail|FAIL)`
- `storage conformance suite`
- `adapter.*(mismatch|violat)`

`mise run test:conformance` prints these lines:

| Line | Meaning |
|---|---|
| `storage conformance suite: <n> passed, <m> failed` | The summary of one in-cell run. |
| `conformance case fail: <case>: <message>` | One pi-durable conformance case failed inside the cell. |
| `adapter mismatch: <name> ran, expected CelldSqliteDatabase` | The suite did not run on the celld storage driver. |
| `conformance case fail: long transaction: ...` | With `--long-transaction`: no timeout was reported, or a write from the timed-out transaction is visible. |
| `long transaction: timedOut=<bool> durationMs=<n> markerRowsVisible=<n>` | With `--long-transaction`: the summary of the timed-out transaction. |
| `storage conformance suite: FAIL, no case ran` | The cell answered, but no conformance case ran. |
| `storage conformance suite: FAIL (<n> problem(s))` | The final line when any case failed or the driver did not match. |
| `storage conformance suite: FAIL: <reason>` | The run could not start or reach the cell (SSH, lock, deploy, celld). |
| `storage conformance suite: PASS` | Every case passed on `CelldSqliteDatabase`. |

The cell also logs `{"event":"cell_storage.transaction_timeout","duration_ms":…}` once per
transaction that passed celld's 30-second limit.

## Steps

1. Stop the release; do not promote past the test cell.
2. Keep the production cells on the current tag.
3. If a fork bump caused it, revert the pin to the prior fork tag in a PR.
4. Open an issue with the failing conformance cases and the fork tags involved.

## Rerun

- On the test cell (needs `SECBOT_VPS_SSH`, your SSH alias for the VPS, and the deploy-test key):
  `mise run test:conformance -- --target test-cell`
  Add `--long-transaction` to also check the 30-second timeout. Add `--version <tag>` to test a
  bundle that is already staged; without it, the command builds and stages a dev bundle.
- On Linux or macOS with celld installed: `PORT=3000 mise run test:conformance -- --target local`
  runs the same cases in `celld dev`.
- Anywhere: `mise run test` runs the same cases against the driver over a `node:sqlite` stand-in.
  That run is a quick check, not release evidence.

A run on the test cell waits for the VPS deploy lock, so it never overlaps a release, a
rollback, or a restore.

## Notes

_Seeded from ship plan `recovery-playbooks[conformance-fail]`. Update this file as the playbook evolves._
_Last synced from plan version: 1_
