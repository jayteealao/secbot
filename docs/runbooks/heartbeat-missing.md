# Runbook: heartbeat-missing

## When this fires

CI logs that match any of these patterns (case-insensitive) trigger this runbook, and so does a
Better Stack alert for a `secbot <cell> cell` heartbeat:

- `heartbeat .* (stale|missing|down)`
- `heartbeat: no cell answered`

`mise run check:heartbeats` prints one line per cell: `fresh`, `stale` (the cell's last 2xx ping
is older than its fleet's deploy), `missing` (no 2xx ping yet, no heartbeat in Better Stack, or
the cell did not answer), or `down in Better Stack`.

## Steps

1. Run `mise run check:cells -- --env <test-cell|production> --cells <cell>`. A cell that is down
   cannot ping; follow [cell-adopt-fail](cell-adopt-fail.md) first.
2. Read the cell's `heartbeat.ping` lines on the VPS:
   `journalctl -u celld@<fleet> | grep heartbeat.ping`. `outcome` and `http_status` say whether
   the ping reached Better Stack; `skipped` means the cell has no ping URL.
3. Run `mise run check:alarms -- --env <test-cell|production> --cells <cell>`. The heartbeat is a
   routine with a timer; a lost alarm stops it. Follow [alarm-lost](alarm-lost.md) if it fails.
4. If the line is `skipped` or `missing in Better Stack`, check the cell's entry in
   `SECBOT_HEARTBEAT_URLS` (test cell) or `SECBOT_PROD_HEARTBEAT_URLS` (production) against
   `tofu output -json heartbeat_urls`, run host setup, and deploy again.
5. Run `mise run check:heartbeats -- --since-deploy --cells <cell>` until it prints `fresh`.

## Notes

The cell stores its last ping time and outcome, never the ping URL. The ping URLs live only in
the VPS runtime files and the owner's shell.
