# Runbook: model-outage

## When this fires

Cell logs (one JSON line per event) or alerts that match any of these trigger this runbook:

- `"event":"model.health"` with `"state":"failing"` or `"state":"credit"`
- `"event":"model.alert"` (an incident opened: waiting for the model for 15 minutes, or the credit limit reached)
- `"event":"model.call"` lines with `"credit":true` or a non-`stop` stop reason
- `"event":"cli.refused"` (a device or host the cell does not accept)

The guard's own model layers (`guard.fallback`, `guard.reviewer_failed`, a call held as
`reviewer unavailable`) and the limits (`limit.crossed`) have the
[guard fallback runbook](guard-fallback.md); the secrets cell (`secrets.refused_start`,
`secrets cell unavailable`) has the [secrets cell runbook](secrets-cell-refused.md).

## What the cell already does

- A failing model call is retried with backoff (2 s doubling to 60 s) for as long as it takes.
  The person's message is never dropped; the CLI shows `waiting for the model`.
- After 15 minutes of failure one incident is opened (push and e-mail). A credit-limit error
  (HTTP 402) opens one at once.
- When a call succeeds again, `model.health state=ok` is logged and the CLI shows
  `the model is answering again`. Waiting turns finish on their own.

## Steps

1. Read the latest `model.call` line: which role and model failed, and its stop reason.
2. Credit (`state=credit`): add credit or raise the key limit at the model gateway. Nothing in the
   cell needs to change; the next retry succeeds.
3. Outage (`state=failing`) on one model: move the role to another model with
   `secbot model set <role> <model-id>`; the change applies from the next turn.
4. Outage on every model: wait; check the gateway's status page. Do not redeploy.
5. `model.alert` with `outcome=skipped` or `failed`: the incident token or e-mail is missing or
   wrong in the runtime settings; fix it, run host setup, and redeploy.
6. `cli.refused`: `missing_key` or `unknown_key` means the device is not registered (see the CLI
   how-to); `other_person` means a key used against another person's cell; `not_private_host`
   means a request came in on a host name the cell was not deployed with.

## Notes

_Update this file as the playbook evolves._
