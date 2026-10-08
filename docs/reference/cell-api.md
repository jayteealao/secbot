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
| GET | `/missed` | none | `{held: [HeldCall], notices: [LimitNotice], waiting: [Waiting], messages: [{kind: "answer", entryId, text} \| {kind: "followup", entryId, from, text}], remaining}`; `held` lists every call waiting for an answer, oldest first; `notices` the limit notices this device has not seen (shown once per device, here or in a session), with `waiting` beside them; `messages` are the oldest 100 after this device's cursor, which moves past them only | 200 |
| GET | `/cost` | none | `CostView`: the person's month of spend (below) | 200 |
| GET | `/models` | none | `{roles: [{role, model, source}]}`: the lead, each specialist, then the guard's `reviewer` (default `anthropic/claude-sonnet-5.5`) | 200 |
| PUT | `/models/{role}` | `{"model": "<id>"}` (at most 16 KiB) | the role's new model | 200, 400 (unknown role or model, bad body), 413 |
| POST | `/specialists` | `{"name", "instruction", "model"?}` (at most 16 KiB; instruction at most 4000 characters) | `{name, status: "added"}` | 201, 400, 413 |
| GET | `/session` | WebSocket upgrade | the frame stream below | 101, 501 (no WebSocket support) |
| GET | `/rules` | none | `{owner: [Rule], person: [Rule], timeZone}`: the owner's rules (read only here) and the person's own rules | 200 |
| POST | `/rules` | one rule without an id: `{agent, tool, verdict, match?}` (at most 16 KiB) | `{rule: Rule}` | 201, 400 (`refused: …`), 413 |
| DELETE | `/rules` | the rule's `{agent, tool, match?}` as it was added | `{removed: Rule}` | 200, 400 (`refused: …`), 404 (no such rule), 413 |
| GET | `/activity?month=YYYY-MM&before=<n>&limit=<1-200>` | none; `month` defaults to the current month in the cell's time zone, `limit` to 50 | `{person, month, timeZone, total, records: [ActivityRecord], next, spentUsd, live: [ActivityRecord]}`, newest first; pass `next` as `before` for the next older page (`null` when none is left); `spentUsd` is the person's spend in the month; `live` holds the jobs running or waiting now (first page of the current month only, otherwise empty) | 200, 400 (a bad parameter) |
| GET | `/approvals` | none | `{held: [HeldCall]}`: the calls waiting for an answer, oldest first | 200 |
| POST | `/approvals/{n}` | `{"answer": "allow" \| "always" \| "deny"}` (at most 16 KiB) | `{number, status, answer, agent, tool, summary, answeredBy, rule}` (`rule` is the person rule allow always added, or `null`) | 200, 400 (a bad body, or `refused: …`), 404 (`no held call #n`), 409 (`{"error": "lapsed"}` or `{"error": "answered"}`), 413 |

### Spend and limits

A person cell counts its month-to-date spend from its own model ledger: every model response
(failed attempts included) of the lead and each specialist, plus the guard's decision-model and
reviewer calls, which the guard adds under the tool keys `secbot-guard:decision` and
`secbot-guard:reviewer` of the calling conversation's `pi.usage`, in the commit that records its
verdict. A month runs from local midnight on the first, in the household time zone, to the next
first. The developer specialist's spend counts against the household developer budget (50 dollars
by default, summed across every person cell); everything else counts against the person's monthly
limit (25 dollars by default). Only the owner changes either, through the operator routes.

A `CostView` is `{person, month, timeZone, resetsAt, mode, modeSince, spentUsd, limitUsd, percent,
line, byLayer: {agent, decision, reviewer}, byRole, hours, waiting: [Waiting], developer: {spentUsd,
limitUsd, percent, line}}`. `line` is `normal`, `warn` (80% or more of the limit), or `over` (100%
or more); `percent` is rounded to a whole number; `hours` is spend by local hour (`"0"` to `"23"`)
and role; `resetsAt` is the next month's start (milliseconds since 1970).

Above the person's limit, hand-offs, routines, and reminders wait, and a specialist's running job
waits before its next model request; chat with the lead and its own calls continue. Above the
developer budget, the developer's jobs wait. Nothing is dropped: a waiting task continues when the
owner raises the limit or the month resets, also after a restart. A `Waiting` is `{what, since,
budget}`, for example `{"what": "routine morning check", "since": 1791489066251, "budget":
"person"}`.

