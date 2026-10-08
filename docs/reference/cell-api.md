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
| GET | `/rules` | none | `{owner: [Rule], person: [Rule], timeZone}`: the owner's rules (read only here) and the person's own rules | 200 |
| POST | `/rules` | one rule without an id: `{agent, tool, verdict, match?}` (at most 16 KiB) | `{rule: Rule}` | 201, 400 (`refused: …`), 413 |
| DELETE | `/rules` | the rule's `{agent, tool, match?}` as it was added | `{removed: Rule}` | 200, 400 (`refused: …`), 404 (no such rule), 413 |
| GET | `/activity?month=YYYY-MM&before=<n>&limit=<1-200>` | none; `month` defaults to the current month in the cell's time zone, `limit` to 50 | `{person, month, timeZone, total, records: [ActivityRecord], next}`, newest first; pass `next` as `before` for the next older page (`null` when none is left) | 200, 400 (a bad parameter) |

### Rules

A `Rule` is `{id, agent, tool, verdict, match?, source, addedAt}`:

- `agent`: `all`, `lead`, or a specialist's name.
- `tool`: a tool name, `pay` (every tool named `pay_…`), or `*` (any tool).
- `verdict`: `permit`, `ask-first`, or `prohibit`.
- `match`: `{kind, field, value}` on one argument. `kind` is `exact`, `prefix`, `email-domain`,
  `web-domain`, or `regex`. Values are compared after NFKC, URL decoding, and lower case; domains
  match themselves and their subdomains. A regular expression is matched without case, may hold
  at most one repeat (`*`, `+`, `{n,}`), no back-reference, no look-around, and at most 200
  characters, and runs on at most 4096 characters of a value (a longer value counts as a match for
  `prohibit` and `ask-first`, and as no match for `permit`).
- `source`: `release` (the owner rule that agents never pay; it cannot be removed), `default` (a
  new person's four permit rules), `owner`, `person`, or `allow-always`.
- `addedAt`: milliseconds since 1970, by the cell's clock.

Inside one level the most specific rule decides (an agent name before `all`, a tool name before
`pay` before `*`, a match before none, `exact` before `prefix` before a domain before `regex`);
across levels the strictest verdict wins, so a person's rule never loosens an owner rule. A call
no rule matches is allowed by the rules.

A person rule looser than an overlapping owner rule is refused, naming the owner rule:

```json
{"error": "refused: this rule is looser than an owner rule:\n  all handoff (specialist = developer) -> ask first\n  Your rules can be stricter than the owner's rules, never looser."}
```

Other refusals: an unknown agent, tool, verdict, or match kind; a pattern of a refused form; a
duplicate rule; more than 200 rules in one level; the release rule's removal (`refused: this rule
is part of the release: agents never pay`).

### Activity records

An `ActivityRecord` is `{key, at, kind: "verdict", agent, tool, verdict, layer, reason, ruleId,
ruleLevel, arguments, cost}`: one per tool call the guard decided, written before the call runs.
`verdict` is `allowed` or `refused`; `layer` is `rule` (or `guard` when the guard itself failed and
refused the call); `arguments` are the call's arguments with secret-looking fields and values
replaced by `[redacted]` and capped at 2 KiB (the fields a rule matched are kept). Records are kept
forever. Later releases add record kinds and fields; a client ignores what it does not know.

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
The VPS release tool calls the snapshot routes; the owner's command line calls the rules and
activity routes. A device key never opens them.

| Method | Path | Does |
| --- | --- | --- |
| POST | `/ops/snapshot?id=<id>[&cells=]` | Each cell dumps to `snapshots/<id>/<cell>.json` in the fleet's bucket. |
| POST | `/ops/restore?id=<id>&cell=<cell>` | Loads that dump into the cell (refuses a later contract step or a digest mismatch). |
| POST | `/ops/wipe?cells=` | Drops every table of the cells (the test cell, after a drill). |
| GET | `/ops/digest?cells=` | Each cell's digest and row count. |
| GET | `/ops/heartbeats?cells=` | Each cell's heartbeat routine state. |
| POST | `/ops/write` | One committed single-row write (the test cell only). |
| GET | `/ops/rules?cell=<person>` | Both levels of that person's rules, as `GET /rules`. |
| POST | `/ops/rules?cell=<person>` | Adds an owner rule for that person's agents (body as `POST /rules`); 201 `{rule}`. |
| DELETE | `/ops/rules?cell=<person>` | Removes an owner rule (body as `DELETE /rules`); the release rule is refused with 400. |
| GET | `/ops/activity?cell=<person>&month=&before=&limit=` | That person's activity, as `GET /activity`. |

`<person>` is `owner` or `second` (`person` also names the second cell). A cell this fleet does not
serve answers 404 `cell <name> is served by another fleet`; a cell that is not a person cell
answers 404.

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
