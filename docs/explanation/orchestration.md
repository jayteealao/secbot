# How the lead runs jobs

This page explains how a person's lead hands work to other agents, and why it is built this way.
It is for the maintainer. For the commands, see [How to use the secbot command line](../how-to/cli.md);
for the routes, see [the cell API](../reference/cell-api.md).

## Jobs instead of specialists

Each person's lead is one endless root conversation. When a task needs more than a short answer,
the lead starts a job with `start_job`: a title, a brief it writes itself, a template, and
optionally a tier, an effort, a priority, and a deadline. Nothing else routes work; no keyword,
flag, or code rule picks an agent.

A job is a pi-durable task that owns a fresh conversation, created in the same commit as the
task. The conversation gets the template's instructions, the job tool list, and the model of the
job's tier; the brief is its first message. Because the task owns the conversation, the job's
transcript, its cost ledger, and its life end together: stopping the task stops the job's model
call, and a restart resumes the task where its last commit left it.

Before jobs, each person had four long-lived specialist conversations, and every hand-off to a
specialist added to that one conversation. Its context grew with every unrelated task, two
tasks for the same specialist could not run at once, and a slow task held up the next one. A
fresh conversation per job keeps each brief's context to the brief, lets any number of jobs run
together, and gives each job its own cost.

## Templates and tiers

A template is a job's role: its instructions and the tier it starts on. The release has four:
household (cheap), research (mid), health (mid), and developer (frontier). The owner can add more
with `secbot specialist add`; an added template starts on the cheap tier.

A tier names a model and a per-job cap: cheap, mid, and frontier. The owner maps each tier to a
model with `secbot model set <tier> <model-id>` and changes its cap with `secbot model cap`. The
lead picks the tier per job, and can move a running job to another tier or effort with `set_job`;
a template never names a model, so a model change reaches every template at once. A running job
keeps the model it started with; the next job on the tier, and a job moved onto it, use the new
one.

The effort a job asks for is clamped to what its model supports, and the board shows both the
requested and the applied effort, so the lead sees when a model cannot think harder.

## The board

The `secbot.job-board` document holds one row per job: its number, title, brief, priority,
deadline, template, tier, effort, attempts, cost against its cap, status, owner, conversation,
task, the lead turn that started it, and its result. Rows are written in the same commits as the
work they describe, so the board survives a compaction of the lead and a crash without a
separate recovery step.

A job's spend counts like any other: its conversation's ledger is in the person's month (a
developer job's in the developer budget), person and owner rules on an agent name apply to the
jobs of that template, and the cell watches each live job's usage only until the job ends.

## The inbox and wake notices

A job's result does not enter the lead's conversation by itself. It waits on the board until the
lead pulls it with `job_result`, so a result never interrupts the person's conversation, and the
lead checks it against the brief before telling the person.

The lead learns what waits from its jobs section, which every request rebuilds: each live job's
line, and how many results and receipts wait. A result that needs the lead soon (a failure, a
question, a risky mark) wakes it with one short notice, `[job <n> <kind>: pull it with
job_result]`. A routine result wakes it only if nobody pulled it for 30 minutes. A notice carries
no result text.

## When a job goes wrong: the lead decides, code bounds

A job can stop making progress in two ways the cell watches for. It can reach its cost cap: the
job's cost counts every conversation it used (each run's and its review's), and it pauses before a
step that would pass the cap. Or it can fail the same step three times in a row: the same tool
with near-identical arguments, each answer an error. Steps that succeed, steps with different
arguments, and errors from before the job was last resumed are not counted. An empty or cut-off
reply does not end a job; it gets one nudge to continue.

A paused job waits with no model request and no spend, for as long as it takes, across restarts
of the cell, and the lead gets one notice, `[job <n> paused: ...; choose set_job or restart_job]`.
The lead chooses what happens next; code only bounds it. Each job gets one raise and one restart:

- A raise is `set_job` with a higher tier or effort. A paused job runs again on it, unless it is
  still over the new cap.
- A restart is `restart_job` with a failure note the lead writes after reading the job's
  transcript (`job_transcript`). A fresh subagent starts on the same job number with the note
  and the brief, and can search the earlier attempt with `search_old_job`. The job's cost keeps
  counting across the restart, so a restart is not a way around the cap.

A third move is refused and ends the job failed, with a question to the person about what should
happen next. The lead asks them in its own words; their answer goes to the lead.

## Blocked jobs

