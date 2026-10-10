# Runbook: secrets-cell-refused

## When this fires

Cell logs (one JSON line per event) that match any of these trigger this runbook:

- `"event":"secrets.refused_start"`: the secrets cell refused to start (`reason`: `key file
  missing`, `key directory missing`, `key file readable by other users`, or the key helper did not
  answer). It is logged once per new reason and then once every 50 attempts, with `attempts`.
- `"event":"secrets.unavailable"` or `"event":"secrets.unreachable"`, and `secbot` printing
  `secbot: refused: secrets cell unavailable`.
- `"event":"secrets.call"` with `"outcome":"failed"`: a person cell could not reach the secrets
  cell; `http_status` 503 means its key is not usable, 500 a failure in the cell, none a network
  failure.
- `"event":"cell.reopen"` or `"event":"harness.reports_suppressed"` for the secrets cell.
- A deploy that stopped with `the secrets cell's key helper (secbot-key-helper@<env>) is not
  running`.
- `"event":"secret.refused"`: one refused grant or read (informational; the refusal is in that
  person's `secbot activity`).

## What the cell already does

- With no usable key the secrets cell answers nothing: every secret read, broker call, and
  `secbot secrets` command is refused, and nothing is retried with a cached value.
- When celld closes its database, the cell logs one report and one reopen and opens again on the
  next request.

## Steps

1. Read the latest `secrets.refused_start` line and its `reason`.
2. `key file missing`, `key directory missing`, a deploy that stopped on the key helper, or no
   answer from the helper: run `mise run host:setup`. It starts the helper and creates a first key
   only where none exists; it never replaces a key.
3. `key file readable by other users`: run `mise run host:setup`, which sets the owner and modes
   again. Do not change the files by hand.
4. `cell.reopen` with nothing else: no action; the next request opens the cell again.
5. A rotation that stopped partway: run `secbot secrets rotate` again until it says 0 are left
   under the old key. Keep every old key file while any secret is under it.

## When the key directory is lost

The master keys are never backed up and never leave the host, and the secrets cell is never
snapshotted or restored. Losing `/etc/secbot/secrets-keys/<env>` (or the VPS) makes every stored
secret unreadable for good, and the cell refuses to start. To recover:

1. Run `mise run host:setup`. It creates a fresh first key for each environment that has none,
   and the cell starts again. The old records stay, but nothing opens them: a read of one is
   refused.
2. Rotate every credential the cell held at its source (the health service, the production
   system, any service a plain secret opened): treat the old values as exposed.
3. Add each new value under its old name with `secbot secrets add` (with `--broker` for health
   and production tokens). Adding a secret again replaces its record, sealed under the new key;
   its allowlist entries and grants stay.
4. Check with `secbot secrets list --person <name>` that every secret the household still needs
   was added again.

## Notes

_Update this file as the playbook evolves._
