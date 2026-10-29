// `secbot specialist add <name> --instruction <text>`: a new job template the lead can start jobs
// from from its next turn. A template starts on the cheap tier; the lead picks the tier per job,
// so the cell refuses `--model` and the refusal reaches stderr.
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
    throw new CliError('usage: secbot specialist add <name> --instruction "<text>"', 2);
  }
  await client.request("POST", "/specialists", {
    name,
    instruction,
    ...(model === undefined ? {} : { model }),
  });
  io.stdout(
    `added ${name} as a job template; the lead can start jobs from it from its next turn\n`,
  );
  return 0;
}
