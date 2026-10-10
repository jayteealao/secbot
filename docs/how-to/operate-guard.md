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
environment's master keys in a directory readable by the celld user alone, and gives the cell only
a key derived for one record. `mise run host:setup` installs it and creates each environment's
first master key once, on the host; the key is never printed or copied off the host. The host
needs Python 3.8 or later; host setup stops with a message when it is missing and never installs
one.

When the key helper is missing or its key file is unreadable, the secrets cell refuses to start and
every `secbot secrets` command prints `secbot: refused: secrets cell unavailable`. Run
`mise run host:setup` again; it does not replace a key that exists.

## Add a secret

`add` reads the value from standard input, so it never appears in your shell history or on screen:

```
$ secbot secrets add --person sam test-secret < value.txt
$ secbot secrets add --person sam health-test --broker health --url "$HEALTH_URL" --header authorization < token.txt
```

A broker secret is never given to an agent: the agent asks the secrets cell to make the call and
gets the answer without the token. Keep `HEALTH_URL` in your shell. `secbot secrets list --person
sam` lists that person's secrets by name.

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
many are left under the old key. Run it again when that number is not 0.

## The decision-model setting

Each cell names its decision model. A new cell starts on Jev (`jev`); Clef (`clef`) and Clef Flash
(`clef-flash`) are the other settings. Read it with `secbot mode show <person>`; change it with
`secbot mode decision <person> <model>`, from the next call. When the decision model fails or is
too slow, the guard falls back as the [model outage runbook](../runbooks/model-outage.md) says.

## Switch from shadow to enforce

Every cell starts in shadow mode: rules and approvals apply, and the decision model and the
reviewer record what they would have done. Read at least a week of shadow verdicts in
`secbot activity --person <name>` first, then:

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
   `mise run measure:guard -- --env test-cell --calls 100 --adapter jev`. It passes when the p95
   is under 800 ms. A run where the decision model fell back on half the calls or more is
   `not measured`.
6. Check that Jev marks the risky example calls:
   `mise run measure:guard -- --env test-cell --examples --repeat 2 --adapter jev`. The bench
   makes each example call twice and judges each score on its tool's release threshold. It
   passes only when every risky example scores at or above the threshold and every routine
   example scores below it. When the verdict is `fail` or `not measured`, stop the check and
   ask the owner. Do not change a threshold to make it pass.
7. Run part 1 of the live check, which stops itself when the month's spend rises by more than
   5 dollars: `mise run live:guard -- charter --part 1 --out <dir>`.
8. Restart the test cell with `mise run test:durability -- --crash-only`.
9. Run part 2, which checks that a held call outlived the restart and cleans up:
   `mise run live:guard -- charter --part 2 --out <dir>`.
10. Write the summary: `mise run live:guard -- report --out <dir>`. It names each evidence file
    `present` or `missing`.

The evidence files are scrubbed before they are written; a file that still holds a private value
is not written and the run fails. Read `<dir>/summary.md` before you share any of it.
