# How to guard your agents

Use this guide to control what your lead and your specialists can do, to answer a call that waits
for you, and to read what your agents did and what it cost. Each section is one task.

This guide assumes that:

- your device is registered and `secbot chat` connects to your cell (see the
  [CLI how-to](cli.md#register-this-device));
- you use your own device key. The owner's limits, modes, and secrets commands are in
  [How to operate the guard and the secrets cell](operate-guard.md).

## Read your rules

```
$ secbot rules list
```

The list shows the owner's rules first, under `OWNER RULES (you cannot loosen these)`, then your
own rules, under `YOUR RULES`. Each line names the agent, the tool, the argument match, and the
verdict:

- `permit`: the call goes on to the guard's model checks.
- `ask first`: the call waits for your answer.
- `prohibit`: the guard refuses the call before it runs.

You cannot remove or loosen an owner rule. Every cell has three owner rules from the release:
agents never pay, a reminder that holds a card number asks first, and a history search that names
a password, passcode, PIN, token, or API key asks first.

## Add or remove a rule

1. Add a rule. Give the agent, the tool, the verdict, and an optional match:

   ```
   $ secbot rules add lead handoff ask-first --exact specialist=research
   ```

   The agent is `all`, `lead`, or a specialist's name. The tool is a tool name, `pay` (every pay
   tool), or `*` (any tool). The verdict is `permit`, `ask-first`, or `prohibit`. The match is
   one of `--exact`, `--prefix`, `--email-domain`, `--web-domain`, or `--regex`, followed by
   `<argument>=<value>`.
2. Read the result. The command prints `added:` and the rule. When the rule is looser than an
   owner rule, the command prints that owner rule on stderr and exits with 1. Nothing changes.
3. To remove a rule, give the same agent, tool, and match that you added:

   ```
   $ secbot rules remove lead handoff --exact specialist=research
   ```

Inside your own rules, the most specific rule decides. Between the owner's rules and your rules,
the stricter rule decides.

## Answer a held call

When an ask-first rule matches, when the guard's reviewer asks you, or when the reviewer does not
answer, the call waits. In `secbot chat` the held call prints between the lead's lines, with a
number, the agent, the tool, the arguments (secret-looking values show as `[redacted]`), the
reason, and the time left before it lapses.

1. Read the `why held` line. It names your rule, an owner rule, the reviewer's reason, or
   `reviewer unavailable`.
2. Type one answer, with the call's number:
   - `/allow 1` runs the call once.
   - `/always 1` runs the call and adds the permit rule that the prompt shows. When an owner rule
     or the reviewer held the call, the prompt does not offer it and gives the reason in one
     line.
   - `/deny 1` refuses the call. The agent gets `denied by <you>`.
3. Make sure that the answer is exact. A line such as `/allow one` is not sent, and the command
   prints `not sent: answer with /allow N, /always N, or /deny N`.

When no session is open, the call waits. `secbot missed` lists it first under `HELD CALLS`, and
the next `secbot chat` shows it before other messages. A call with no answer in 24 hours lapses as
a refusal.

## Read your spend and your limit

`secbot chat` prints your month's spend against your limit when it connects and after each
answer:

```
[ month: $20.40 / $25.00 ] [########..] 82% [ 80% of limit ] [ shadow ]
```

For the spend by layer (agent model, reviewer, decision model) and by role, run:

```
$ secbot cost
```

At 80% and at 100% of your limit you get one notice, in `secbot chat` or in `secbot missed`.

## Know what happens above your limit

Above your limit, chat with the lead continues. Hand-offs, routines, and reminders wait. A
specialist's running job finishes its current step, then waits. Nothing is dropped: the work
continues when the owner raises your limit or when the month resets. The month resets at local
midnight on the first, in the household time zone.

The developer specialist counts against the household developer budget, not your limit. Above
that budget, developer jobs wait in the same way, and your other work continues.

Only the owner can change a limit or the developer budget. When you need more, ask the owner.

## Read your activity

```
$ secbot activity
$ secbot activity --month 2026-09 --page 2
```

The list shows the current month, newest first, 50 rows to a page. Each row shows the time, the
agent, the tool or job, the verdict or state, the layer that decided, and the cost. The line below
each row gives the reason or the job's step. The header total is the same number as the usage line
and `secbot cost`.

While your cell is in shadow mode, a row can read `would block` or `would ask`. That row records
what the reviewer would do in enforce mode; the call ran. Rules and ask-first rules always apply,
in shadow mode too.

## Check the result

- `secbot rules list` shows the rule you added, under your own rules.
- `secbot activity` shows each held call and its answer or its lapse.
- `secbot cost` and the usage line in `secbot chat` show the same month total.

## Related pages

- [CLI how-to](cli.md): every command, the printed lines, and the exit codes.
- [How the guard decides](../explanation/guard.md): the layers, their order, and shadow mode.
- [Cell API reference](../reference/cell-api.md): the routes behind these commands.
