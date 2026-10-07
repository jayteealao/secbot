// Local stand-in for the live session: the lead's answer streams in parts, and a follow-up that
// arrives while the session is open is sent without a new request; the delivered callback lets the
// cell advance the device's cursor.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "../src/session-stream.ts";
import {
  createFauxGateway,
  fauxAssistantMessage,
  fauxText,
  openTestCell,
  type TestCell,
  until,
} from "./fixtures.ts";
import { handoffResponder } from "./responders.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

describe("session frames", () => {
  it("streams the answer in parts, then relays a follow-up with no new request", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const gateway = createFauxGateway(handoffResponder, { tokensPerSecond: 8 });
    test = await openTestCell({ gateway });
    const frames: Frame[] = [];
    const delivered: number[] = [];
    const session = await test.cell.session(
      (frame) => frames.push(frame),
      (entryId) => {
        delivered.push(entryId);
      },
    );
    await (await test.cell.submit("Find out about fasting for me", "s-1")).wait(BACKGROUND_CONTEXT);
    await until(
      () =>
        frames.some((frame) => frame.type === "answer" && frame.text.startsWith("Research says")),
      20_000,
    );
    await session.stop();

    const kinds = frames.map((frame) => frame.type);
    expect(kinds).toContain("delta");
    const answers = frames.filter((frame) => frame.type === "answer" || frame.type === "followup");
    expect(answers.map((frame) => frame.type)).toEqual(["answer", "followup", "answer"]);
    expect(answers[1]).toMatchObject({
      from: "research",
      text: "research finding: evidence is mixed.",
    });
    expect(delivered).toHaveLength(3);
    expect((await test.cell.missed("never-connected")).messages).toHaveLength(3);
  }, 30_000);

  it("sends a long answer as several parts that add up to the answer", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const long = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
    const gateway = createFauxGateway(() => fauxAssistantMessage([fauxText(long)]), {
      tokensPerSecond: 30,
    });
    test = await openTestCell({ gateway });
    const frames: Frame[] = [];
    const session = await test.cell.session((frame) => frames.push(frame));
    await (await test.cell.submit("Tell me a long thing", "s-2")).wait(BACKGROUND_CONTEXT);
    await until(() => frames.some((frame) => frame.type === "answer"));
    await session.stop();
    const parts = frames.flatMap((frame) => (frame.type === "delta" ? [frame.text] : []));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(long);
    expect(frames.at(-1)).toMatchObject({ type: "answer", text: long });
  }, 30_000);
});