A job whose content check finds an order in what it read, or cannot finish the check, is
blocked: its run stops, nothing from that read is kept, and its result is a failure that says
why, such as "a page tried to give the agent orders; nothing from it was used". The lead gets one
notice, `[job <n> blocked: <reason>; read it with job_result]`, and its jobs section lists each
blocked job with its reason until the lead pulls the result. A blocked job is ended, like a
failed one.

The lead tells the person in its own words. It restarts a blocked job only when the person asks:
the content that stopped it was written by someone outside the household, and the person decides
whether that source is worth another try. A restart is `restart_job` as for any job, and counts
as the job's one restart. The new run reads the content again and the check runs again. The job
keeps its mark for having read outside content, so its outside actions still go to the reviewer.

## Risky results and the reviewer

A result is risky when its job used a tool that acts (`household_change`), spends
(`broker_call`), or touches money (`secret_get`), or ran on the health template. The lead can add
a mark with `mark_risky`, never remove one. Before the lead can pull a risky result, a reviewer
subagent with no tools checks it against the brief and returns one verdict, pass or reject, with
a reason. The result is shown to it inside an untrusted block it is told not to follow.

The reviewer runs on a model the job never ran on: the reviewer role's model, unless the job used
it; then the frontier tier's, the mid tier's, or the cheap tier's, the first the job did not use.
A model that agrees with itself is not a second opinion. A rejected result is never shown to the
lead: `job_result` gives the reviewer's reason, and the lead can run the job again with its one
restart and a failure note. A raise is refused on a rejected job, because its run has ended and a
new tier would change nothing. A routine result is not reviewed.

## Questions and requests

A job that needs a fact the brief left out asks the lead with `ask_lead` and waits, with no spend,
until it is answered. The lead answers from what it knows with `answer_job`, or hands the question
to the person with `ask_person` when it lacks the answer or the answer commits the person; it then
asks in its own words, and the chat adds `[ job <n> asks ]`. The person answers with
`/answer <n> <text>`, which goes to the job through the cell, never through the lead. A question
has no time limit.

A job never starts other agents. When it needs more work than it can do, it asks with
`request_job`: a row is added to the lead's board, and only the lead can start it, with
`start_job` and the row's number. A job may have at most three such rows waiting to start, and
the board at most ten, with a brief of up to 8,000 characters; past that the request is refused
and the job goes on with its own work.

## Tools that answer in their round

Every tool on the lead's list returns in the round that called it, so the lead is never blocked
while another cell answers. The tools that call another cell (the household list and the
secrets cell) answer with a receipt, `receipt r<n>: <tool> runs in the background`, and run in a
receipt task; the lead reads the outcome with `read_result`. A receipt task marks itself started
in its first commit, so a crash during the call is reported as interrupted instead of being sent
twice where that would not be safe.

## The person comes first

A person's line while the lead is busy steers the lead's turn: the lead answers it before it
does anything else, including pulling a result. The cell records a bookmark of the interrupted
turn (its number, the jobs and receipts it had open, and an optional note the lead writes with
`note_bookmark`), and shows it in the lead's next requests until the lead calls `resume_work`.
Lines from other sources, such as another cell, wait for the turn to end instead.

## The stop

`secbot stop` (and the owner's `secbot stop --all`) stops work, not the cell. In one commit the
cell sets a stop lock and marks every unfinished job that has a running task: running, queued,
paused, and waiting jobs alike. It then aborts each marked task and the lead's current turn, and
waits for the tasks to end. A job ends `stopped` with who stopped it and when; its brief, board
entry, transcript, and cost are kept. A job whose task ended some other way during the stop keeps
that end.

Routines, reminders, and reviews are not touched: the lead's turn is aborted without stopping its
background work, so a reminder still fires at its time. While the lock is set, no job starts,
restarts, or resumes, and the lead's tool answers say a stop is running. A stop that finds a
marked task still running after the aborts logs a warning naming how many.

## Resume by fork

A stopped or blocked job restarts one way: from where it was. The cell forks the job's last run,
so the new run's transcript holds every message of the stopped one, then adds one line telling the
agent when it was stopped and that it is resumed now. The job keeps its number, brief, tier, and
board entry, and its cost keeps counting across both runs. This is not the job's own restart (a
fresh subagent the lead may use once when a job goes wrong), so the person's restart never uses
it up. The person restarts a job with `secbot jobs restart`; the lead does it with `resume_job`
only when the person asks. A blocked job's content is checked again when it reads it again.

## Queue order

The board keeps live jobs in a queue. A new job takes its place by priority (urgent first, then
deadlines by date, then routine, then research), after the jobs already there with the same
priority. The person can move a job: `urgent` puts it first, a deadline or none places it again by
priority, and `move` puts it right before another job. The lead's jobs section lists live jobs in
that order with their priority words, so the lead sees the person's order in its next request.

