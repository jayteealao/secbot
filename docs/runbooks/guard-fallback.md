# Runbook: guard-fallback

## When this fires

Cell logs (one JSON line per event) that match any of these trigger this runbook:

- `"event":"guard.fallback"`: the decision model gave no answer (the `cause` names why, for
  example `http-503`, `http-429`, `timeout`, `malformed`); the call went to the reviewer.
- `"event":"guard.reviewer_failed"`: the reviewer gave no verdict (`cause`: `timeout`, `error`,
  `malformed`, `unknown-model`, `rate-limited`, or `paused`); the call was held for the person
  (`reviewer unavailable`), or in shadow mode recorded as `would ask`.
- `"event":"guard.reviewer_paused"`: the reviewer failed several times in a row and is not asked
  for a minute.
- `"event":"approval.held"` with `"reason_source":"reviewer-unavailable"`.
- `"event":"guard.error"`: the guard itself failed; the call was refused, not run.
- `"event":"limit.crossed"`: a person or the developer budget reached 80% or 100% of its limit.

## What the cell already does

- A decision-model failure never lets a call through: the reviewer gets the call.
- A reviewer failure never lets a call through in enforce mode: the call is held for the person,
  who answers it with `/allow N` or `/deny N` in `secbot chat`.
- A cell asks the reviewer at most 30 times a minute. Above that, and for one minute after five
  reviewer failures in a row, a marked call is held without a review (`rate-limited`, `paused`),
  so an outage of the decision model cannot turn every tool call into a paid review.
- A 402 or 403 from either model puts the cell in the credit pause, as for an agent call.
- At 80% and 100% of a limit the person gets one notice and the owner one alert; above a limit
  hand-offs, reminders, and routine runs wait and are never dropped.

## Steps

1. Read the latest `guard.fallback` and `guard.reviewer_failed` lines: which layer failed, why,
   and since when. `approval.held` lines carry the same `decision`, `fallback`, and
   `reviewer_cause` fields.
2. `http-402` or `http-403`, or `"credit":true`: add credit or raise the key limit at the model
   gateway, as in the [model outage runbook](model-outage.md).
3. The decision model fails on its own (`http-5xx`, `timeout`): switch the cell's decision model
   with `secbot mode decision <person> <model>` (`jev`, `clef`, or `clef-flash`) until it
   answers again.
4. The reviewer fails (`unknown-model`, `error`, `timeout`): move the reviewer to another model
   with `secbot model set reviewer <model-id>`; the next review uses it.
5. Many held calls during an outage: the person answers them in `secbot chat`; an unanswered call
   lapses after 24 hours as a refusal. Nothing runs without a verdict.
6. `guard.error`: read its `error` field and the cell's `harness.report` lines; a guard error
   refuses the call, so the agent sees `the guard failed; the call was not run`.
7. `limit.crossed`: read `secbot cost --owner`; raise a limit with `secbot limits set <person>
   <usd>` or the developer budget with `secbot limits developer <usd>`, or wait for the month to
   reset. Waiting work continues on its own.

## Notes

_Update this file as the playbook evolves._