A `LimitNotice` is `{seq, at, month, zone, budget, line, spentUsd, limitUsd, resetsAt}`: `budget`
`person` or `developer`, `line` 80 or 100. Each line of each budget is noticed once per month and
limit value; a change that passes both lines at once notices only 100. Each notice also sends the
owner one alert, with no amount and no private detail, and logs `limit.crossed` with `cell`,
`budget`, `line`, `spend_usd`, `limit_usd`, and `alerted`.

### Held calls

A call that an ask-first rule matches waits for the person instead of running. A `HeldCall` is
`{number, requestId, agent, tool, summary, arguments, reason, reasonSource, always, heldAt,
expiresAt, remainingMs, status}`:

- `number`: grows per cell and is never reused, so `/allow 1` and the app name the same call, and a
  late answer reaches the call it names.
- `requestId`: the request the answer is bound to: `<conversation id>:<tool call id>` for a model's
  tool call. An answer applies to that request id with the same arguments (compared after the same
  normalization as rules); a retry under the same request id is not asked again, and other
  arguments are held again.
- `arguments`: redacted as in activity records; the fields the rule matched are kept whole.
- `reason` and `reasonSource`: why the call waits, and where that came from: `your-rule` or
  `owner-rule` (the rule in its command-line form), `reviewer` (`reviewer: <the reviewer's
  reason>`), or `reviewer-unavailable` (`reviewer unavailable`: the reviewer failed or timed out,
  so the person decides).
