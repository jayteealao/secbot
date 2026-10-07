# The cell runtime

This page explains how Secbot runs its agents on celld, and why it is built this way. It is for
the maintainer. For the tasks, see [How to operate the cells](../how-to/operate-cells.md).

## One harness per person

Each person has one cell: a celld Durable Object that runs one pi-durable harness. The harness
holds the person's lead, one endless root conversation, and four specialists (household,
developer, research, health) as subagent conversations in the same harness. A specialist that
every person has is the same code installed in every person's harness.

One harness per person keeps a person's conversations, timers, and history in one database, so a
restart or a crash resumes everything together. It also keeps privacy simple: no surface reads
another person's cell.

The lead decides when to hand work to a specialist. It calls one hand-off tool and writes the
brief itself; no keyword, flag, or code rule routes a message. The specialist runs in the
background with its own model and instructions, can search the lead's history, and returns its
answer to the lead as a follow-up with a stable request id, so a restart never delivers it twice.

## The household cell

Shared documents, such as the household list, live in a separate household cell. Each person's
cell reads and writes them over RPC. Every change adds, edits, or removes one item and carries an
operation id. The household cell keeps an ordered change log keyed by that id, so a retried call
applies once, two changes to different items both land, and for the same item the later change
wins while both stay in the history.

Whole-document writes were rejected: two people editing at once would lose one person's change.

## The storage adapter

pi-durable stores its state through a storage interface. Secbot's adapter maps it onto the
cell's own SQLite storage (`ctx.storage.sql`). celld runs storage calls synchronously and joins a
call to any open transaction of the same event, so the adapter queues operations: a second
operation waits until the open transaction ends. A transaction that runs past celld's 30-second
limit fails and rolls back; no partial write is visible. The adapter passes pi-durable's storage
conformance suite inside a real celld cell, and each release runs that suite before it deploys.

## The wake-time store and the alarm

A celld cell has one alarm. Each routine (the heartbeat, a reminder) is a pi-durable background
task that writes its next wake time into its durable checkpoint. The cell computes its alarm from
those stored times, never from memory, and sets it to the earliest one. An idle or evicted cell
wakes when the alarm fires, runs every overdue routine once, and sets the alarm to the next
earliest time. A crash loses nothing, because the times are in the database.
`check:alarms` compares each cell's alarm with its earliest stored time.

## The retry policy

Every model call goes through one OpenRouter key, with a model per role stored in the cell and
changed by the CLI. When OpenRouter fails or is slow, the request is kept and retried with a
capped backoff (2 s, doubling to 60 s) and no retry ceiling; the job pauses. After 15 minutes
of failures, Better Stack alerts the owner once and the CLI shows `waiting for the model`. A
credit-limit error is kept and retried the same way, but alerts at once instead of after 15
minutes. No turn ends unanswered because of an outage. A model call cut off by a
crash runs again after the restart; the owner accepted one repeated call.

## Production fleets and staged deploys

celld runs one application per fleet: every node of a fleet loads the same deployment. A staged
rollout needs each stage on its own fleet, so production runs two fleets on the VPS:

- `celld@prod-owner` serves the owner cell;
- `celld@prod-shared` serves the second person's cell and the household cell.

Both share the production bucket by key prefix. A release deploys the owner fleet first, checks
it, then deploys the shared fleet. A rollback redeploys a prior tag to one fleet. The test cell is
one fleet that serves every cell.

The owner cell reaches the household cell in the other fleet over an HTTP route on the private
network, with the operator key and the same operation ids as the RPC path. The test cell uses the
same HTTP route against itself, so the release's integration suite exercises it.

Two other options were rejected. One production fleet would deploy every cell at once and lose the
staged rollout. One bundle that pins each cell to a release would be fragile and would limit a
rollback to one version back.

## Snapshots and restores

celld has no cell export or point-in-time restore, so each cell dumps its own tables inside one
transaction: the schema, every row, the row count, the bundle's contract step, and a SHA-256
digest over the rows. The dump goes to the fleet's bucket (R2, a different company from the VPS).
A restore closes the cell's harness, loads the dump in one transaction, checks the digest, reopens
the harness, and sets the alarm from the restored timers. It refuses a dump from a later contract
step, and it never restores the secrets cell.

Each release snapshots every production cell before it deploys and records the snapshot in the
deploy ledger on the VPS. A monthly drill restores the newest snapshot into the test cell; the
next test-cell deploy wipes it.

## One VPS lock

Deploys, rollbacks, restores, drills, and test-cell runs share one lock on the VPS, so two of them
never change a cell at the same time. A run of several steps holds a lease with an expiry; a
crashed run's lease frees itself.

## Measurements

- **Heap.** celld gives each cell isolate a V8 heap limit (128 MiB by default). `measure:heap`
  runs a lead and four specialists at once plus a long job and reads celld's own memory report.
  If the peak goes over the limit, the limit is raised for every fleet and developer work moves
  into its own cell.
- **Write delay.** On one node, every committed write waits for the bucket round trip.
  `measure:write-delay` records the median and the 95th percentile.
- **Cost.** `measure:cost` turns the cell's `model.call` log (or, before live use, the model
  catalog prices) and the usage assumptions into a monthly cost per person, with the arithmetic.
  The cells' `model.call` lines are kept in the cells' own journal for 90 days, so a logged
  estimate can cover a month.
