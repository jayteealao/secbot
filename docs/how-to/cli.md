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
| `secbot missed` | Lead messages this device has not seen yet, oldest first. |
| `secbot model list` | Each role's model and whether it is the release default or your change. |
| `secbot model set <role> <model-id>` | Changes a role's model from its next turn. An unknown role or model is refused (exit 1) and nothing changes. |
| `secbot specialist add <name> --instruction "..." [--model <id>]` | Adds a specialist. The lead can hand work to it from its next turn. |

| `secbot rules list` | The owner's rules (you cannot loosen these), then your own rules: agent, tool, argument match, verdict. |
| `secbot rules add <agent> <tool> <permit\|ask-first\|prohibit> [match]` | Adds one of your rules. A rule looser than an owner rule is refused on stderr, naming the owner rule (exit 1). |
| `secbot rules remove <agent> <tool> [match]` | Removes the rule with that agent, tool, and match (give the match it was added with). |
| `secbot activity [--month YYYY-MM]` | This month's guard verdicts, newest first: time, agent, tool, verdict, the layer that decided, the cost, and the reason on the line below. |

The match option is one of `--exact`, `--prefix`, `--email-domain`, `--web-domain`, or `--regex`,
each followed by `<argument>=<value>`, for example
`secbot rules add lead handoff permit --exact specialist=research`. The agent is `all`, `lead`, or
a specialist's name; the tool is a tool name, `pay` (every pay tool), or `*` (any tool). Inside
your rules the most specific one decides; between the owner's rules and yours the stricter wins.

### The owner's views of another person

On the owner's machine, `--owner --person <name>` makes `rules list`, `add`, and `remove` work on
the owner rules of that person's cell, and `secbot activity --person <name>` reads that person's
activity (the header then says `(operator key)`). These use the operator key, from
`SECBOT_OPERATOR_KEY` in your shell or `{"key": "..."}` in `~/.config/secbot/operator.json`
(mode 0600). The key is sent only to the operator routes and never printed. A device key cannot
read another person's rules or activity.

If the connection drops, `chat` reconnects and resends every line the cell has not acknowledged,
under the same request id, so nothing is submitted twice. When a session opens, what the lead
said while no session was open on this device is printed first, oldest first. A line over 20000
characters is not sent. `missed` lists at most 100 messages at a time and says how many are left.

The routes and frames are in the [cell API reference](../reference/cell-api.md).

## Exit codes

- `0` success
- `1` the cell refused or failed (the reason is printed), or a message was not acknowledged
- `2` usage error
