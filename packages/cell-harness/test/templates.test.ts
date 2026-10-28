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
