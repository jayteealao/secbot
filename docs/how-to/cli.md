# How to use the secbot command line

The `secbot` command talks to your own cell's lead over the private network. Every line you type
goes to the lead unchanged; the lead decides whether to answer itself or hand the question to a
specialist. There is no flag that picks a specialist.

Run it with `mise run cli -- <command>` from the repo, or `node packages/cli/src/main.ts <command>`.

## Register this device

1. `secbot device new <name>` makes a device key, saves it to `~/.config/secbot/device.json`
   (mode 0600; `SECBOT_CONFIG_DIR` moves it), and prints one line: `<name>:<person>:<sha256>`.
   The key itself is never printed.
2. Add that line to the `SECBOT_DEVICE_KEYS` value you keep in your shell (comma-separated), then
   run host setup and deploy. The cell stores only the hash.
3. Point the CLI at your cell: set `SECBOT_CELL_URL`, or put `{"cellUrl": "..."}` in
   `~/.config/secbot/config.json`. The address is a private host name; it never goes in the repo.

A key registered for one person is refused by every other person's cell, and the cell refuses any
request that does not arrive on one of the private host names it was deployed with.

## Commands

| Command | What it does |
| --- | --- |
| `secbot chat` | A session with your lead. Answers stream in; a specialist's answer arrives later as `[from <name>] ...` while the session is open. `waiting for the model` means the model gateway is failing and your message is kept. |
| `secbot missed` | Lead messages this device has not seen yet, oldest first. |
| `secbot model list` | Each role's model and whether it is the release default or your change. |
| `secbot model set <role> <model-id>` | Changes a role's model from its next turn. An unknown role or model is refused (exit 1) and nothing changes. |
| `secbot specialist add <name> --instruction "..." [--model <id>]` | Adds a specialist. The lead can hand work to it from its next turn. |

If the connection drops, `chat` reconnects and resends every line the cell has not acknowledged,
under the same request id, so nothing is submitted twice.

## Exit codes

- `0` success
- `1` the cell refused or failed (the reason is printed), or a message was not acknowledged
- `2` usage error
