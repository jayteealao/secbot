/**
 * Job templates and tiers: the release templates plus the owner's custom ones, a tier's model
 * (the release default unless the owner changed it in the role-to-model map, keyed by the tier's
 * name), a tier's per-job cap, and the effort a model applies after pi-ai clamps the request.
 */
import { clampThinkingLevel, type Models, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { JOB_EFFORTS, TIERS } from "./household-contract.ts";
import {
  GATEWAY_PROVIDER,
  JOB_TEMPLATES,
  type JobEffort,
  type JobTemplate,
  TIER_CAPS_USD,
  TIER_MODELS,
  type Tier,
} from "./release-defaults.ts";

/** An owner's template: its instruction and the tier its jobs start on. */
export type CustomTemplate = { instruction: string; tier: Tier };

export const isTier = (value: unknown): value is Tier =>
  typeof value === "string" && (TIERS as readonly string[]).includes(value);

export const isEffort = (value: unknown): value is JobEffort =>
  typeof value === "string" && (JOB_EFFORTS as readonly string[]).includes(value);

/** The release templates, then each custom one (a custom template never replaces a release one). */
export function templatesOf(custom: Readonly<Record<string, CustomTemplate>> = {}): JobTemplate[] {
  const release = new Set(JOB_TEMPLATES.map((template) => template.name));
  return [
    ...JOB_TEMPLATES,
    ...Object.entries(custom)
      .filter(([name]) => !release.has(name))
      .map(([name, template]) => ({
        name,
        instruction: template.instruction,
        tier: template.tier,
      })),
  ];
}

/** The template named `name`, or an error text naming the valid ones. */
export function templateNamed(
  templates: readonly JobTemplate[],
  name: string,
): JobTemplate | { readonly error: string } {
  const found = templates.find((template) => template.name === name);
  return (
    found ?? {
      error: `No template named ${name}. Templates: ${templates.map((each) => each.name).join(", ")}.`,
    }
  );
}

/** A tier's model: the owner's change in the role-to-model map, else the release model. */
export function tierModelOf(tier: Tier, overrides: Readonly<Record<string, string>> = {}): string {
  return Object.hasOwn(overrides, tier) ? (overrides[tier] as string) : TIER_MODELS[tier];
}

/** A tier's per-job cap in USD: the owner's change, else the release cap. */
export function capOf(tier: Tier, settings: Readonly<Record<string, number>> = {}): number {
  return Object.hasOwn(settings, tier) ? (settings[tier] as number) : TIER_CAPS_USD[tier];
}

/**
 * The effort a model applies for `requested`: pi-ai's `clampThinkingLevel` moves an unsupported
 * level up first, then down (installed pi-ai 1.0.3 dist/models.js:690-709). An unknown model
 * applies the request unchanged; the gateway refuses it at the request anyway.
 */
export function appliedEffort(
  models: Pick<Models, "getModel">,
  modelId: string,
  requested: JobEffort,
): ModelThinkingLevel {
  const model = models.getModel(GATEWAY_PROVIDER, modelId);
  return model === undefined ? requested : clampThinkingLevel(model, requested);
}
