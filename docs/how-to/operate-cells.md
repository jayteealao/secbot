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

## Set up from scratch

Do these in order. Every value stays in your shell or in a GitHub secret; none goes in the repo.

1. Create the buckets, their tokens, and the heartbeats with OpenTofu: put
   `TF_VAR_state_passphrase` and `TF_VAR_cloudflare_account_id` in your shell, run
   `mise run infra:plan`, read the plan, then `mise run infra:apply`. Read each value below with
   `tofu output -raw <name>` (or `-json` for a map) in `infra/tofu`.
2. Put the host values in your shell (table below).
3. Run `mise run smoke:r2` once per bucket. It reads `R2_ENDPOINT`, `R2_BUCKET`,
   `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`: set them to the test bucket's values
   (`SECBOT_R2_ENDPOINT`, `SECBOT_TEST_BUCKET`, `SECBOT_TEST_R2_*`), then to the production
   bucket's (`SECBOT_PROD_*`). Each run must print `smoke:r2: PASS`.
4. Set up the test cell: `mise run host:setup`, then, once the smoke test passed,
   `mise run host:setup -- -e celld_replication_confirmed=true`, which starts `celld@test`.
5. Set up production (next section).
6. Run `mise run probe:ports`: every celld port must refuse a connection from outside the
   private network.
7. In GitHub, add the secrets and variables (second table below).

| Shell variable | What it is | Where it comes from |
| --- | --- | --- |
| `SECBOT_VPS_SSH` | Your SSH config alias of the VPS | Your SSH config |
| `SECBOT_R2_ENDPOINT` | The R2 endpoint (EU) | `tofu output -raw r2_endpoint` |
| `SECBOT_TEST_BUCKET`, `SECBOT_TEST_R2_ACCESS_KEY_ID`, `SECBOT_TEST_R2_SECRET_ACCESS_KEY` | The test bucket and its token | `r2_access_key_ids`, `r2_secret_access_keys` outputs |
| `SECBOT_TEST_HEARTBEAT_URL`, `SECBOT_HEARTBEAT_URLS` | The test cell's heartbeat ping URL (the fleet's, and the cells', `<cell>:<url>,…`) | `tofu output -raw test_cell_heartbeat_url` |
| `SECBOT_PROD_BUCKET`, `SECBOT_PROD_R2_ACCESS_KEY_ID`, `SECBOT_PROD_R2_SECRET_ACCESS_KEY` | The production bucket and its token | the same outputs |
| `SECBOT_PROD_HEARTBEAT_URLS` | `owner:<url>,second:<url>,household:<url>` | `tofu output -json heartbeat_urls` |
| `SECBOT_DEPLOY_TEST_PUBKEY`, `SECBOT_DEPLOY_PUBKEY` | The public halves of the test-cell and production deploy keys | The key pairs you made for CI |
| `OPENROUTER_API_KEY` | The model gateway key | OpenRouter |
| `BETTERSTACK_INCIDENTS_TOKEN`, `BETTERSTACK_REQUESTER_EMAIL` | The token and e-mail the cells open incidents with | Better Stack |
| `SECBOT_DEVICE_KEYS` | The registered devices, `<name>:<person>:<sha256>,…` | `secbot device new` (see [the CLI how-to](cli.md)) |
| `SECBOT_PRIVATE_HOSTS` | The private host names the cells answer on | Your private network |
| `SECBOT_TIME_ZONE` (optional) | The people's IANA time zone | You |
| `SECBOT_TEST_OPENROUTER_API_KEY`, `SECBOT_TEST_BETTERSTACK_INCIDENTS_TOKEN`, `SECBOT_TEST_DEVICE_KEYS` (optional) | The test cell's own values; when set they replace the shared ones for the test cell only | As above |

| GitHub setting | Kind | Holds |
| --- | --- | --- |
| `VPS_DEPLOY_HOST`, `VPS_SSH_KNOWN_HOSTS` | secret | The VPS's private name and its host key |
| `TEST_CELL_DEPLOY_SSH_KEY` | secret (environment `test-cell`) | The test-cell deploy key |
| `VPS_DEPLOY_SSH_KEY` | secret (environment `production`) | The production deploy key |
| `HEARTBEAT_API_TOKEN` | secret | The Better Stack API token that `check:heartbeats` reads |
| `FORKS_READ_TOKEN` | secret | Read access to the private forks |
| `SDLC_GATE_SERVER_RELEASE` | variable | `true` turns on the release, rollback, restore, and drill workflows |
| `SECBOT_SECRETS_CELL` | variable | `true` once the secrets cell exists |

## Set up the production fleets

1. Run `mise run smoke:r2` against the production bucket (step 3 above). It must print
   `smoke:r2: PASS`.
2. Put the production values in your shell: `SECBOT_PROD_BUCKET`, `SECBOT_PROD_R2_ACCESS_KEY_ID`,
   `SECBOT_PROD_R2_SECRET_ACCESS_KEY`, and `SECBOT_PROD_HEARTBEAT_URLS`, with the shared values
   from the table above (`SECBOT_R2_ENDPOINT`, `OPENROUTER_API_KEY`, the Better Stack values,
   `SECBOT_DEVICE_KEYS`, `SECBOT_PRIVATE_HOSTS`).
3. Run `mise run host:setup -- -e celld_production=true -e celld_production_confirmed=true`.
   Host setup writes each fleet's files, makes each environment's operator key once on the VPS,
   and starts `celld@prod-owner` and `celld@prod-shared`. A second run reports `changed=0`.

Without `celld_production=true`, host setup touches only the test cell. Run host setup again
whenever a release changes the VPS release tool: `stage` refuses with `run "mise run host:setup"
first` until the VPS has the bundle's copy.

## Deploy

1. `mise run build`, then stage the bundle: `mise run stage -- --version <tag> --sha256 <sha> --file <bundle>`.
2. Deploy the test cell: `mise run deploy -- --env test-cell --version <tag>`.
3. Check it: `mise run check:cells -- --env test-cell --version <tag>` and `mise run check:alarms -- --env test-cell`.
4. Run the integration suite: `mise run test:integration -- --env test-cell`.

The release, rollback, restore, and drill workflows do nothing until the repository variable
`SDLC_GATE_SERVER_RELEASE` is `true`; set it first.

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
[cell-restore](../runbooks/cell-restore.md). A production deploy with no `--sha256` checks the
bundle against the hash the deploy ledger recorded for that version's last production deploy,
so a bundle the test-cell key staged can never reach production. `rollback.yml` (like the
workflows above) needs `SDLC_GATE_SERVER_RELEASE` set to `true`.

## Restore one cell

Run `restore.yml` for one cell. It states the data-loss window, waits for your approval, records
the restore in the ledger, and runs `mise run restore -- --env production --cells <cell> --snapshot <id>`.
The secrets cell is never restored.

## Run the restore drill

`restore-drill.yml` runs on the 1st of each month and on dispatch, behind your production
approval. It copies the newest release snapshot of the owner cell into the test cell and restores
it there, then checks that the test cell is up. By hand: `mise run restore:drill -- --cells owner`.

The copy of the production snapshot in the test bucket is deleted as soon as the restore ends.
The test cell itself holds real data until its next deploy. That deploy wipes the restored cells
first and prints `drill data wiped: <cells>`.

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
