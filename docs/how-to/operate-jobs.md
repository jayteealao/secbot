# How to work with your jobs

Each section is one task. The commands run on your own machine with your device key; the last
section is the owner's, with the operator key (`SECBOT_OPERATOR_KEY` in your shell, or
`~/.config/secbot/operator.json`). Every printed line is in the [CLI how-to](cli.md), and the
routes are in the [cell API reference](../reference/cell-api.md).

## See your jobs

```
$ secbot jobs
```

Live jobs come first, in the order they run, then the jobs that ended in the last 24 hours. A
line under a row says why a job is not running: it is paused at its cap, it failed the same way
three times, it asks you something, it was stopped, its result was rejected, or it was blocked.
The header counts the results the lead has not read yet. Older jobs are in `secbot activity`.

## Put a job first, give it a deadline, or move it

```
$ secbot jobs urgent 16
$ secbot jobs deadline 16 2026-10-12
$ secbot jobs deadline 16 clear
$ secbot jobs move 16 --before 14
```

Each prints the job's new place, for example `[ urgent ] #16 council tax letter -> now 1st of 4
live jobs`. The lead works in that order from its next request. An ended job cannot be moved.

## Answer a job's question

When a job needs something only you know, the lead asks you in chat and adds a line such as
`[ job 11 asks ] answer with /answer 11 <text>`. In `secbot chat`, answer with:

```
/answer 11 home address
```

The board shows the question under the job (`asks you: "..."  /answer 11 <text>`) until you
answer. The job waits, with no spend, until you do.

## Stop everything

```
$ secbot stop
```

Every running job and the lead's current turn stop now; there is no prompt. Paused, queued, and
waiting jobs stop too. Their state is kept: each job shows `stopped by you at <time>` on the
board. Routines and reminders keep their schedule. Nothing starts while the stop runs.

## Restart one job

```
$ secbot jobs restart 14
```

The job goes on from its kept brief and transcript, with the same number, and its cost keeps
counting. It does not use the restart the lead may use when a job goes wrong. A blocked job can be
restarted the same way; its pages are checked again. A paused job is the lead's to go on with:
ask the lead in chat. You can also ask the lead to resume a stopped job for you.

## Share a job with the other person

Ask your lead for something that is for both of you, for example "plan the May trip for both of
us". The lead proposes a shared job and tells you it asked the other person. The job waits on your
board with `waiting for alex to agree to share the cost` until they answer; on theirs it waits
with `waiting for you to agree to share the cost`. Nothing runs and nothing is spent until they
answer `/join <#>` in their chat (see the command line how-to). If they decline, your lead tells
you. An offer nobody answers keeps waiting, with no spend.

Once they join, the job runs in the household cell and shows on both boards, each with its own
number and a line under the row:

```
15  plan the May trip         routine     cheap/low  0+0  $0.09/.25  running
      shared with alex; you pay half
```

When it is done, your lead tells you the result in its own words; the household never talks to
either of you directly.

### Who pays

Each of you pays half of a shared job's cost, booked on your own month as it runs. When one
person's monthly limit is reached, the other pays all, and the line under the row says so
(`you pay all` or `alex pays all`). While both limits are reached, the job waits on both boards
with `over your monthly limit; waits for the owner or <date>` and spends nothing until the owner
raises a limit or the month resets.

### Stop or restart a shared job

Either person's `secbot stop` stops a shared job too: it shows `stopped` on both boards with its
state kept, and the other person's own jobs are not touched. Either person restarts it by number
with `secbot jobs restart <#>`, using the number on their own board; it goes on in the household
from its kept brief and transcript.

## Stop every cell of the household (owner)

```
$ secbot stop --all
```

With the operator key, this stops every person's jobs and lead turn, and the household's shared
jobs, in both fleets, and lists each cell with what stopped. If a fleet does not answer, stderr
names its cells and the command exits 1; run it again, which is safe. Each job stopped this way
says it was stopped by the owner, and the person restarts it with `secbot jobs restart`.

A shared job is counted once, on the household line (`household 1 shared job`); each person's
line counts only their own jobs.

To read a person's board, use `secbot jobs --person <name>`; for the shared jobs, `secbot jobs
--household`.

## Read the capacity line and the owner's alert

When more jobs run at once in a cell than it was measured to handle, `secbot jobs` shows one line
above the columns:

```
[ 3 jobs at once; this cell was measured at 2 on 29 Oct ] nothing is held back
```

At the same moment the owner gets one Better Stack alert, `Secbot <person> cell: 3 jobs at once,
measured at 2`. It is a warning only: every job keeps running, and no job waits for a slot. If the
cell runs short of memory, celld restarts it and its jobs resume from their kept state. More jobs
in the same busy stretch send nothing more; once the count is back at or under the number, a later
stretch alerts again, at most once a day. When the line shows often, stop or move work with
`secbot stop` and `secbot jobs restart <#>`, or measure the cell again.

## Set or clear a cell's measured number (owner)

A cell uses the release's measured number unless it has its own. With the operator key, set a
person cell's own number (the jobs at once and the day it was measured, in milliseconds since
1970) or clear it:

```
$ curl -X PUT "$SECBOT_CELL_URL/ops/capacity?cell=owner" \
    -H "x-secbot-operator: $SECBOT_OPERATOR_KEY" -H "content-type: application/json" \
    -d '{"measured": 6, "at": 1793232000000}'
$ curl -X PUT "$SECBOT_CELL_URL/ops/capacity?cell=owner" \
    -H "x-secbot-operator: $SECBOT_OPERATOR_KEY" -H "content-type: application/json" \
    -d '{"measured": null, "at": null}'
```

The answer is `{person, measured, at}`. The household and secrets cells have no number.
