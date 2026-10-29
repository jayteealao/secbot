// The command line refuses an over-long answer before it sends it; the cell refuses one too. The
// two limits must be the same number, or the command line sends answers the cell refuses.
import { JOB_ANSWER_MAX_CHARS } from "@secbot/cell-harness";
import { describe, expect, it } from "vitest";
import { JOB_ANSWER_LIMIT } from "../../cli/src/commands/job-answer.ts";

describe("job answer limit", () => {
  it("is the same on the command line and in the cell", () => {
    expect(JOB_ANSWER_LIMIT).toBe(JOB_ANSWER_MAX_CHARS);
  });
});
