# How the guard decides

This page explains how Secbot checks every tool call an agent makes, and why the check is built
this way. It is for the maintainer. For the tasks, see
[How to guard your agents](../how-to/guard-agents.md) and
[How to operate the guard and the secrets cell](../how-to/operate-guard.md).

## Why every call has a guard

Agents get more tools over time: mail, the household computer, developer work, money and health
jobs. A tool that runs with no rule, no approval, no spending limit, and no secret scoping is a
risk from its first call. The guard puts one check in front of every tool call before such tools
arrive. A new tool then lands on a harness that already refuses, asks, limits, and scopes secrets.

The guard is one pi-durable `beforeTool` hook. Every role's conversation selects it, the lead and
each specialist alike, because a hook runs only for a conversation that selects its extension.
The hook replaces the old per-role tool allowlist as the only gate.

## Three layers, one fixed order

The guard has three layers. Each layer is cheaper and more predictable than the layer after it.

1. **The rules.** A deterministic matcher reads the call's normalized arguments and returns
   permit, ask-first, or prohibit. A prohibit refuses the call at once. An ask-first holds the
   call for the person. A permit sends the call on to the models.
2. **The decision model.** One choice question about the redacted call, through OpenRouter's
   Decisions API. The model can pass the call or mark it for review. It cannot refuse or hold a
   call. A per-tool threshold turns the score into a mark: 0.5 for most tools, higher for reads,
   and lower for reminders and history searches.
3. **The reviewer.** A full LLM role in the model map. It reads the redacted call as untrusted
   data, with the rule that matched and the decision model's answer. It can allow, block, or ask
   the person.

The order of verdicts is fixed: an owner prohibit, then a person prohibit, then an ask-first from
any rule, then the reviewer, then the decision model's mark. A later layer can only add a
restriction or clear its own escalation. The reviewer's allow clears only the review that the
decision model asked for. It never clears a prohibit or an ask-first that a rule set.

This order keeps every final verdict on a rule or on a person. A model can make the guard
stricter, but no model owns a rule's outcome. The cost of this choice is that a call the reviewer
judges safe still waits for a person when a rule says ask-first.

## Failures close the gate

Each failure moves the call toward a person, never toward a silent run:

- When the decision model gives no usable answer (an HTTP error, a malformed answer, an unknown
  choice, no key, or a timeout over 1.5 seconds), the call goes to the reviewer.
- When the reviewer fails or takes longer than 30 seconds, the call is held for the person with
  the reason "reviewer unavailable".
- When the guard itself fails, the call does not run.

A decision-model outage could send every call to the paid reviewer. To bound that cost, each cell
sends at most 30 reviewer requests a minute, and stops asking for one minute after five reviewer
failures in a row. A call above that cap is held for the person without a review.

## Approvals that survive a restart

A held call is a durable record in the cell, keyed by the request id and the normalized
arguments, with a 24-hour expiry. The record is committed before the hook waits. A hook that
waits at a crash runs again from the start with the same ids, so its first act is to look up that
record. The person is never asked twice for the same call, and a held call outlives a restart.

An answer binds to the tool and the normalized arguments. When a held call is allowed, the rule
stage runs again before the call runs, so an answer never clears a prohibit. "Allow always" adds
an exact-match permit rule, and it is not offered when an owner rule or the reviewer held the call.

## Shadow mode

Every cell starts in shadow mode. In shadow mode the decision model and the reviewer run, but
their verdicts are recorded as "would mark", "would block", or "would ask", and the call runs.
The rules, the ask-first holds, the limits, and the secret grants always enforce. Shadow mode
never reaches them.

Shadow mode covers only the model layers for a reason. A shadow switch over the whole hook would
also stop the rules, and a cell left in shadow would then have no guard at all. The trade-off is
that, in shadow mode, a risky call that a rule permits runs without model review. The owner reads
a week of shadow verdicts, including the false marks and their cost, before switching a cell to
enforce.

The thresholds for reminders (0.10) and history searches (0.30) are low on purpose: they catch
every risky test call. The owner rules on card numbers and secret words hold those calls whatever
the score. The price is false marks on routine calls, which the shadow week measures before any of
them can hold a call.

## One ledger for spend

A person's month-to-date spend is read from pi-durable's own cost ledger. The guard adds the
decision model's and the reviewer's cost to the same ledger, in the commit that records its
verdict. A second, separate cost record was rejected: two records drift, and the limit alerts
would fire late.

A month starts at local midnight on the first, in one household time zone. Each person has a
monthly limit, 25 dollars by default. The developer specialist's spend counts against one
household developer budget instead, 50 dollars by default, so developer work does not use up one
person's limit. At 80% and at 100% of a limit, the person gets one notice and the owner gets one
alert. Above a limit, only direct chat
with the lead runs. Hand-offs, routines, and reminders wait and are not dropped, so a limit never
loses work. A hard stop on all work was rejected, because it would also stop the chat the person
uses to ask for help.

## Secrets: a cell, a helper, and grants

Secrets live in one secrets cell, never in an agent's memory or in a settings file. Each secret is
sealed with envelope encryption: AES-GCM-256 under a fresh data key, and the data key wrapped
under a key derived for that one record. The additional data binds each ciphertext to its person
and its secret name, so a ciphertext copied into another record fails to open.

A cell cannot read a host file, so a small key helper on the host holds the master keys. The
helper runs as its own system user, answers only the cell service user, and gives the secrets cell
one derived key per record. The master key never leaves the host. When the key files are missing
or readable by another user, the secrets cell refuses to start.

A grant names one agent and one secret, inside an allowlist the owner sets. Per-agent grants were
chosen over per-person grants: a research specialist that needs a token does not give that token
to the lead. For a health or production target, the secrets cell makes the outside call itself
(the broker), so the agent gets the answer and never holds the token.

## The risks this design accepts

- **A granted token can still leak.** An agent that reads a plain secret holds its value, and a
  later tool could send that value out. Redaction keeps known secret values out of activity, logs,
  prompts, and model state, but it cannot stop an agent that misuses a value it was given. The
  broker is the defence for the tokens that matter most.
- **The key helper trusts the cell service user.** Any process that runs as that user can ask the
  helper for a derived key. A derived key opens nothing without the secrets cell's stored record,
  and no agent tool today sends a request to an address of its choosing. But grant checks live
  only in the secrets cell, not in the helper.
- **Shadow mode runs risky calls that a rule permits.** The shadow week exists to measure that
  risk before the model layers can block.

## Related pages

- [How to guard your agents](../how-to/guard-agents.md): rules, held calls, activity, and cost.
- [How to operate the guard and the secrets cell](../how-to/operate-guard.md): limits, modes,
  secrets, and the key helper.
- [Guard fallback runbook](../runbooks/guard-fallback.md) and
  [secrets cell runbook](../runbooks/secrets-cell-refused.md).
- [Cell API reference](../reference/cell-api.md): the routes, their requests, and their answers.
