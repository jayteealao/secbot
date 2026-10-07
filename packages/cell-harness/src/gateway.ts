/**
 * The model gateway: one OpenRouter provider, one key.
 *
 * pi-ai's OpenRouter provider resolves its key through `envApiKeyAuth(..., ["OPENROUTER_API_KEY"])`,
 * which reads the `AuthContext` given to `createModels({ authContext })`
 * (source: pi-ai v1.0.3 src/providers/openrouter.ts:10-20, src/auth/helpers.ts:9-30,
 * src/models.ts:367-401). A cell has no process environment; its key is the cell var of the same
 * name, filled on the VPS at deploy time and never in the repo.
 */
import type { MutableModels, Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { withCreditPause } from "./credit-pause.ts";

export interface GatewayEnv {
  readonly OPENROUTER_API_KEY?: string;
  /** Tests only: a local stub's origin, replacing https://openrouter.ai. */
  readonly OPENROUTER_BASE_URL?: string;
}

export function createGatewayModels(env: GatewayEnv, base: Provider = openrouterProvider()) {
  const models: MutableModels = createModels({
    authContext: {
      env: async (name) =>
        name === "OPENROUTER_API_KEY" && env.OPENROUTER_API_KEY
          ? env.OPENROUTER_API_KEY
          : undefined,
      fileExists: async () => false,
    },
  });
  const baseUrl = env.OPENROUTER_BASE_URL ? env.OPENROUTER_BASE_URL : undefined;
  models.setProvider(withCreditPause(base, baseUrl));
  return models;
}
