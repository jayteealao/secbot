# Reference: mise cell tasks

Every task that builds, deploys, checks, snapshots, restores, or measures the cells. Run each one
with `mise run <task> -- <flags>`. The tasks that reach the VPS run the release tool over SSH:
`SECBOT_VPS_SSH` names the SSH config alias of the VPS (in GitHub Actions the alias is
`secbot-vps`). The repo never holds the VPS address.

## Conventions

- **Exit codes.** `0` pass. `1` fail: the task prints the reason; a VPS task also prints the
  release tool's own line, which starts with `secbot-release:`. The check tasks run inside a
  poll loop in CI, which retries every 30 seconds for up to 15 minutes.
- **Cell names** follow the release workflows: `owner`, `person` (the second person's cell),
  `household`, and `secrets`. `secrets` is skipped with the line
  `cell secrets skipped: it arrives with the secrets cell` until that cell exists. Without
  `--cells`, a task covers every cell of the environment. The printed lines name the second
  person's cell `second`.
- **Environments.** `--env test-cell` is the test cell (one celld fleet that serves every cell).
  `--env production` is the production cells: the owner fleet serves `owner`; the shared fleet
  serves `second` and `household`.
- **The VPS lock.** Every task that changes the release store or a cell holds one lock for its
  whole run. A multi-step task (`test:integration`, `measure:heap`, `measure:write-delay`) takes a
  lease first; while another holder's lease is live, every locking command waits, up to 30
  minutes, then fails with `the VPS lock is held by <holder> until <time>`. A lease expires on its
  own, so a crashed run cannot block a release.
- **No secret in output.** No task prints a key, a token, a ping URL, an address, or a household
  item.

## Build and release

| Task | Flags | Prints |
| --- | --- | --- |
| `build` | none | Builds `dist/`: the worker, the test-cell worker, the release tool, `manifest.json`. |
| `deploy:dry-run` | none (no credentials) | `dry-run: bundle <version>, contract step <n>` and one line per file. |
| `stage` | `--version V --sha256 S --file F` | `staged <V> (<S>)`. Refuses `SHA-256 mismatch: received …, expected …`. |
| `deploy` | `--env test-cell\|production --version V [--sha256 S] [--cells C]` | Per fleet: `manifest diff against the deployed bundle of <fleet>:` or `first deploy to <fleet>`, then `deployed <V> to <fleet> (<cells>)`. On the test cell after a drill: `drill data wiped: <cells>`. Refuses `refusing a downgrade past contract step <n> (bundle <V> has step <m>)`, `version <V> is not staged`, `SHA-256 mismatch for <V>: requested …, staged …`, `celld@<fleet> is not running; …`. In CI, a production deploy also writes a `deploy` record with the run id and attempt to the ledger. |
| `test:conformance` | `[--target test-cell\|local] [--long-transaction]` | `storage conformance suite: PASS` or `storage conformance suite: FAIL …`, `conformance case fail: <case>: <error>`, `adapter mismatch: …`. Heavy: run it only under the campaign lock. |

## Checks

| Task | Flags | Prints |
| --- | --- | --- |
| `check:cells` | `--env E [--version V] [--cells C]` | One line per cell: `cell <name> up <version>`, `cell <name> up <version> (expected <V>)`, or `cell <name> down: <reason>`. |
| `check:alarms` | `--env E [--cells C]` | `cell <name> alarm ok <alarm> (earliest timer …)`, `cell <name> alarm ok: no timers`, `cell <name>: no next alarm (earliest timer …)`, `cell <name>: alarm mismatch: alarm … later than earliest timer …`, `cell <name> down: <reason>`. |
| `check:heartbeats` | `[--since-deploy] [--cells C] [--env E]`; needs `HEARTBEAT_API_TOKEN` | `heartbeat <cell> fresh: last ok ping <time>`, or a failure: `heartbeat <cell> stale: last ok ping … before the deploy at …`, `heartbeat <cell> missing: …`, `heartbeat <cell> missing in Better Stack ("secbot <name> cell")`, `heartbeat <cell> down in Better Stack (status <status>)`. Without `--env`, the SSH user picks the environment: `deploy-test` checks the test cell, `deploy` checks production. A cell passes only when Better Stack lists its heartbeat as up and the cell's own last 2xx ping is after its fleet's deploy. On the test cell every cell pings the one heartbeat `secbot test cell`. |
| `test:durability` | `--env test-cell [--crash-only] [--down-seconds 90]` | `durability <case> pass\|fail: <detail>` for `crash-restarted`, `crash-conversation`, `crash-no-partial-write`, `crash-timer`, `crash-job-and-cut-off-call`, `crash-alarm`, `late-alarm-runs-once`, `late-alarm-moves-on`, `household-roundtrip`, `check-alarms-late`, `check-alarms-missing`, `check-alarms-rearmed`. |
| `test:integration` | `--env test-cell` | The durability lines, then `integration durability\|snapshot-roundtrip\|check-alarms pass\|fail: <detail>`. The snapshot round trip snapshots every test cell, changes the household list, restores the household cell, and compares digests; its detail lists the snapshot bytes per cell. The release runs it before any production stage. |

## Snapshots, ledger, restore

| Task | Flags | Prints |
| --- | --- | --- |
| `snapshot` | `--env E --snapshot-id pre-<tag>-<run-id>` | `snapshot <cell> ok digest <12 hex> rows <n> bytes <n>` per cell, then `snapshot <id>: <n> cells, contract step <n>`. Each dump goes to the fleet's bucket (R2, another company from the VPS) as `snapshots/<id>/<cell>.json`. |
| `ledger:record` | `--kind release\|rollback\|restore [--version V] [--cells C] [--snapshot-id ID] [--run-id R --run-attempt A]` | `ledger: recorded <kind> <V> run <R> attempt <A>`. Only the production user may write the ledger; the tool also copies it to the production bucket. |
| `ledger:verify` | `--kind K --run-id R --run-attempt A [--version V]` | `ledger ok: <kind> run <R> attempt <A> is the newest`, or a refusal: `ledger: the newest record is <kind> from …, not this …`, `ledger: a newer deploy of <V> from … came after this <kind>`, `ledger: no approved release, rollback, or restore is recorded`. |
| `restore` | `--env E --cells CELL --snapshot ID` | `restore <cell> ok digest <12 hex> rows <n>`, then `outbound-effects log: none in this release (…)`. Refuses `the secrets cell is never restored: …`, `restore takes exactly one cell`, `snapshot <id> not found for cell <cell>`, `refusing a snapshot past contract step <n> (snapshot <id> has step <m>)`, `snapshot digest mismatch: …`. The cell closes its harness, loads the dump in one transaction, checks the digest, reopens, and sets its alarm from the restored timers. |
| `restore:drill` | `[--snapshot ID] [--cells owner\|person\|household]` | `drill <id>: restore <cell> ok digest … rows …`, then `drill: the test cell holds real data until its next deploy wipes it`. Production user only. Without `--snapshot`, it uses the newest release snapshot in the ledger. |

## Measurements and drills

| Task | Flags | Prints |
| --- | --- | --- |
| `measure:heap` | `--env test-cell [--seconds 180]` | `heap: lab load live tasks <n>, specialist calls <n>`, `heap peak per isolate <n> MiB of the 128.0 MiB limit; test fleet heaps …, RSS …; VPS celld RSS …`, then `heap ok: fallback not needed` or the failure `heap over the limit: raise celld_v8_heap_limit_mb and move developer work into its own cell`. |
| `measure:write-delay` | `--env test-cell [--writes 200]` | `write-delay: <n> committed single-row writes (after 10 warm-up writes)` and `write-delay median <ms> ms, p95 <ms> ms, min …, max …`. |
| `measure:cost` | `--assumptions <json> [--log <cell log> --log-days N] [--out <md>]` | The monthly model and fixed cost per person, one arithmetic line per step. Without `--log` it is a catalog estimate from the installed model prices. |
| `drill:heartbeat-alert` | none | Stops the test cell for 420 s (past the heartbeat's 300 s period and 60 s grace), then starts it: `alert drill: the test cell was down from … to …; confirm the push and the e-mail, then run check:heartbeats`. |
| `vps:lease` | `acquire\|release --holder H [--seconds N]` | `lease acquired by <H> for <N> s`, `lease released by <H>`, `lease: <H> holds no lease`. |

## Related

- [How to operate the cells](../how-to/operate-cells.md)
- Runbooks: [cell-adopt-fail](../runbooks/cell-adopt-fail.md), [cell-restore](../runbooks/cell-restore.md),
  [alarm-lost](../runbooks/alarm-lost.md), [heartbeat-missing](../runbooks/heartbeat-missing.md),
  [conformance-fail](../runbooks/conformance-fail.md)
