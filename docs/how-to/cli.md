# How to use the secbot command line

The `secbot` command talks to your own cell's lead over the private network. Every line you type
goes to the lead unchanged; the lead decides whether to answer itself or hand the question to a
specialist. There is no flag that picks a specialist.

Run it with `mise run cli -- <command>` from the repo, or `node packages/cli/src/main.ts <command>`.

## Register this device

1. `secbot device new <name>` makes a device key, saves it to `~/.config/secbot/device.json`
   (mode 0600; `SECBOT_CONFIG_DIR` moves it), and prints three lines: where the key was saved, a
   one-line instruction, and the entry `<name>:owner:<sha256>`. Copy only that last line. The key
   itself is never printed. Devices register for the owner only for now; the person in the entry
   is always `owner`.
2. Add the entry to the `SECBOT_DEVICE_KEYS` value you keep in your shell (comma-separated), then
   run host setup and deploy. The cell stores only the hash.
3. Point the CLI at your cell: set `SECBOT_CELL_URL`, or put `{"cellUrl": "..."}` in
   `~/.config/secbot/config.json`. The address is a private host name; it never goes in the repo.
   In production your cell is served by the owner fleet (`celld@prod-owner`, worker port 8788);
   the test cell's fleet (`celld@test`) listens on port 8787. For example
   `SECBOT_CELL_URL=http://<private host name>:8788`.

A key registered for one person is refused by every other person's cell, and the cell refuses any
request that does not arrive on one of the private host names it was deployed with. The host-name
check reads the request's `Host` header, which any caller can set, so it only catches a
misconfigured client; the network boundary is the private network and the VPS firewall, and the
device key is what proves the caller.

## Commands

| Command | What it does |
| --- | --- |
| `secbot chat` | A session with your lead. Answers stream in; a specialist's answer arrives later as `[from <name>] ...` while the session is open. `waiting for the model` means the model gateway is failing and your message is kept. |
| `secbot missed` | Calls waiting for your answer first, under `HELD CALLS`, then limit notices this device has not seen, then lead messages this device has not seen yet, oldest first. |
| `secbot cost` | Your month: spend against your limit, by layer (agent model, reviewer, decision model) and by role. `--person <name>` (another person) and `--owner` (the household) use the operator key. |
| `secbot limits show \| set <person> <usd> \| developer <usd> \| zone <IANA>` | The owner's limits, with the operator key: each person's monthly limit, the household developer budget, and the time zone months follow. |
| `secbot model list` | Each role's model and whether it is the release default or your change. The last row is the guard's `reviewer`, which judges the calls the decision model marks. |
| `secbot model set <role> <model-id>` | Changes a role's model from its next turn (the reviewer's from its next review). An unknown role or model is refused (exit 1) and nothing changes. |
| `secbot specialist add <name> --instruction "..." [--model <id>]` | Adds a specialist. The lead can hand work to it from its next turn. |
| `secbot rules list` | The owner's rules (you cannot loosen these), then your own rules: agent, tool, argument match, verdict. The owner's rules always include the release ones: agents never pay, a reminder holding a card number asks first, and a history search naming a password, passcode, PIN, token, or API key asks first. |
| `secbot rules add <agent> <tool> <permit\|ask-first\|prohibit> [match]` | Adds one of your rules. A rule looser than an owner rule is refused on stderr, naming the owner rule (exit 1). |
| `secbot rules remove <agent> <tool> [match]` | Removes the rule with that agent, tool, and match (give the match it was added with). |
| `secbot secrets list` | Your secrets: name, kind (`secret`, `health`, or `production`), and the agents each is granted to. Never a value. |
| `secbot secrets grant <secret> <agent>` | Lets one of your agents use that secret. Only inside the owner's allowlist; anything else is refused on stderr (exit 1). |
| `secbot secrets revoke <secret> <agent>` | Takes the grant back. |
| `secbot activity [--month YYYY-MM] [--page N]` | This month's activity under the month's spend, newest first, 50 to a page: each guard verdict, held call, answer, and lapse, and each hand-off, routine, and reminder with its state (running, waiting, done); time, agent, tool or job, verdict or state, the layer, the cost, and the reason or step on the line below. |

The match option is one of `--exact`, `--prefix`, `--email-domain`, `--web-domain`, or `--regex`,
each followed by `<argument>=<value>`, for example
`secbot rules add lead handoff permit --exact specialist=research`. The agent is `all`, `lead`, or
a specialist's name; the tool is a tool name, `pay` (every pay tool), or `*` (any tool). Inside
your rules the most specific one decides; between the owner's rules and yours the stricter wins.

