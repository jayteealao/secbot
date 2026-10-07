/**
 * Where the CLI finds the cell and its device key. Nothing identifying is in the repo: the cell URL
 * comes from SECBOT_CELL_URL or the owner's config file, and the key lives in the owner's device
 * file (mode 0600). SECBOT_CONFIG_DIR moves both (tests).
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Environment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
}

export interface Device {
  readonly name: string;
  readonly person: string;
  readonly key: string;
}

export class CliError extends Error {
  // A plain field, not a parameter property: Node's type stripping accepts erasable syntax only.
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export const configDir = ({ env, home }: Environment) =>
  env.SECBOT_CONFIG_DIR ?? join(home, ".config", "secbot");

export const deviceFile = (environment: Environment) => join(configDir(environment), "device.json");

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CliError(`cannot read ${path}: ${(error as Error).message}`);
  }
}

export async function cellUrl(environment: Environment): Promise<string> {
  const fromEnv = environment.env.SECBOT_CELL_URL;
  const fromFile = (await readJson(join(configDir(environment), "config.json")))?.cellUrl;
  const url = fromEnv ?? (typeof fromFile === "string" ? fromFile : undefined);
  if (url === undefined || url === "") {
    throw new CliError(
      `no cell address: set SECBOT_CELL_URL in your shell or "cellUrl" in ${join(configDir(environment), "config.json")}`,
    );
  }
  if (!/^https?:\/\//.test(url))
    throw new CliError("the cell address must start with http:// or https://");
  return url.replace(/\/+$/, "");
}

export async function readDevice(environment: Environment): Promise<Device> {
  const value = await readJson(deviceFile(environment));
  if (
    value === undefined ||
    typeof value.name !== "string" ||
    typeof value.person !== "string" ||
    typeof value.key !== "string"
  ) {
    throw new CliError(
      `no device key: run "secbot device new <name>" first (${deviceFile(environment)})`,
    );
  }
  return { name: value.name, person: value.person, key: value.key };
}

export async function writeDevice(environment: Environment, device: Device): Promise<string> {
  const path = deviceFile(environment);
  await mkdir(configDir(environment), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(device, null, 2)}\n`, { mode: 0o600, flag: "wx" }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") {
        throw new CliError(`${path} already exists; remove it first to make a new device key`);
      }
      throw error;
    },
  );
  await chmod(path, 0o600);
  return path;
}
