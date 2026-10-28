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

## Stop every cell of the household (owner)

```
$ secbot stop --all
```

With the operator key, this stops every person's jobs and lead turn, and the household's shared
jobs, in both fleets, and lists each cell with what stopped. If a fleet does not answer, stderr
names its cells and the command exits 1; run it again, which is safe. Each job stopped this way
says it was stopped by the owner, and the person restarts it with `secbot jobs restart`.

To read a person's board, use `secbot jobs --person <name>`; for the shared jobs, `secbot jobs
--household`.
