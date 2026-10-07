import { ADAPTER_NAME } from "@secbot/cell-storage";

/** Set by scripts/build-bundle.mjs (esbuild `define`); absent when the source runs unbundled. */
declare const __SECBOT_VERSION__: string | undefined;
declare const __SECBOT_CONTRACT_STEP__: number | undefined;

export const releaseVersion = (): string =>
  typeof __SECBOT_VERSION__ === "string" ? __SECBOT_VERSION__ : "0.0.0-dev";

/** The bundle's contract step (scripts/build-bundle.mjs CONTRACT_STEP); 3 when unbundled. */
export const contractStep = (): number =>
  typeof __SECBOT_CONTRACT_STEP__ === "number" ? __SECBOT_CONTRACT_STEP__ : 3;

export type CellHealth =
  | { readonly status: "up"; readonly version: string; readonly roles: readonly string[] }
  | { readonly status: "down"; readonly reason: string };

/**
 * GET /health: the release version and the storage driver this bundle uses; with
 * `?cells=owner,second`, also each named cell's status, read by waking it.
 */
export async function health(
  url: URL,
  cellStatus: (person: string) => Promise<CellHealth>,
): Promise<Response> {
  const requested = url.searchParams.get("cells");
  if (requested === null)
    return Response.json({ version: releaseVersion(), adapter: ADAPTER_NAME });
  const cells: Record<string, CellHealth> = {};
  for (const person of requested
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)) {
    try {
      cells[person] = await cellStatus(person);
    } catch (error) {
      cells[person] = {
        status: "down",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return Response.json({ version: releaseVersion(), adapter: ADAPTER_NAME, cells });
}
