import { ADAPTER_NAME } from "@secbot/cell-storage";

/** Set by scripts/build-bundle.mjs (esbuild `define`); absent when the source runs unbundled. */
declare const __SECBOT_VERSION__: string | undefined;

export const releaseVersion = (): string =>
  typeof __SECBOT_VERSION__ === "string" ? __SECBOT_VERSION__ : "0.0.0-dev";

/** GET /health: the release version and the storage driver this bundle uses. */
export const health = (): Response =>
  Response.json({ version: releaseVersion(), adapter: ADAPTER_NAME });