## The hand-off note

Before older messages of the lead's conversation are summarized, the lead's model writes a short
note for itself from those messages and its previous note: open promises, pending questions, and
the person's recent preferences. The note is committed once per compaction, shown in the lead's
prompt after it (and after a restart), and its call is the lead's spend. Job state is never in
the note: it is on the board. A failed note call keeps the previous note and never stops the
compaction.

## Shared household jobs

Some work belongs to both people: planning a trip, sorting the shopping. Such a job runs once, in
the household cell, and shows on both people's boards; each person's lead stays the only agent
that talks to its person.

**The household agent.** The household cell runs its own agent for shared jobs, on the fleet's own
model key, like the person cells beside it. It never talks to a person and has no lead: it runs
each shared job in a fresh subagent with two tools only, `household_read` and `household_change`,
and no tool call ever waits for a person. A job that changed a household document is marked risky,
so a reviewer on a different model checks its result before either lead may use it.

**Consent.** The requesting person's lead proposes the job; the other person's lead gives them the
offer in its own words, and the chat adds the line with the job's number. Only the other person's
`/join` starts the job; a `/decline` ends it, and the requesting lead hears it as a failure. Until
they answer, nothing runs and nothing is spent: the job waits on both boards, however long it
takes. When the other person's limit is reached, their lead still gives the offer, because the
requesting person would pay all of it.

**The pull exchange.** The household never calls a person cell. Each person cell pulls one
exchange, `shared-sync`: it sends its queued operations (a proposal, an answer, a restart, a
resume, a stop) and gets back every shared job it is part of, which it mirrors onto its own
board. Each operation has an id, and the household applies an id once, so an exchange whose answer
was lost is simply sent again. A person cell exchanges every 2 minutes, at once after a shared
action, and before it shows the board. A notice the lead must hear (a joined job, a result) is
committed with the exchange and goes to the lead as a follow-up; while the person's limit is
reached, it waits for the limit without holding up later exchanges.

**Who pays.** The household settles each joined job's new cost at every exchange and splits it
into charges per person: half each; when one person's monthly limit is reached, the other pays
all; while both are reached, the job waits and spends nothing until a limit is raised or the month
resets. Each person cell books its own charges once on its own month, where its limit and its cost
view count them under `household`. The cost the other person agrees to is the job's tier cap, the
most the job can spend, so their half of the real cost never passes the half they were shown.

**Escalation.** A shared job keeps the tier and the estimate the other person agreed to, so no
lead may raise it. Only the requesting person's lead may restart it, once, with a failure note;
after that, the lead asks its person, who can start a new shared job at a higher tier.

**Stop.** Either person's `secbot stop` stops a shared job, because it spends that person's money.
It shows `stopped` on both boards with its state kept; the other person's own jobs keep running.
The owner's `secbot stop --all` reaches the household cell itself, which stops the job and counts
it once, on the household's line.

**Restart.** Either person restarts a stopped shared job by the number on their own board. The
restart goes to the household as an operation, never as a job on that person's own model and
budget, and the household resumes the job from its kept brief and transcript, as any resume does.

## Capacity: a warning, not a limit

A cell has no job slots. The owner chose that the person's work is never queued behind a number:
the lead starts every job it decides to start, and a cell that runs out of memory is restarted by
celld while its jobs resume from their kept state. What a cell can carry is still worth knowing,
so each cell has a measured number of jobs at once. Passing it shows the capacity line on the board
and sends the owner one alert for that busy stretch; it never holds a job back.

The number is measured on the test cell's capacity bench, a cell of its own with a scripted lead,
so only the jobs' own model calls cost money. Each level starts that many live jobs at once, each
holding on a slow lookup so that they run together, while the host reads celld's heap every
second. A level passes when every job answers, the bench does not restart, and the peak heap of
one isolate stays under its limit; the receipt and job times are recorded with it. Levels stop at
the first failure, and the measured number is the last level that passed before it. Heap per job
is the test fleet's peak heap less its idle median, divided by the jobs, because celld reports one
heap per Worker script rather than per cell.

A later release measures again when the benchmark trips: more than 25 % more memory per job, or
10 % more latency at a level, than the last measurement. Until then the release's number stands,
and the owner can give one cell its own number, or clear it, with the operator key.

## Frozen specialists

A cell opened before jobs keeps its four specialist conversations. No tool reaches them, and the
lead's history still holds every answer they relayed, so `search_history` finds old work. An
owner-added specialist becomes a custom template on the cheap tier the first time the cell
opens with jobs. Rules and history that name the retired `handoff` tool still read.