- `always`: `{offered, rule, note}`. Allow always adds `rule`, a person permit rule for the agent,
  the tool, and an exact match on the matched field (or the tool's key field). It is not offered
  when the rules with that rule added would still ask first, for example under an owner ask-first
  rule; `note` then says why, for example `allow always is not offered: an owner rule asks first
  here`.
- `heldAt`, `expiresAt`: milliseconds since 1970 by the cell's clock; `remainingMs` is what is left
  when the answer was made. A call lapses 24 hours after it was held: the agent gets the refusal
  `this request lapsed; nobody answered in 24 h`, and a later answer is refused with 409.
- `status`: `pending`, `allowed`, `always`, `denied`, or `lapsed`.

An answer is applied once: allow runs the call once (a second call cannot use the same allow-once
answer: `this approval was already used`), deny gives the agent `denied by <person>`, and an
answer never lets a call run that a rule now prohibits. A held call survives a restart; it is not
asked again after one. While the lead waits on its own held call, chat lines are accepted and
queued for it; specialists, routines, and reminders keep running.

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

An `ActivityRecord` is `{key, at, kind, number?, agent, tool, verdict, layer, reason, ruleId,
ruleLevel, arguments, cost, mode?, decision?, fallback?}`, written before the call runs:

- `kind: "verdict"`: the guard decided a call. `verdict` is `allowed` or `refused`, or in shadow
  mode `would block` or `would ask` (the call ran); `layer` is `rule`, `decision` (the decision
  model passed a call no rule matched), `reviewer`, `person` (a later call under an earlier
  answer), or `guard` (the guard itself failed and refused the call).
- `kind: "held"`: a call waits for the person; `verdict` `held`, `layer` `rule` or `reviewer`,
  `number` the held call's number.
- `kind: "mode"`: the owner switched the cell's guard mode; `verdict` `switched`, `layer` `guard`,
  `agent` who switched, `tool` `mode`, `reason` `mode: shadow -> enforce`.
- `kind: "answered"`: the person answered; `verdict` `allowed` or `denied`, `layer` `person`,
  `reason` `allowed once by <person>`, `allowed always by <person>`, or `denied by <person>`.
- `kind: "lapsed"`: nobody answered in 24 hours (`no answer in 24 h; refused`) or the agent's job
  was aborted (`the agent's job was aborted; refused`); `verdict` `lapsed`, `layer` `person`.
- `kind: "job"`: a hand-off or a routine run (each reminder included); `layer` `job`, `verdict`
  its state, `tool` its label (`job: <first words of the brief>`, `reminder: <text>`,
  `routine: <name>`), `agent` the specialist (a hand-off) or `lead` (a routine), `cost` its cost.
  A job is stored once, as `done`, in the commit that ends it (key `job:<task id>`), with `reason`
  `answered the lead`, `failed: <why>`, `no answer`, `stopped`, or `delivered to the lead`. While
  it runs or waits it is listed in `live` instead (key `live:<task id>`): `running` with `step 1
  of 2: <specialist> is working` or `step 2 of 2: reporting to the lead`, or `waiting` with
  `waits above your limit since HH:MM` (`... the developer budget ...`) or `due <d Mon HH:MM>`.
  A routine that spends nothing (the heartbeat) is not listed.

`arguments` are the call's arguments with secret-looking fields and values replaced by
`[redacted]` and capped at 2 KiB (the fields a rule matched are kept). Records are kept forever.
Later releases add record kinds and fields; a client ignores what it does not know.

A job's cost: a hand-off costs the specialist conversation's ledger growth since the later of the
job's start and the end of that specialist's previous job, so one specialist's job costs add up
to its spend (the guard cost of the specialist's own calls included, which also shows on those
calls' rows). A routine run costs `0`: it only sends a message to the lead, whose answer is chat
spend. A running job's `cost` is its cost so far.

`spentUsd`: for the month the spending ledger is in, the month to date (the same number as the
usage line and `GET /cost`); for an ended month, the total the ledger kept when that month ended;
for a month with neither (before this release, or a month that differs because activity months
use the cell's time zone and the ledger the household time zone), the sum of the month's stored
records' `cost`.

The model layers' fields:

- `mode`: `shadow` or `enforce`, the cell's guard mode when the guard decided (on every record
  this release writes).
- `decision`: `{outcome, score, model}` when the call reached the decision model: `outcome` is
  `pass`, `mark` (sent to the reviewer), or `fallback` (no answer); `score` is the probability of
  "risky" plus "unclear" (0 to 1, `null` on a fallback); `model` is the id the service returned.
- `fallback`: why the decision model gave no answer (`http-<status>`, `malformed`, `timeout`,
  `unknown-choice`, `no-key`), or `null`.
- `cost`: the decision model's and the reviewer's cost for this call, in USD.

In shadow mode a reviewer's reason reads `shadow: <reason>; the call ran` (or `shadow: reviewer
unavailable; the call ran`). In enforce mode it reads `reviewer: <reason>`.

### The guard's layers and the mode

Every tool call passes the rules first. A prohibit refuses it and an ask-first rule holds it before
any model sees it. A call the rules pass goes to the decision model (Clef by default, or Jev, on
OpenRouter's Decisions API), which can only pass it or mark it; a mark, or any decision-model
failure (an HTTP error, a malformed body, a timeout over 1.5 s, an unknown answer, no key), sends
it to the reviewer. The reviewer allows it, blocks it (`reviewer: <reason>`), or asks the person
(a held call). A reviewer that fails or takes over 30 s holds the call (`reviewer unavailable`).

Every cell starts in shadow mode: the decision model and the reviewer run and the record says what
they would have done, but the call runs. Rules, ask-first holds, and approvals enforce in both
modes. The owner switches a cell to enforce with `PUT /ops/mode`.

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
| `held` | `call` (a `HeldCall`), `count` | A call waiting for the person: every waiting call right after `connected`, oldest first, and each new one once when it is held. `count` is how many calls wait. The client answers through `POST /approvals/{n}`; a chat line is never an answer. |
| `usage` | `usage`: `{month, zone, resetsAt, spentUsd, limitUsd, percent, line, mode}` | The person's month against their limit and the guard mode: right after `connected`, and after each `answer`. |
| `notice` | `notice` (a `LimitNotice`), `waiting` (`[Waiting]`) | A limit line reached: once when it is recorded, and at connect for each notice this device has not seen. A device that took it does not see it again in `GET /missed`. |

Ordering and reconnects: `connected`, then `usage`, then a `held` frame for every waiting call,
then a `notice` frame for every notice this device has not seen, then every `missed` frame, then
live frames. An input with no `accepted` or `rejected` frame is resent on the
next connection under the same `requestId`.

## Host routes

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| GET | `/health?cells=` | none (reachable from the host only) | `{version, cells: {<cell>: {status, version?, roles?, reason?}}}` |
| GET | `/alarms?cells=` | none (reachable from the host only) | `{version, cells: {<cell>: <alarm report>}}` |

## Operator routes: `/ops/…`

Auth: the operator key in `x-secbot-operator`; any other request is `401` and logs `ops.refused`.
The VPS release tool calls the snapshot routes; the owner's command line calls the rules,
activity, and mode routes. A device key never opens them, and no device-key route changes the
mode.

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
| GET | `/ops/mode?cell=<person>` | `{person, mode, since, switchedBy, decisionModel, timeZone}`: the guard mode (`shadow` or `enforce`), when it began (milliseconds since 1970), who switched it, and the decision model (`clef` or `jev`). |
| PUT | `/ops/mode?cell=<person>` | Body `{"mode": "shadow" \| "enforce"}`; the same shape plus `changed` (false when the cell already had that mode). Logs `guard.mode` and writes one `mode` activity record per switch. 400 for any other mode. |
| PUT | `/ops/decision-model?cell=<person>` | Body `{"adapter": "clef" \| "jev"}`; the same shape as `GET /ops/mode`. The next call uses it. 400 for any other adapter. |
| GET | `/ops/cost?cell=<person>` | That person's `CostView` plus `asOf`: live for a cell this fleet serves, else the household board's last report of it (`resetsAt` 0, `hours` empty). 404 when nothing is known. |
| GET | `/ops/cost` | The household: `{month, timeZone, totalUsd, persons: [{person, spentUsd, limitUsd, percent, line, mode, modeSince, asOf}], developer: {spentUsd, limitUsd, percent, line}}`. This fleet's cells answer live; another fleet's from the board. |
| PUT | `/ops/limits?cell=<person>` | Body `{"limitUsd": <usd>}` (above 0, at most 10000, two decimals); `{person, limitUsd, previousUsd}`. The next check uses it; waiting work continues at once when it is now under. Logs `limit.set` and `ops.limits`. 400 for a bad amount. |
| PUT | `/ops/limits?budget=developer` | Body `{"limitUsd": <usd>}`; `{timeZone, developerLimitUsd}`. A household setting: every person cell reads it again. 400 for a bad amount, 503 without a household cell. |
| PUT | `/ops/time-zone` | Body `{"timeZone": "<IANA zone>"}`; `{timeZone, developerLimitUsd}`. Months follow it from the next month in each cell. 400 for a zone the runtime does not know. |

`<person>` is `owner` or `second` (`person` also names the second cell). A cell this fleet does not
serve answers 404 `cell <name> is served by another fleet`; a cell that is not a person cell
answers 404. No device-key route changes a limit, the developer budget, or the time zone.

## Household routes: `/internal/household/…`

Auth: the operator key. A person cell in another fleet calls these to reach the household cell.

| Method | Path | Request | Response | Statuses |
| --- | --- | --- | --- | --- |
| POST | `/internal/household/read` | `{"document": "<name>"}` | the document | 200, 400 (`send {document}`), 401, 404 (served by another fleet), 503 (no binding) |
| POST | `/internal/household/apply` | a change with an operation id | the result; the same operation id applies once | 200, 400 (a refused change), 401, 500 |
| GET | `/internal/household/status` | none | the household cell's version and roles | 200 |
| POST | `/internal/household/budget` | `{}` | the budget board: `{settings: {timeZone, developerLimitUsd}, reports: [SpendReport], developerUsd}` (each cell's newest report of the newest month) | 200, 401 |
| POST | `/internal/household/report-spend` | a `SpendReport` with an operation id | `{board, othersDeveloperUsd, alerts: [{line, status}]}`; `status` is `yours` (this cell sends that developer alert), `taken` (another cell claimed it in the last 20 s), or `sent`; the same operation id applies once | 200, 400, 401 |
| POST | `/internal/household/set-budget` | `{timeZone?, developerLimitUsd?}` | the new settings | 200, 400 (an unknown zone or a bad amount), 401 |
| POST | `/internal/household/alert-sent` | `{month, budget: "developer", limitUsd, line, cell, sent}` | `{ok: true}`; `sent: false` frees the claim so the alert goes again | 200, 400, 401 |

A `SpendReport` is `{opId, cell, month, timeZone, at, spentUsd, limitUsd, mode, modeSince,
byLayer, byRole, developerUsd, developerLimitUsd, developerLines}`. Person cells report after their
spend changes (at most every 5 seconds, at once when a line is reached). The board is a report of
each cell's own ledger: a person's limit is decided in that person's cell only.

A failed call is logged on both sides: `household.call` with `outcome: "refused" | "failed"`,
`status`, and the error on the caller; `household.refused` or `household.error` on the household
fleet.
