// `secbot model list` and `secbot model set <role> <model-id>`: the cell's role-to-model map.
import type { CellClient } from "../client.ts";
import { CliError } from "../config.ts";
import type { Io } from "../io.ts";

type RoleModel = { role: string; model: string; source: string };

export async function modelList(client: CellClient, io: Io): Promise<number> {
  const { roles } = await client.request<{ roles: RoleModel[] }>("GET", "/models");
  const width = Math.max(...roles.map((entry) => entry.role.length));
  for (const entry of roles)
    io.stdout(`${entry.role.padEnd(width)}  ${entry.model}  (${entry.source})\n`);
  return 0;
}

export async function modelSet(
  client: CellClient,
  io: Io,
  role?: string,
  model?: string,
): Promise<number> {
  if (role === undefined || model === undefined) {
    throw new CliError("usage: secbot model set <role> <model-id>", 2);
  }
  const changed = await client.request<RoleModel>("PUT", `/models/${encodeURIComponent(role)}`, {
    model,
  });
  io.stdout(`${changed.role} now uses ${changed.model} from its next turn\n`);
  return 0;
}