### Answer a held call

When an ask-first rule matches, the agent's call waits for you instead of running. In
`secbot chat` it prints between the lead's output, for example:

```
[ HELD #1 ] the lead wants to run a tool                   lapses in 23 h 58 m
  agent      lead
  tool       handoff
  arguments  specialist = research
             brief = "Find direct trains to Leeds on Friday 10 Oct."
             api_key = [redacted]
  why held   your rule: lead handoff (any) -> ask first
  answer     /allow 1     allow once
             /always 1    allow always; adds: lead handoff
                          (specialist = research) -> permit
             /deny 1      deny
```

Answer with the call's number:

- `/allow 1` runs the call once.
- `/always 1` runs it and adds the rule shown, so the next matching call is not held. It is not
  offered when an owner rule asks first for the match; the line then says so.
- `/deny 1` refuses it; the agent is told `denied by <you>`.

Only an exact `/allow N`, `/always N`, or `/deny N` is an answer. Any other line goes to the lead
unchanged, and a line that starts like an answer but is not exact (`/allow one`) is not sent:
`not sent: answer with /allow N, /always N, or /deny N`. A call with no answer in 24 hours lapses
as a refusal; a late answer prints `[ lapsed ] #1 this request lapsed; nobody answered in 24 h`.
While the lead waits on its own held call, your chat lines are kept and reach it after the answer;
specialists, routines, and reminders keep running.

A call held while no session is open is listed first by `secbot missed`, with the answers to type
in `secbot chat`, and the next `secbot chat` shows it before missed messages:

```
HELD CALLS
------------------------------------------------------------------------------
#1  lead  handoff -> research  your rule: ask first        lapses in 21 h 10 m
answer in secbot chat: /allow 1, /always 1, /deny 1
```

### Your month's spend and limits

`secbot chat` prints the month's spend against your limit when it connects and after each answer:

```
[ month: $11.52 / $25.00 ] [#####.....] 46% [ shadow ]
[ month: $20.40 / $25.00 ] [########..] 82% [ 80% of limit ] [ shadow ]
[ month: $25.30 / $25.00 ] [##########] 101% [ limit reached ] [ shadow ]
```

At 80% and at 100% of your limit you get one notice, in `secbot chat` or, when no session is
open, in `secbot missed`; the owner gets one alert:

```
[ limit reached ] You have used $25.30 of $25.00 this month. Hand-offs,
  routines, and reminders wait until the owner raises your limit or the
  month resets on 1 Nov. Nothing is dropped. Chat with the lead continues.
  3 waiting: routine morning check (06:00), reminder bins out (19:00),
  handoff research train times (13:58)
```

Above your limit, chat with the lead continues; hand-offs, routines, and reminders wait, and a
specialist's running job finishes its current step and then waits. Nothing is dropped: the work
continues when the owner raises your limit or the month resets (local midnight on the first, in
the household time zone). The developer specialist counts against the household developer budget
instead, and its jobs wait above that budget the same way.

Every person starts at a limit of 25 dollars a month, the owner included. When the owner's own
spend is already above 25 dollars, the owner's hand-offs, routines, and reminders wait until the
owner raises their own limit:

```
$ secbot limits set owner 60
owner's monthly limit is now $60.00 from the next call
$ secbot limits developer 60
the developer budget is now $60.00 from the next call
$ secbot limits zone Europe/London
the household time zone is now Europe/London from the next month
```

`secbot cost` shows your month by layer and role; on the owner's machine `secbot cost --owner`
shows every person, the developer budget, and when each shadow cell has a week of logs. A device
key cannot change a limit.

### Read your activity

`secbot activity` lists the current month, newest first, under the month's spend (the same
number as the usage line and `secbot cost`):

```
ACTIVITY  sam  October 2026                                  [ total: $11.52 ]
------------------------------------------------------------------------------
TIME   AGENT      TOOL OR JOB              VERDICT       LAYER          COST
14:02  lead       handoff -> research      allowed       person    $0.0000
         allowed once by sam
13:58  lead       handoff -> research      held          rule      $0.0000
         your rule: lead handoff (any) -> ask first
01:05  research   job: train times         running       job       $0.1310
         step 1 of 2: research is working
showing 3 of 3 this month; older: secbot activity --month 2026-09
```

