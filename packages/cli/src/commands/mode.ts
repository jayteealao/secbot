// `secbot mode show | set | decision <person>`: the owner's switch for a person cell's model
// layers, with the operator key. In shadow mode (every cell's start) the decision model and the
// reviewer record what they would do and the call runs; rules and ask-first holds always enforce.
import type { OperatorClient } from "../client.ts";
import { CliError } from "../config.ts";
import type { Io } from "../io.ts";
import { dayTime } from "../text.ts";

type ModeAnswer = {
  person: string;
  mode: string;
  since: number | null;
  decisionModel: string;
  timeZone?: string;
  changed?: boolean;
};

const MODES = ["shadow", "enforce"];
const ADAPTERS = ["clef", "clef-flash", "jev"];

const USAGE =
  "usage: secbot mode show <person> | secbot mode set <person> shadow|enforce | secbot mode decision <person> clef|clef-flash|jev";

const route = (path: string, person: string) => `/ops/${path}?cell=${encodeURIComponent(person)}`;

export async function mode(
  client: () => Promise<OperatorClient>,
  io: Io,
  sub: string | undefined,
  args: readonly (string | undefined)[],
): Promise<number> {
  const [person, value] = args;
  if (person === undefined || person === "") throw new CliError(USAGE, 2);
  if (sub === "show" && value === undefined) {
    const answer = await (await client()).request<ModeAnswer>("GET", route("mode", person));
    const since =
      answer.since === null ? "" : `  since ${dayTime(answer.since, answer.timeZone ?? "UTC")}`;
    io.stdout(
      `${answer.person}  mode ${answer.mode}${since}  decision model ${answer.decisionModel}\n`,
    );
    return 0;
  }
  if (sub === "set" && value !== undefined) {
    if (!MODES.includes(value)) throw new CliError("the mode is shadow or enforce", 2);
    const answer = await (await client()).request<ModeAnswer>("PUT", route("mode", person), {
      mode: value,
    });
    const word = answer.changed === false ? "already runs" : "now runs";
    io.stdout(`${answer.person} ${word} in ${answer.mode} mode\n`);
    return 0;
  }
  if (sub === "decision" && value !== undefined) {
    if (!ADAPTERS.includes(value))
      throw new CliError("the decision model is clef, clef-flash, or jev", 2);
    const answer = await (await client()).request<ModeAnswer>(
      "PUT",
      route("decision-model", person),
      { adapter: value },
    );
    io.stdout(
      `${answer.person} now uses the ${answer.decisionModel} decision model from the next call\n`,
    );
    return 0;
  }
  throw new CliError(USAGE, 2);
}
