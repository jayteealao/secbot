// `secbot specialist add <name> --instruction <text> [--model <id>]`: a new specialist the lead
// can brief from its next turn.
import type { CellClient } from "../client.ts";
import { CliError } from "../config.ts";
import type { Io } from "../io.ts";

export async function specialistAdd(
  client: CellClient,
  io: Io,
  name: string | undefined,
  instruction: string | undefined,
  model: string | undefined,
): Promise<number> {
  if (name === undefined || instruction === undefined) {
    throw new CliError(
      'usage: secbot specialist add <name> --instruction "<text>" [--model <id>]',
      2,
    );
  }
  await client.request("POST", "/specialists", {
    name,
    instruction,
    ...(model === undefined ? {} : { model }),
  });
  io.stdout(`added ${name}; the lead can brief it from its next turn\n`);
  return 0;
}
