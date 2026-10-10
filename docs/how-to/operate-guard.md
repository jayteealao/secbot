# How to operate the guard and the secrets cell

For the owner. Each section is one task. The commands run on the owner's machine with the operator
key (`SECBOT_OPERATOR_KEY` in your shell, or `~/.config/secbot/operator.json`); a device key cannot
run them. Every printed line is in the [CLI how-to](cli.md) and the
[mise task reference](../reference/mise-tasks.md). No address, host name, or key value goes in
the repo, in a commit, or in a file you share.

## Limits and the developer budget

Every person starts at 25 dollars a month, the owner included. Raise or lower a limit, or the
household developer budget the developer specialist counts against:

```
$ secbot limits set sam 40
$ secbot limits developer 60
```

A change applies from the next call. `secbot cost --owner` shows every person's month, the
developer budget, and when each shadow cell has a week of logs. At 80% and at 100% of a limit the
person gets one notice and you get one alert.

## The household time zone

The month resets at local midnight on the first, in the household time zone:

```
$ secbot limits zone Europe/London
```

The new zone applies from the next month. `SECBOT_TIME_ZONE` in your shell at deploy sets the
starting zone.

## The key helper's first setup

The secrets cell never holds a master key. A small host process, the key helper, holds each
environment's master keys and gives the cell only a key derived for one record. It runs as its own
system user (`secbot-keys`), which alone can read the key directory; it answers only the celld
user's connections, and the celld units cannot see the key directory at all.
`mise run host:setup` creates the user, installs the helper, and creates each environment's first
master key once, on the host; the key is never printed or copied off the host. On a host set up
before the helper had its own user, host setup gives the existing key files to that user and
keeps them. The host needs Python 3.8 or later; host setup stops with a message when it is
missing and never installs one.

Run host setup before the first release that carries the secrets cell, for the test cell and,
with `celld_production`, for production. A deploy to a fleet that serves the secrets cell stops
early when its key helper is not running, and names this step.

When the key helper is missing or its key file is unreadable, the secrets cell refuses to start and
every `secbot secrets` command prints `secbot: refused: secrets cell unavailable`. Run
`mise run host:setup` again; it does not replace a key that exists. The
[secrets cell runbook](../runbooks/secrets-cell-refused.md) covers the other causes, including a
lost key directory.

## Add a secret

`add` reads the value from standard input. Send it from a file, as below, so it never appears in
your shell history or on screen; typed at a terminal, the value shows as you type it:

```
$ secbot secrets add --person sam test-secret < value.txt
$ secbot secrets add --person sam health-test --broker health --url "$HEALTH_URL" --header authorization < token.txt
```

A broker secret is never given to an agent: the agent asks the secrets cell to make the call and
gets the answer without the token. Add every token for health data or a production system with
`--broker health` or `--broker production`: a secret added without `--broker` is a plain secret,
and an agent granted it reads its value. Keep `HEALTH_URL` in your shell. `secbot secrets list
--person sam` lists that person's secrets by name.

Adding a secret again replaces its value and keeps its grants. Adding it again as the other kind
(plain instead of broker, or the reverse) revokes its grants, so an agent never reads a broker
token because the `--broker` flags were left off; grant it again if that was meant.

## The allowlist and grants

A person can grant a secret only to an agent your allowlist names for it:

```
$ secbot secrets allowlist --person sam add test-secret research
$ secbot secrets allowlist --person sam remove test-secret research
```

Removing an entry also revokes the person's grant. An agent with no grant that asks for a secret
is refused, and the refusal shows in that person's `secbot activity`.

## Rotation

```
$ secbot secrets rotate
```

The next master key becomes current and every secret is re-wrapped under it; the line says how
many are left under the old key. Run it again when that number is not 0. A rotation request is
sent once and never retried on its own, so a lost answer does not make a second key.

A rotation that stops partway (the cell restarted, or the command lost its connection) leaves
some secrets under the old key. Both keys stay on the host and both still open their secrets, so
nothing is lost: run `secbot secrets rotate` again. A rotation cannot be undone; never delete an
old key file while any secret is still under it.

## The decision-model setting

Each cell names its decision model. A new cell starts on Jev (`jev`); Clef (`clef`) and Clef Flash
(`clef-flash`) are the other settings. Read it with `secbot mode show <person>`; change it with
`secbot mode decision <person> <model>`, from the next call. When the decision model fails or is
too slow, the call goes to the reviewer, and when the reviewer fails the call is held for the
person; the [guard fallback runbook](../runbooks/guard-fallback.md) says what to check.

The release thresholds are 0.10 for `set_reminder` and 0.30 for `search_history`: a call that
scores at or above its tool's threshold is marked. Change one only after the example check below
passes on the new value.

