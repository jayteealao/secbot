# Runbook: alarm-lost

## When this fires

CI logs that match any of these patterns (case-insensitive) trigger this runbook:

- `no next alarm`
- `alarm mismatch`
- `alarm.*(missing|unset|null)`
- `missed briefing`

`mise run check:alarms -- --env <test-cell|production>` prints one line per cell: `alarm ok`,
`no next alarm` (timers are stored but no alarm is set), or `alarm mismatch` (the alarm is later
than the earliest stored timer). The cell logs `alarm.set` when it moves its alarm, `alarm.fired`
when the alarm runs, and `routine.fired` for each routine that ran.

## Steps

1. Re-arm the cell alarm to the earliest pi-durable task timer: any request to an evicted cell
   (for example `mise run check:cells`) opens it, and opening re-arms; then run
   `mise run check:alarms` again and confirm every line says `alarm ok`.
2. Confirm the next briefing time for every person cell.
3. Alert the owner by push and email with the affected cells.
4. Open an issue; treat the release as bad until the cause is known.

## Notes

_Seeded from ship plan `recovery-playbooks[alarm-lost]`. Update this file as the playbook evolves._
_Last synced from plan version: 1_
