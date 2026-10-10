// `secbot secrets list | grant | revoke | add | allowlist | rotate`: a person's own secrets and the
// owner's secrets settings. A person lists their secrets and grants or revokes one for one of their
// agents with the device key; the owner adds a secret, sets the allowlist, rotates the master key,
// and lists another person's secrets with the operator key. No command ever prints a value: `add`
// reads the value from standard input and prints only the name and the key id.
import type { CellClient, OperatorClient } from "../client.ts";
import { CliError } from "../config.ts";
import type { Io } from "../io.ts";
import { BROKER_KINDS } from "../secret-kinds.ts";
import { RULE } from "../text.ts";

interface Listing {
  readonly name: string;
  /** `secret`, or a broker kind. */
  readonly kind: string;
  readonly grants: readonly string[];
}

const USAGE = `usage: secbot secrets list [--person <name> (operator key)]
       secbot secrets grant <secret> <agent>
       secbot secrets revoke <secret> <agent>
       secbot secrets add --person <name> <secret> [--broker health|production --url <url> --header <name>]
       secbot secrets allowlist --person <name> add|remove <secret> <agent>
       secbot secrets rotate`;

export interface SecretsOptions {
  readonly person?: string | undefined;
  readonly broker?: string | undefined;
  readonly url?: string | undefined;
  readonly header?: string | undefined;
}

const ownerRoute = (path: string, person: string) =>
  `/ops/${path}?cell=${encodeURIComponent(person)}`;

/** The list of one person's secrets: name, kind, and the agents it is granted to. */
export function listLines(person: string, secrets: readonly Listing[]): string[] {
  const lines = [`SECRETS  ${person}`, RULE];
  if (secrets.length === 0) return [...lines, "no secrets yet"];
  lines.push(`${"NAME".padEnd(18)}${"KIND".padEnd(13)}GRANTED TO`);
  for (const secret of secrets) {
    const grants = secret.grants.length === 0 ? "-" : secret.grants.join(", ");
    lines.push(`${`${secret.name}  `.padEnd(18)}${`${secret.kind}  `.padEnd(13)}${grants}`);
  }
  return lines;
}

/** The value typed or piped on standard input, without its final line break. */
async function readValue(io: Io): Promise<string> {
  const lines: string[] = [];
  for await (const line of io.lines()) lines.push(line);
  const value = lines.join("\n");
  if (value === "") throw new CliError("send the secret's value on standard input", 2);
  return value;
}

export async function secrets(
  device: () => Promise<CellClient>,
  operator: () => Promise<OperatorClient>,
  io: Io,
  sub: string | undefined,
  args: readonly (string | undefined)[],
  options: SecretsOptions,
): Promise<number> {
  const [first, second, third] = args;
  const brokerFlags = [options.broker, options.url, options.header].filter((v) => v !== undefined);
  if (sub !== "add" && brokerFlags.length > 0) throw new CliError(USAGE, 2);

  if (sub === "list" && first === undefined) {
    const answer =
      options.person === undefined
        ? await (await device()).request<{ person: string; secrets: Listing[] }>("GET", "/secrets")
        : await (await operator()).request<{ person: string; secrets: Listing[] }>(
            "GET",
            ownerRoute("secrets", options.person),
          );
    io.stdout(`${listLines(answer.person, answer.secrets).join("\n")}\n`);
    return 0;
  }

  if ((sub === "grant" || sub === "revoke") && first !== undefined && second !== undefined) {
    if (third !== undefined || options.person !== undefined) throw new CliError(USAGE, 2);
    await (await device()).request(sub === "grant" ? "POST" : "DELETE", "/secrets/grants", {
      secret: first,
      agent: second,
    });
    io.stdout(`[ ${sub === "grant" ? "granted" : "revoked"} ] ${first} -> ${second}\n`);
    return 0;
  }

  if (sub === "add" && first !== undefined && second === undefined) {
    if (options.person === undefined) throw new CliError(USAGE, 2);
    if (brokerFlags.length !== 0 && brokerFlags.length !== 3) {
      throw new CliError("a broker secret takes --broker, --url, and --header together", 2);
    }
    if (options.broker !== undefined && !BROKER_KINDS.includes(options.broker)) {
      throw new CliError("the broker is health or production", 2);
    }
    const value = await readValue(io);
    const broker =
      options.broker === undefined
        ? undefined
        : { kind: options.broker, url: options.url, header: options.header };
    const answer = await (await operator()).request<{ keyId: string }>(
      "PUT",
      ownerRoute("secrets", options.person),
      { name: first, value, ...(broker === undefined ? {} : { broker }) },
    );
    const tail = broker === undefined ? "" : "; used only through the broker";
    io.stdout(`[ stored ] ${first} for ${options.person} under key ${answer.keyId}${tail}\n`);
    return 0;
  }

  if (sub === "allowlist" && (first === "add" || first === "remove")) {
    const agent = args[2];
    if (options.person === undefined || second === undefined || agent === undefined) {
      throw new CliError(USAGE, 2);
    }
    if (args[3] !== undefined) throw new CliError(USAGE, 2);
    const answer = await (await operator()).request<{ revoked?: boolean }>(
      first === "add" ? "PUT" : "DELETE",
      ownerRoute("secrets/allowlist", options.person),
      { secret: second, agent },
    );
    const line = `${options.person} ${second} -> ${agent}`;
    if (first === "add") io.stdout(`[ allowed ] ${line}\n`);
    else
      io.stdout(`[ removed ] ${line}${answer.revoked === true ? "; its grant was revoked" : ""}\n`);
    return 0;
  }

  if (sub === "rotate" && first === undefined && options.person === undefined) {
    const answer = await (await operator()).request<{
      from: string;
      keyId: string;
      rewrapped: number;
      remaining: number;
    }>("POST", "/ops/secrets/rotate", {});
    io.stdout(
      `[ rotated ] ${answer.rewrapped} secrets re-wrapped under key ${answer.keyId}; ${answer.remaining} left under ${answer.from}\n`,
    );
    return 0;
  }

  throw new CliError(USAGE, 2);
}
