#!/usr/bin/env node
/**
 * secbot: the owner's command-line client. It talks to the owner's own cell only (the
 * person in the device file). It has no option that chooses a specialist: every chat line goes to
 * the lead, and the lead decides on a hand-off.
 *
 *   secbot chat                             (answer a held call: /allow N, /always N, /deny N)
 *   secbot missed
 *   secbot model list
 *   secbot model set <role> <model-id>
 *   secbot specialist add <name> --instruction "<text>" [--model <model-id>]
 *   secbot device new <name>
 *   secbot rules list | add | remove        (owner rules: --owner --person <name>)
 *   secbot activity [--month YYYY-MM] [--page N]   (another person: --person <name>)
 *   secbot mode show | set | decision <person>   (operator key)
 *   secbot cost [--person <name> | --owner]  (another person or the household: operator key)
 *   secbot limits show | set <person> <usd> | developer <usd> | zone <IANA>   (operator key)
 *   secbot secrets list | grant | revoke     (a person's own; --person <name>: operator key)
 *   secbot secrets add | allowlist | rotate  (operator key; add reads the value from stdin)
 *
 * The owner's views of another person use the operator key (SECBOT_OPERATOR_KEY, or operator.json
 * in the config folder), sent only to the operator routes.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CellClient, OperatorClient } from "./client.ts";
import { activity } from "./commands/activity.ts";
import { chat } from "./commands/chat.ts";
import { costHousehold, costOf, costOwn } from "./commands/cost.ts";
import { deviceNew } from "./commands/device.ts";
import { limits } from "./commands/limits.ts";
import { missed } from "./commands/missed.ts";
import { mode } from "./commands/mode.ts";
import { modelList, modelSet } from "./commands/model.ts";
import {
  deviceTarget,
  type GuardTarget,
  operatorTarget,
  rulesAdd,
  rulesList,
  rulesRemove,
} from "./commands/rules.ts";
import { secrets } from "./commands/secrets.ts";
import { specialistAdd } from "./commands/specialist.ts";
import { CliError, type Environment } from "./config.ts";
import { type Io, processIo } from "./io.ts";
import { WIDTH, wrap } from "./text.ts";

const USAGE = `usage:
  secbot chat
      in chat, answer a held call: /allow N, /always N, or /deny N
  secbot missed
  secbot model list
  secbot model set <role> <model-id>
  secbot specialist add <name> --instruction "<text>" [--model <model-id>]
  secbot device new <name>
  secbot rules list
  secbot rules add <agent> <tool> <permit|ask-first|prohibit> [match]
  secbot rules remove <agent> <tool> [match]
      match: --exact | --prefix | --email-domain | --web-domain | --regex <argument>=<value>
      owner rules for a person: --owner --person <name> (operator key)
  secbot activity [--month YYYY-MM] [--page N] [--person <name> (operator key)]
  secbot mode show <person>                         (operator key)
  secbot mode set <person> shadow|enforce           (operator key)
  secbot mode decision <person> clef|jev            (operator key)
      shadow: the decision model and the reviewer only record what they
      would do; rules and ask-first rules always apply
  secbot cost [--person <name> | --owner]           (another person, or the
      household: operator key)
  secbot limits show                                (operator key)
  secbot limits set <person> <usd>                  (operator key)
  secbot limits developer <usd>                     (operator key)
  secbot limits zone <IANA time zone>               (operator key)
      above a limit, hand-offs, routines, and reminders wait; chat with the
      lead continues; nothing is dropped
  secbot secrets list [--person <name> (operator key)]
  secbot secrets grant <secret> <agent>
  secbot secrets revoke <secret> <agent>
  secbot secrets add --person <name> <secret>       (operator key)
      [--broker health|production --url <url> --header <name>]
      the value is read from standard input and never printed
  secbot secrets allowlist --person <name> add|remove <secret> <agent>
                                                    (operator key)
  secbot secrets rotate                             (operator key)
`;

/** `text` with every line wider than 80 columns wrapped, continuing two spaces further in. */
function fitted(text: string): string {
  return text
    .split("\n")
    .flatMap((row) => {
      if (row.length <= WIDTH) return [row];
      const lead = row.length - row.trimStart().length;
      const [first = "", ...more] = wrap(row.trim(), lead + 2);
      return [`${" ".repeat(lead)}${first.trimStart()}`, ...more];
    })
    .join("\n");
}

