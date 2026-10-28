// `secbot model list`, `secbot model set <role> <model-id>`, and `secbot model cap <tier> <usd>`:
// the cell's role-to-model map, the job tiers among its roles, and each tier's per-job cap.
import type { CellClient } from "../client.ts";
import { CliError } from "../config.ts";
import type { Io } from "../io.ts";

type RoleModel = { role: string; model: string; source: string; capUsd?: number };

export async function modelList(client: CellClient, io: Io): Promise<number> {
  const { roles } = await client.request<{ roles: RoleModel[] }>("GET", "/models");
  const width = Math.max(...roles.map((entry) => entry.role.length));
  for (const entry of roles) {
    const cap = entry.capUsd === undefined ? "" : `  cap $${entry.capUsd} per job`;
    io.stdout(`${entry.role.padEnd(width)}  ${entry.model}  (${entry.source})${cap}\n`);
  }
  return 0;
}

export async function modelCap(
  client: CellClient,
  io: Io,
  tier?: string,
  usd?: string,
): Promise<number> {
  if (tier === undefined || usd === undefined) {
    throw new CliError("usage: secbot model cap <tier> <usd>", 2);
  }
  const changed = await client.request<{ tier: string; capUsd: number }>(
    "PUT",
    `/tiers/${encodeURIComponent(tier)}/cap`,
    { usd },
  );
  io.stdout(`${changed.tier} jobs now cap at $${changed.capUsd}\n`);
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
