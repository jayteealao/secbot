# Runbook: alarm-lost

## When this fires

CI logs that match any of these patterns (case-insensitive) trigger this runbook:

- `no next alarm`
- `alarm.*(missing|unset|null)`
- `missed briefing`

## Steps

1. Re-arm the cell alarm to the earliest pi-durable task timer.
2. Confirm the next briefing time for every person cell.
3. Alert the owner by push and email with the affected cells.
4. Open an issue; treat the release as bad until the cause is known.

## Notes

_Seeded from ship plan `recovery-playbooks[alarm-lost]`. Update this file as the playbook evolves._
_Last synced from plan version: 1_
