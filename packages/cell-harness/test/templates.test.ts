// Release defaults of the job model: tiers, their models and caps, efforts, the four templates,
// the 30-minute wake, the lead's instructions, and the guard table entries of start_job.
import { describe, expect, it } from "vitest";
import {
  ALWAYS_KEY_FIELD,
  DEFAULT_JOB_EFFORT,
  DEFAULT_PERSON_RULES,
  JOB_EFFORTS,
  JOB_TEMPLATES,
  LEAD_INSTRUCTIONS,
  MARK_THRESHOLDS,
  RESULT_WAKE_MS,
  TIER_CAPS_USD,
  TIER_MODELS,
  TIERS,
} from "../src/release-defaults.ts";
import {
  appliedEffort,
  capOf,
  isEffort,
  isTier,
  templateNamed,
  templatesOf,
  tierModelOf,
} from "../src/templates.ts";
import { createFauxGateway } from "./fixtures.ts";

describe("release defaults of the job model", () => {
  it("names three tiers with their models and caps", () => {
    expect(TIERS).toEqual(["cheap", "mid", "frontier"]);
    expect(TIER_MODELS).toEqual({
      cheap: "anthropic/claude-haiku-4.5",
      mid: "anthropic/claude-sonnet-5.5",
      frontier: "anthropic/claude-opus-5.5",
    });
    expect(TIER_CAPS_USD).toEqual({ cheap: 0.25, mid: 1, frontier: 3 });
  });

  it("names three efforts with medium as the default", () => {
    expect(JOB_EFFORTS).toEqual(["low", "medium", "high"]);
    expect(DEFAULT_JOB_EFFORT).toBe("medium");
  });

  it("ships four templates with their start tiers and no tool to start agents", () => {
    expect(JOB_TEMPLATES.map((template) => [template.name, template.tier])).toEqual([
      ["household", "cheap"],
      ["research", "mid"],
      ["health", "mid"],
      ["developer", "frontier"],
    ]);
    for (const template of JOB_TEMPLATES) {
      expect(template.instruction).toContain(`You are the ${template.name} specialist`);
      expect(template.instruction).toContain("no tool to start other agents");
      expect(template.instruction).toContain("ask the lead in your answer");
    }
  });

  it("wakes the lead for a routine result after 30 minutes", () => {
    expect(RESULT_WAKE_MS).toBe(30 * 60_000);
  });

  it("tells the lead when to start a job, how to say so, and how to resume", () => {
    expect(LEAD_INSTRUCTIONS).toContain("You are the lead agent");
    expect(LEAD_INSTRUCTIONS).toContain("start_job");
    expect(LEAD_INSTRUCTIONS).toContain("On it: <task> (job <n>, <template>, <tier>)");
    expect(LEAD_INSTRUCTIONS).toContain("job_result");
    expect(LEAD_INSTRUCTIONS).toContain("resume_work");
    expect(LEAD_INSTRUCTIONS).toContain("reminders");
    expect(LEAD_INSTRUCTIONS).not.toContain("handoff tool");
  });

  it("guards start_job like the hand-off it replaces, and keeps the hand-off entries", () => {
    expect(MARK_THRESHOLDS.start_job).toBe(0.5);
    expect(MARK_THRESHOLDS.handoff).toBe(0.5);
    expect(ALWAYS_KEY_FIELD.start_job).toBe("template");
    expect(ALWAYS_KEY_FIELD.handoff).toBe("specialist");
    expect(DEFAULT_PERSON_RULES).toContainEqual({
      agent: "all",
      tool: "start_job",
      verdict: "permit",
    });
    expect(DEFAULT_PERSON_RULES).toContainEqual({
      agent: "all",
      tool: "handoff",
      verdict: "permit",
    });
  });
});

describe("template and tier resolution", () => {
  const clamping = {
    getModel: (_provider: string, id: string) =>
      id === "clamps/low"
        ? ({ id, reasoning: true, thinkingLevelMap: { low: null } } as never)
        : id === "plain/model"
          ? ({ id, reasoning: true } as never)
          : undefined,
  };

  it("merges custom templates after the release ones, never replacing one", () => {
    const templates = templatesOf({
      travel: { instruction: "You are the travel specialist.", tier: "cheap" },
      research: { instruction: "ignored", tier: "frontier" },
    });
    expect(templates.map((template) => template.name)).toEqual([
      "household",
      "research",
      "health",
      "developer",
      "travel",
    ]);
    expect(templates.find((each) => each.name === "research")?.tier).toBe("mid");
  });

  it("refuses an unknown template with the valid names", () => {
    expect(templateNamed(templatesOf(), "astrology")).toEqual({
      error: "No template named astrology. Templates: household, research, health, developer.",
    });
    expect(templateNamed(templatesOf(), "health")).toMatchObject({ name: "health", tier: "mid" });
  });

  it("reads a tier's model and cap from the owner's changes, else the release", () => {
    expect(tierModelOf("mid")).toBe("anthropic/claude-sonnet-5.5");
    expect(tierModelOf("mid", { mid: "openai/gpt-5" })).toBe("openai/gpt-5");
    expect(capOf("cheap")).toBe(0.25);
    expect(capOf("frontier", { frontier: 5 })).toBe(5);
  });

  it("applies the effort the model supports: low clamps up to medium", () => {
    expect(appliedEffort(clamping, "clamps/low", "low")).toBe("medium");
    expect(appliedEffort(clamping, "clamps/low", "high")).toBe("high");
    expect(appliedEffort(clamping, "plain/model", "low")).toBe("low");
    expect(appliedEffort(clamping, "unknown/model", "high")).toBe("high");
  });

  it("knows tiers and efforts", () => {
    expect(isTier("mid")).toBe(true);
    expect(isTier("huge")).toBe(false);
    expect(isEffort("low")).toBe(true);
    expect(isEffort("max")).toBe(false);
  });
});

describe("the faux tier models of the test cell", () => {
  it("reason, and the cheap one clamps low effort up to medium", () => {
    const gateway = createFauxGateway();
    expect(appliedEffort(gateway.models, TIER_MODELS.cheap, "low")).toBe("medium");
    expect(appliedEffort(gateway.models, TIER_MODELS.mid, "low")).toBe("low");
    expect(appliedEffort(gateway.models, TIER_MODELS.frontier, "high")).toBe("high");
  });
});
