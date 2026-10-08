# Reference: the cell API

The HTTP routes and the WebSocket frames a cell worker serves. The `secbot` command line and the
VPS release tool are the clients today; a later client (an app) uses the same surface.

**Compatibility rule.** Everything under `/v1` only grows: a route, a field, or a frame type may be
added, never renamed or removed. A client ignores fields and frame types it does not know.

## Person routes: `/v1/cells/{person}/…`

Auth: a device key (`Authorization: Bearer <key>`) registered for that person, on one of the
private host names the cell was deployed with. A refusal answers `401` (no or unknown key) or
`403` (a key for another person, or another host name) and logs `cli.refused`. `{person}` is
`owner` or `second`. Every error body is `{"error": "<reason>"}`.

| Method | Path | Request | Response | Statuses |
| --- | --- | --- | --- | --- |
| GET | `/status` | none; `?tasks=1` adds the task list | `{version, roles, …}` | 200 |
| GET | `/alarm` | none | the stored alarm against the earliest stored timer; never re-arms | 200 |
| GET | `/missed` | none | `{messages: [{kind: "answer", entryId, text} \| {kind: "followup", entryId, from, text}], remaining}`; the oldest 100 after this device's cursor, which moves past them only | 200 |
| GET | `/models` | none | `{roles: [{role, model, source}]}` | 200 |
| PUT | `/models/{role}` | `{"model": "<id>"}` (at most 16 KiB) | the role's new model | 200, 400 (unknown role or model, bad body), 413 |
| POST | `/specialists` | `{"name", "instruction", "model"?}` (at most 16 KiB; instruction at most 4000 characters) | `{name, status: "added"}` | 201, 400, 413 |
| GET | `/session` | WebSocket upgrade | the frame stream below | 101, 501 (no WebSocket support) |

## The session frames

The client sends one frame type:

```json
{"type": "input", "text": "<the line, 1 to 20000 characters>", "requestId": "<8-128 of A-Za-z0-9._:->"}
```

The cell sends these, as JSON text frames:

| Frame | Fields | When |
| --- | --- | --- |
| `connected` | `lead` | First, once per connection. |
| `missed` | `entryId`, `from` (`null` for the lead's own answer), `text`, `remaining` | Next, oldest first: what the lead said while no session was open on this device. `remaining` counts newer ones left for `GET /missed`. |
| `accepted` | `requestId` | The input was submitted to the lead. A resend with the same `requestId` is accepted again but submitted once. |
| `rejected` | `requestId`, `message` | The cell refused that input (empty, too long, malformed). Resending it is refused the same way. |
| `delta` | `text` | A piece of the lead's answer as it streams. |
| `answer` | `entryId`, `text` | The lead's committed answer. |
| `followup` | `entryId`, `from`, `text` | A specialist's report relayed by the lead. |
| `waiting` | `on` | `true` while the model gateway is failing and inputs are kept; `false` when it answers again. |
| `error` | `message`, `requestId`? | A frame the cell could not read (no `requestId`), or an input it could not take now (with `requestId`; the client resends it after a reconnect). |

Ordering and reconnects: `connected`, then every `missed` frame, then live frames. An input with
no `accepted` or `rejected` frame is resent on the next connection under the same `requestId`.

## Host routes

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| GET | `/health?cells=` | none (reachable from the host only) | `{version, cells: {<cell>: {status, version?, roles?, reason?}}}` |
| GET | `/alarms?cells=` | none (reachable from the host only) | `{version, cells: {<cell>: <alarm report>}}` |

## Operator routes: `/ops/…`

Auth: the operator key in `x-secbot-operator`; any other request is `401` and logs `ops.refused`.
Only the VPS release tool calls them.

| Method | Path | Does |
| --- | --- | --- |
| POST | `/ops/snapshot?id=<id>[&cells=]` | Each cell dumps to `snapshots/<id>/<cell>.json` in the fleet's bucket. |
| POST | `/ops/restore?id=<id>&cell=<cell>` | Loads that dump into the cell (refuses a later contract step or a digest mismatch). |
| POST | `/ops/wipe?cells=` | Drops every table of the cells (the test cell, after a drill). |
| GET | `/ops/digest?cells=` | Each cell's digest and row count. |
| GET | `/ops/heartbeats?cells=` | Each cell's heartbeat routine state. |
| POST | `/ops/write` | One committed single-row write (the test cell only). |

## Household routes: `/internal/household/…`

Auth: the operator key. A person cell in another fleet calls these to reach the household cell.

| Method | Path | Request | Response | Statuses |
| --- | --- | --- | --- | --- |
| POST | `/internal/household/read` | `{"document": "<name>"}` | the document | 200, 400 (`send {document}`), 401, 404 (served by another fleet), 503 (no binding) |
| POST | `/internal/household/apply` | a change with an operation id | the result; the same operation id applies once | 200, 400 (a refused change), 401, 500 |
| GET | `/internal/household/status` | none | the household cell's version and roles | 200 |

A failed call is logged on both sides: `household.call` with `outcome: "refused" | "failed"`,
`status`, and the error on the caller; `household.refused` or `household.error` on the household
fleet.