export interface RunOptions {
  readonly environment: Environment;
  readonly io: Io;
  readonly fetch?: typeof fetch;
  readonly reconnectMs?: number;
}

export async function run(argv: readonly string[], options: RunOptions): Promise<number> {
  const { environment, io } = options;
  try {
    const { positionals, values } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        instruction: { type: "string" },
        model: { type: "string" },
        help: { type: "boolean", short: "h" },
        exact: { type: "string" },
        prefix: { type: "string" },
        "email-domain": { type: "string" },
        "web-domain": { type: "string" },
        regex: { type: "string" },
        owner: { type: "boolean" },
        person: { type: "string" },
        month: { type: "string" },
        page: { type: "string" },
        broker: { type: "string" },
        url: { type: "string" },
        header: { type: "string" },
      },
    });
    const [command, sub, ...rest] = positionals;
    if (values.help === true || command === undefined) {
      io.stdout(USAGE);
      return command === undefined && values.help !== true ? 2 : 0;
    }
    if (command === "device" && sub === "new") return await deviceNew(environment, io, rest[0]);
    const client = () => CellClient.from(environment, options.fetch);
    if (command === "chat") {
      return await chat(
        await client(),
        io,
        options.reconnectMs === undefined ? {} : { reconnectMs: options.reconnectMs },
      );
    }
    if (command === "missed") return await missed(await client(), io);
    if (command === "model" && sub === "list") return await modelList(await client(), io);
    if (command === "model" && sub === "set")
      return await modelSet(await client(), io, rest[0], rest[1]);
    if (command === "specialist" && sub === "add") {
      return await specialistAdd(await client(), io, rest[0], values.instruction, values.model);
    }
    const operator = async (person: string): Promise<GuardTarget> =>
      operatorTarget(await OperatorClient.from(environment, options.fetch), person);
    if (command === "rules" && (sub === "list" || sub === "add" || sub === "remove")) {
      if ((values.owner === true) !== (values.person !== undefined)) {
        throw new CliError("owner rules take --owner and --person <name> together", 2);
      }
      const target =
        values.person === undefined ? deviceTarget(await client()) : await operator(values.person);
      const match = {
        ...(values.exact === undefined ? {} : { exact: values.exact }),
        ...(values.prefix === undefined ? {} : { prefix: values.prefix }),
        ...(values["email-domain"] === undefined ? {} : { "email-domain": values["email-domain"] }),
        ...(values["web-domain"] === undefined ? {} : { "web-domain": values["web-domain"] }),
        ...(values.regex === undefined ? {} : { regex: values.regex }),
      };
      if (sub === "list") return await rulesList(target, io);
      if (sub === "add") return await rulesAdd(target, io, rest, match);
      return await rulesRemove(target, io, rest, match);
    }
    if (command === "mode") {
      return await mode(() => OperatorClient.from(environment, options.fetch), io, sub, rest);
    }
    if (command === "cost" && sub === undefined) {
      if (values.owner === true && values.person !== undefined) {
        throw new CliError("secbot cost takes --person <name> or --owner, not both", 2);
      }
      if (values.owner === true) {
        return await costHousehold(await OperatorClient.from(environment, options.fetch), io);
      }
      if (values.person !== undefined) {
        return await costOf(
          await OperatorClient.from(environment, options.fetch),
          io,
          values.person,
        );
      }
      return await costOwn(await client(), io);
    }
    if (command === "limits") {
      return await limits(() => OperatorClient.from(environment, options.fetch), io, sub, rest);
    }
    if (command === "secrets") {
      return await secrets(
        client,
        () => OperatorClient.from(environment, options.fetch),
        io,
        sub,
        rest,
        { person: values.person, broker: values.broker, url: values.url, header: values.header },
      );
    }
    if (command === "activity" && sub === undefined) {
      const target =
        values.person === undefined ? deviceTarget(await client()) : await operator(values.person);
      return await activity(target, io, values.month, values.page);
    }
    io.stderr(USAGE);
    return 2;
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(fitted(`secbot: ${error.message}\n`));
      return error.exitCode;
    }
    if (
      error instanceof TypeError &&
      "code" in error &&
      String(error.code).startsWith("ERR_PARSE_ARGS")
    ) {
      io.stderr(fitted(`secbot: ${error.message}\n${USAGE}`));
      return 2;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2), {
    environment: { env: process.env, home: homedir() },
    io: processIo,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`secbot: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
