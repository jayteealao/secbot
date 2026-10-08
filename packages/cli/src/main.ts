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
 *   secbot activity [--month YYYY-MM]       (another person: --person <name>)
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
import { deviceNew } from "./commands/device.ts";
import { missed } from "./commands/missed.ts";
import { modelList, modelSet } from "./commands/model.ts";
import {
  deviceTarget,
  type GuardTarget,
  operatorTarget,
  rulesAdd,
  rulesList,
  rulesRemove,
} from "./commands/rules.ts";
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
  secbot activity [--month YYYY-MM] [--person <name> (operator key)]
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
    if (command === "activity" && sub === undefined) {
      const target =
        values.person === undefined ? deviceTarget(await client()) : await operator(values.person);
      return await activity(target, io, values.month);
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
