#!/usr/bin/env node
/**
 * secbot: the owner's command-line client. It talks to the owner's own cell only (the
 * person in the device file). It has no option that chooses a specialist: every chat line goes to
 * the lead, and the lead decides on a hand-off.
 *
 *   secbot chat
 *   secbot missed
 *   secbot model list
 *   secbot model set <role> <model-id>
 *   secbot specialist add <name> --instruction "<text>" [--model <model-id>]
 *   secbot device new <name>
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CellClient } from "./client.ts";
import { chat } from "./commands/chat.ts";
import { deviceNew } from "./commands/device.ts";
import { missed } from "./commands/missed.ts";
import { modelList, modelSet } from "./commands/model.ts";
import { specialistAdd } from "./commands/specialist.ts";
import { CliError, type Environment } from "./config.ts";
import { type Io, processIo } from "./io.ts";

const USAGE = `usage:
  secbot chat
  secbot missed
  secbot model list
  secbot model set <role> <model-id>
  secbot specialist add <name> --instruction "<text>" [--model <model-id>]
  secbot device new <name>
`;

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
    io.stderr(USAGE);
    return 2;
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`secbot: ${error.message}\n`);
      return error.exitCode;
    }
    if (
      error instanceof TypeError &&
      "code" in error &&
      String(error.code).startsWith("ERR_PARSE_ARGS")
    ) {
      io.stderr(`secbot: ${error.message}\n${USAGE}`);
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
