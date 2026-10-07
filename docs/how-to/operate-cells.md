# How to operate the cells

For the maintainer. Each section is one task. The flags and every printed line are in the
[mise task reference](../reference/mise-tasks.md).

Before you start, put the SSH config alias of the VPS in your shell as `SECBOT_VPS_SSH`. Your
machine must be on the private network. The address never goes in the repo.

## The layout

| Environment | celld unit | Cells | Bucket |
| --- | --- | --- | --- |
| test cell | `celld@test` | owner, second person, household (one fleet) | the test bucket |
| production | `celld@prod-owner` | owner | the production bucket, prefix `owner/` |
| production | `celld@prod-shared` | second person, household | the production bucket, prefix `shared/` |

celld runs one application per fleet, so each production rollout stage is its own fleet. The
owner cell reaches the household cell in the other fleet over the private network, with the
operator key and the same operation ids, so a retried change still applies once.

## Set up the production fleets

1. Run `mise run smoke:r2` against the production bucket (set the `R2_*` values for it). It must
   print `smoke:r2: PASS`.
2. Put the production values in your shell: `SECBOT_PROD_BUCKET`, `SECBOT_PROD_R2_ACCESS_KEY_ID`,
   `SECBOT_PROD_R2_SECRET_ACCESS_KEY`, and `SECBOT_PROD_HEARTBEAT_URLS`
   (`owner:<url>,second:<url>,household:<url>` from `tofu output -json heartbeat_urls`).
3. Run `mise run host:setup -- -e celld_production=true -e celld_production_confirmed=true`.
   Host setup writes each fleet's files, makes each environment's operator key once on the VPS,
   and starts `celld@prod-owner` and `celld@prod-shared`. A second run reports `changed=0`.

Without `celld_production=true`, host setup touches only the test cell.

## Deploy

1. `mise run build`, then stage the bundle: `mise run stage -- --version <tag> --sha256 <sha> --file <bundle>`.
2. Deploy the test cell: `mise run deploy -- --env test-cell --version <tag>`.
3. Check it: `mise run check:cells -- --env test-cell --version <tag>` and `mise run check:alarms -- --env test-cell`.
4. Run the integration suite: `mise run test:integration -- --env test-cell`.

A release tag runs the same steps in `release-server.yml`, then asks for your approval. It
snapshots every production cell, records the approved attempt in the deploy ledger, and deploys
the owner fleet (`--cells owner`), then the shared fleet (`--cells person,household`). Each stage
runs `check:cells`, `check:alarms`, and `check:heartbeats` before the next. The secrets stage is
skipped until the repository variable `SECBOT_SECRETS_CELL` is `true`.

## Roll back

Run `rollback.yml` with the prior tag and the cells. By hand, from the private network:

```
mise run deploy -- --env production --cells owner --version <prior-tag>
mise run check:cells -- --env production --cells owner --version <prior-tag>
mise run check:alarms -- --env production --cells owner
```

A rollback restores no data. The deploy refuses a downgrade past a contract step; then follow
[cell-restore](../runbooks/cell-restore.md).

## Restore one cell

Run `restore.yml` for one cell. It states the data-loss window, waits for your approval, records
the restore in the ledger, and runs `mise run restore -- --env production --cells <cell> --snapshot <id>`.
The secrets cell is never restored.

## Run the restore drill

`restore-drill.yml` runs on the 1st of each month and on dispatch, behind your production
approval. It copies the newest release snapshot of the owner cell into the test cell and restores
it there, then checks that the test cell is up. By hand: `mise run restore:drill -- --cells owner`.

The test cell holds real data until its next deploy. That deploy wipes the restored cells first
and prints `drill data wiped: <cells>`.

## Check the alarms

`mise run check:alarms -- --env <test-cell|production>`. Each cell's alarm must be at or before
its earliest stored routine timer. See [alarm-lost](../runbooks/alarm-lost.md).

## The buckets

Each cell's database replicates to its fleet's R2 bucket (EU), at a different company from the
VPS. Snapshots and the deploy ledger copy sit in the same bucket, under
`r2/secbot-snapshots/`. OpenTofu (`infra/tofu`) manages the buckets and their tokens.

## Heartbeats and alerts

Each cell's heartbeat routine pings its Better Stack heartbeat every 4 minutes. OpenTofu manages
four heartbeats: `secbot test cell`, `secbot owner cell`, `secbot second cell`, and
`secbot household cell` (period 300 s, grace 60 s, push and e-mail on). Better Stack alerts you
when a cell misses its window.

- `mise run check:heartbeats -- --since-deploy` needs `HEARTBEAT_API_TOKEN` in your shell.
- To test the alert, run `mise run drill:heartbeat-alert`. The test cell is down for 420 s; you
  get a push and an e-mail; then `check:heartbeats` passes again.

See [heartbeat-missing](../runbooks/heartbeat-missing.md).

## The VPS lock and leases

Deploys, rollbacks, restores, drills, and the test-cell runs take the same VPS lock. A run of
several steps holds a lease (`mise run vps:lease -- acquire --holder <name> --seconds 3600`) and
releases it at the end (`... release --holder <name>`). Another holder's command waits for the
lease, up to 30 minutes. A lease that expires frees itself.

## Measure

- `mise run measure:heap -- --env test-cell`: the heap of one cell with a lead and four
  specialists at once and a long job. Over 128 MiB per isolate, raise `celld_v8_heap_limit_mb` in
  `infra/ansible/roles/celld/defaults/main.yml` and move developer work into its own cell.
- `mise run measure:write-delay -- --env test-cell --writes 200`: the median and the 95th
  percentile of committed single-row writes.
- `mise run measure:cost -- --assumptions <file.json>`: the monthly cost per person.
