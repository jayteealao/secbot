# Secbot product charter

This charter states what Secbot is for, who it serves, how it is built, and how we know the first version works. Every piece of work reads it first. The brainstorm board at `.ai/workflows/brainstorm-own-dots-pi-durable-celld-20261002/` holds the full reasoning; when this charter and the board differ, the board wins.

## What Secbot is
<!-- brainstorm: brainstorm-own-dots-pi-durable-celld-20261002#secbot-is-a-name, owner-is-household, household-two-people, no-children -->

Secbot is only a project name. The product is a general personal agent, in the style of OpenAI Dots and the Grok Primary Bot. It is not a security product.

Secbot serves the owner and the owner's household first, not a company and not paying strangers. Two adults use it, and there are no child profiles. The system has two person cells, one household cell, one secrets cell, and three AgentMail inboxes.

## Why we build our own
<!-- brainstorm: brainstorm-own-dots-pi-durable-celld-20261002#pain-cost-region, pain-data-control, pain-lock-in, pain-channels, priority-lockin-and-channels -->

There are four reasons:

1. **Cost and region.** The originals cost too much, or they are not offered where the owner lives.
2. **Data control.** Memory, files, and credentials stay on infrastructure the owner controls.
3. **No lock-in.** The agent is not locked to one model or one vendor.
4. **Familiar channels.** The household reaches the agent where it already talks, not only in a vendor app.

When these reasons conflict, **no lock-in and familiar channels win** over cost and data control. This rule explains the swappable vendors, such as OpenRouter and AgentMail: each vendor stays replaceable, and its convenience is accepted.

## How we build it
<!-- brainstorm: brainstorm-own-dots-pi-durable-celld-20261002#agents-write-build, opendots-borrow-designs -->

Agents write the whole build, and they cut no corners. Build time is not the constraint. Review and correctness are the constraints.

We borrow designs from CopilotKit OpenDots: pages with review cards, skills from evidence, and permissions per specialist. We do not borrow its code, because OpenDots runs on a different stack.

## What the first version holds
<!-- brainstorm: brainstorm-own-dots-pi-durable-celld-20261002#first-version-all-jobs, first-version-in-stages -->

All nineteen jobs are core, and all nineteen go into the first version. The first version is built in stages. The morning briefing is the first job built, so a working agent exists after the early stages.

The agreed waves are:

0. This charter.
1. The cell runtime: pi-durable inside celld cells, with one harness per person.
2. The safety core: the secrets cell, the three-layer tool hook, rules, and limits.
3. In parallel: sign-in and the phone app, agent mail, memory and skills, the household computer, and the developer specialist.
4. The morning briefing, end to end.
5. The daily household jobs.
6. The money, travel, booking, health, weight, and smart home jobs, with the smart home last.
7. Live calls and shared pages.

## How we know the first version works
<!-- brainstorm: brainstorm-own-dots-pi-durable-celld-20261002#success-four-measures -->

The first version succeeds when all four of these are true:

1. Both people use it daily for one month.
2. It replaces a paid tool.
3. It runs for 30 days with no restart, no lost data, and no missed briefing.
4. The owner can name the hours it saves each week.
