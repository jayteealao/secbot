/**
 * The lead's tools for household jobs: proposing a job both people share, and giving the person an
 * offer the other person made. The household runs a shared job; these only queue its operations.
 */
import { type Models, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { logEvent } from "./cell-parts.ts";
import { RoleModelsDoc, StopDoc, TemplatesDoc, TierSettingsDoc } from "./docs.ts";
import { isSharedTitle, JOB_EFFORTS, TIERS } from "./household-contract.ts";
import { createSharedRow } from "./job-board.ts";
import {
  ISO_DATE,
  jobParameter,
  literals,
  offerText,
  proposedText,
  refusal,
  rowOrError,
  text,
} from "./lead-texts.ts";
import { DEFAULT_JOB_EFFORT } from "./release-defaults.ts";
import { sharedOpId } from "./shared-relay.ts";
import { STOP_RUNNING } from "./stop.ts";
import { appliedEffort, capOf, templateNamed, templatesOf, tierModelOf } from "./templates.ts";

export interface SharedLeadToolsDeps {
  readonly person: string;
  readonly now: () => number;
  readonly models: () => Models;
  /** The other person and the background exchange; undefined in a cell with no household. */
  readonly shared?: () => { readonly other: string; kick(): void } | undefined;
}

export function createSharedLeadTools(deps: SharedLeadToolsDeps) {
  const { person } = deps;
  const proposeSharedJob = defineTool({
    name: "propose_shared_job",
    description:
      "Propose a job that belongs to both people in the household: the household agent runs it, and the other person's lead asks them first; only their yes starts it, and the cost splits evenly. Write a self-contained brief for both people. Returns at once.",
    parameters: Type.Object({
      title: Type.String({
        minLength: 1,
        maxLength: 80,
        description: "A few words on the job, on one line with no brackets.",
      }),
      brief: Type.String({ minLength: 1, maxLength: 8_000, description: "The brief, for both." }),
      priority: Type.Optional(
        literals(["urgent", "deadline", "routine", "research"] as const, "Default routine."),
      ),
      deadline: Type.Optional(
        Type.String({ description: "The date both people need it by, as YYYY-MM-DD." }),
      ),
      tier: Type.Optional(literals(TIERS, "Default: the household template's tier.")),
      effort: Type.Optional(literals(JOB_EFFORTS, `Default ${DEFAULT_JOB_EFFORT}.`)),
    }),
    // A crash mid-call gives the model an interrupted result instead of a second proposal.
    replay: "unsafe",
    execute: async (args, api, context) => {
      const shared = deps.shared?.();
      if (shared === undefined) return refusal("This cell has no household to share a job with.");
      // The household refuses such a title: the other lead reads it inside a bracketed notice.
      if (!isSharedTitle(args.title)) {
        return refusal("Write the title on one line with no brackets.");
      }
      if (args.deadline !== undefined && !ISO_DATE.test(args.deadline)) {
        return refusal(`The deadline "${args.deadline}" is not a date like 2026-11-30.`);
      }
      const now = deps.now();
      const proposed = await api.commit(async (tx) => {
        if ((await tx.doc(StopDoc)).active !== null) return { error: STOP_RUNNING };
        const template = templateNamed(
          templatesOf((await tx.doc(TemplatesDoc)).custom),
          "household",
        );
        if ("error" in template) return template;
        const tier = args.tier ?? template.tier;
        const requested = args.effort ?? DEFAULT_JOB_EFFORT;
        const cap = capOf(tier, (await tx.doc(TierSettingsDoc)).caps);
        // The other person agrees to the most the job can cost them: the estimate is the tier's
        // cap, never a lower figure, because their half of the real cost is charged up to it.
        const estimate = cap;
        const row = await createSharedRow(tx, {
          title: args.title.trim(),
          brief: args.brief,
          priority: args.priority ?? (args.deadline === undefined ? "routine" : "deadline"),
          deadline: args.deadline ?? null,
          tier,
          effort: {
            requested,
            applied: appliedEffort(
              deps.models(),
              tierModelOf(tier, (await tx.doc(RoleModelsDoc)).overrides),
              requested,
            ),
          },
          owner: person,
          createdAt: now,
          shared: {
            household: null,
            role: "requester",
            with: shared.other,
            consent: "asking",
            payer: "half",
            estimateUsd: estimate,
            outbox: [],
            charges: [],
            resultAt: null,
            waitingBudget: false,
          },
        });
        row.status = "waiting";
        row.shared?.outbox.push({
          kind: "propose",
          opId: sharedOpId(person, now),
          person,
          other: shared.other,
          local: row.number,
          title: row.title,
          brief: row.brief,
          priority: row.priority,
          deadline: row.deadline,
          tier,
          effort: requested,
          estimateUsd: estimate,
        });
        return { number: row.number, tier, estimate };
      }, context);
      if ("error" in proposed) return refusal(proposed.error);
      shared.kick();
      logEvent("shared.proposed", {
        cell: person,
        job: proposed.number,
        tier: proposed.tier,
        estimate_usd: proposed.estimate,
      });
      return {
        ...text(proposedText(proposed.number, shared.other)),
        details: { job: proposed.number },
      };
    },
  });

  const offerShared = defineTool({
    name: "offer_shared",
    description:
      "Give the person a shared job the other person proposed: then ask them in your own words whether to share the cost. Their /join or /decline goes to the household, never to you.",
    parameters: Type.Object({ job: jobParameter }),
    replay: "safe",
    execute: async (args, api, context) => {
      const shown = await api.commit(async (tx) => {
        const row = await rowOrError(tx, args.job);
        if ("error" in row) return row;
        const consent = row.shared?.role === "other" ? row.shared.consent : null;
        if (consent !== "offered" && consent !== "shown") {
          return { error: `job ${args.job} is not a shared offer waiting for the person.` };
        }
        if (row.shared !== null) row.shared.consent = "shown";
        return { number: row.number };
      }, context);
      if ("error" in shown) return refusal(shown.error);
      return { ...text(offerText(shown.number)), details: { job: shown.number } };
    },
  });

  return { proposeSharedJob, offerShared };
}