A job is a hand-off to a specialist, a routine run, or a reminder. It shows `running` or
`waiting` (above your limit, or a reminder before its time) while it lasts, and `done` once it
ended, with its cost: a hand-off costs what the specialist spent on it; a routine or reminder
costs nothing itself (the lead's answer counts as chat). A month lists 50 rows a page; while older
rows of the month remain the last line says `older: secbot activity --page 2`, and on the last
page it names the month before. `--month` and `--page` combine. Activity is kept with no pruning.

### Read shadow verdicts

Every cell starts in shadow mode. Rules, ask-first rules, and approvals always apply; the decision
model and the reviewer run on the calls the rules permit and record what they would have done, but
the call runs. A reminder to "move the savings to the new account on Friday" matches no owner
rule, but the decision model can still mark it for the reviewer; in `secbot activity` such a row
reads:

```
11:20  lead       set_reminder             would ask     reviewer  $0.0061
         shadow: reminder moves the savings to a new account; the call ran
```

`would block` and `would ask` are the reviewer's block and ask; the reason says the call ran. In
enforce mode the same call is `refused` with `reviewer: <reason>`, or held for you with
`why held   reviewer: <reason>`. When the reviewer fails or is too slow, an enforced call is held
with `why held   reviewer unavailable`.

### Switch a cell between shadow and enforce (owner)

On the owner's machine, with the operator key:

```
$ secbot mode show sam
sam  mode shadow  since 8 Oct 18:20  decision model jev
$ secbot mode set sam enforce
sam now runs in enforce mode
$ secbot mode decision sam clef
sam now uses the clef decision model from the next call
```

`secbot mode set <person> shadow` switches back; switching to the mode a cell already has prints
`<person> already runs in <mode> mode` and changes nothing. Read at least a week of shadow verdicts
before you switch a cell to enforce. A device key cannot switch a mode. A new cell starts on the
Jev decision model; `secbot mode decision <person> clef|clef-flash|jev` changes it from the next
call.

### Secrets (owner)

On the owner's machine, with the operator key. `add` reads the value from standard input. Send it
from a file, as below, so it never appears in your shell history or on screen; typed at a
terminal, the value shows as you type it:

```
$ secbot secrets add --person sam test-secret < value.txt
[ stored ] test-secret for sam under key k1
$ secbot secrets add --person sam health-test --broker health --url "$HEALTH_URL" --header authorization < token.txt
[ stored ] health-test for sam under key k1; used only through the broker
$ secbot secrets allowlist --person sam add test-secret research
[ allowed ] sam test-secret -> research
$ secbot secrets allowlist --person sam remove test-secret research
[ removed ] sam test-secret -> research; its grant was revoked
$ secbot secrets rotate
[ rotated ] 3 secrets re-wrapped under key k2; 0 left under k1
```

`secbot secrets list --person sam` lists that person's secrets. A broker secret (`--broker
health` or `--broker production`) is never given to an agent: the agent asks the secrets cell to
make the call, and gets the answer without the token. A person grants a secret only to an agent
the owner's allowlist names for it; removing the allowlist entry also revokes the grant. When the
secrets cell cannot be reached, every `secrets` command prints
`secbot: refused: secrets cell unavailable` (exit 1).

### The owner's views of another person

On the owner's machine, `--owner --person <name>` makes `rules list`, `add`, and `remove` work on
the owner rules of that person's cell, and `secbot activity --person <name>` reads that person's
activity (the header then says `(operator key)`). These use the operator key, from
`SECBOT_OPERATOR_KEY` in your shell or `{"key": "..."}` in `~/.config/secbot/operator.json`
(mode 0600). The key is sent only to the operator routes and never printed. A device key cannot
read another person's rules or activity.

The operator routes serve the people of the fleet they run in. To read a person served by the
other fleet, point `SECBOT_CELL_URL` at that fleet's address for the one command, for example
`SECBOT_CELL_URL=$OTHER_FLEET_URL secbot activity --person <name>`, with `OTHER_FLEET_URL` set in
your own shell.

If the connection drops, `chat` reconnects and resends every line the cell has not acknowledged,
under the same request id, so nothing is submitted twice. When a session opens, what the lead
said while no session was open on this device is printed first, oldest first. A line over 20000
characters is not sent. `missed` lists at most 100 messages at a time and says how many are left.

The routes and frames are in the [cell API reference](../reference/cell-api.md).

## Exit codes

- `0` success
- `1` the cell refused or failed (the reason is printed), or a message was not acknowledged
- `2` usage error