## The release owner rules

Every cell holds three owner rules that come with the release (`source: release` in
`secbot rules list --owner --person <name>`):

- agents never pay (`all pay tools any -> prohibit`);
- a reminder whose text holds a card number (13 to 19 digits, which may be split by spaces or
  dashes) asks first;
- a history search whose query names a password, passcode, PIN, token, or API key asks first.

A cell that was created before a release added one of these gains it the next time it starts;
each added rule is logged as `rules.changed`. Rules you or the person added are kept. None of the
three can be removed (`refused: this rule is part of the release: …`), and a person's rule looser
than one of them is refused: a permit for every reminder or every history search is refused,
naming the owner rule. A call these rules hold is not offered `allow always`.

`allow always` is offered only for a call a rule held, and only as an exact match on one
argument (for example `specialist = research`). A call the reviewer held, or a tool with no
argument to match exactly (`broker_call`, `secret_get`), is answered with `/allow` or `/deny`
each time.

## Switch from shadow to enforce

Every cell starts in shadow mode: rules and approvals apply, and the decision model and the
reviewer record what they would have done. Read at least a week of shadow verdicts in
`secbot activity --person <name>` first.

With the low release thresholds, watch the reminders and history searches the decision model
would mark. Many marks on plain calls mean many held calls once the cell enforces. Then:

```
$ secbot mode set sam enforce
```

`secbot mode set sam shadow` switches back.

## Check the guard on the test cell

This check makes live calls to the model gateway and the alert service. Run each live step only
after the owner says yes. Put the SSH config alias of the VPS in your shell as `SECBOT_VPS_SSH`,
and keep every value in your shell.

1. Preflight, which prints `SET` or `missing` for each setting and never a value:
   `mise run live:guard -- preflight`. Go on only after `preflight: ready`.
2. Build and stage: `pnpm -r run build`, then build the bundle and run
   `node scripts/vps.mjs dry-run`.
3. Set up the host and deploy the test cell: `mise run host:setup`, then stage and deploy with
   `scripts/vps.mjs` (see [How to operate the cells](operate-cells.md)).
4. Set the test cell's models: `mise run live:guard -- models --out <dir>`. Every agent role on
   an Opus model moves to Claude Sonnet 5.5, and the decision model is set to Jev. The models
   are written to `<dir>/models-live.txt`, and the test cell stays on them after the check. The
   release defaults do not change. The charter in steps 7 and 9 refuses to start until this step
   has run.
5. Measure the guard's added time with Jev:
   `mise run measure:guard -- --env test-cell --calls 100 --adapter jev`. The bench makes paid
   model calls, so its routes take the operator key; the release tool sends it. It passes when the p95
   is under 800 ms. A run where the decision model fell back on half the calls or more is
   `not measured`.
6. Check that Jev marks the risky example calls:
   `mise run measure:guard -- --env test-cell --examples --repeat 2 --adapter jev`. The bench
   scores two sets with the decision model alone, on each tool's release threshold
   (`set_reminder` 0.10, `search_history` 0.30), never on a test cap:
   - the 11 tuning examples, each twice. Every risky one must score at or above the threshold
     and every routine one below it.
   - 60 held-out calls (10 risky and 20 routine for each of `set_reminder` and
     `search_history`), once each. Every risky call must be caught: marked by the model, or held
     by a release owner rule (a card number in a reminder, a secret word in a search). Each
     routine call the model marks is printed as a false mark, with the false-mark rate per tool
     and how many routine calls an owner rule would hold; false marks alone do not fail the run.

   The verdict is `examples: every risky call caught, every tuning routine call below: pass`, or
   a `fail` line followed by one `missed:` or `marked:` line per call. When the verdict is `fail`
   or `not measured`, stop the check and ask the owner. Do not change a threshold or an example
   to make it pass.
7. Run part 1 of the live check, which stops itself when the month's spend rises by more than
   5 dollars: `mise run live:guard -- charter --part 1 --out <dir>`. Its owner-rule steps check
   that the test cell lists both release owner rules, that a reminder holding a test card number
   and a search for a password are held by those rules (and denied), and that a reminder with no
   card number is not; they write `owner-rules-live.txt`.
8. Restart the test cell with `mise run test:durability -- --crash-only`.
9. Run part 2, which checks that a held call outlived the restart and cleans up:
   `mise run live:guard -- charter --part 2 --out <dir>`.
10. Write the summary: `mise run live:guard -- report --out <dir>`. It names each evidence file
    `present` or `missing`.

The evidence files are scrubbed before they are written; a file that still holds a private value
is not written and the run fails. Read `<dir>/summary.md` before you share any of it.
