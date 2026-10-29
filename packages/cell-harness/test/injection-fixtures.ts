/**
 * Fixture pages for the injection check (the clean and injected pages come from the library, so
 * the test cell reads the same ones), and a stand-in answer for the stub decisions route: it
 * finds the fixture order phrase in a chunk's content (a test double for the decision model, not
 * a detector).
 */
import { LIVE_FIXTURE_ORDER, LIVE_FIXTURE_PAGES } from "../src/fixture-pages.ts";
import { cleanAt, injectionAt, routineAt, type StubDecision } from "./stub-openrouter.ts";

/** The order every injected fixture page hides, addressed to the agent. */
export const FIXTURE_ORDER = LIVE_FIXTURE_ORDER;

/** About `bytes` of clean text: numbered paragraphs about a walking route. */
function cleanText(bytes: number): string {
  const paragraphs: string[] = [];
  let size = 0;
  for (let i = 1; size < bytes; i++) {
    const paragraph = `Stage ${i}: follow the river path past the old mill, then keep left at the stile; the stretch takes about twenty minutes at an easy pace.`;
    paragraphs.push(paragraph);
    size += paragraph.length + 1;
  }
  return paragraphs.join("\n");
}

/** The tail of a long page: the order sits in its last 300 bytes. */
const longTail = `${cleanText(12_000)}\n${FIXTURE_ORDER}`;

/** 60 KB: the order lies after byte 51,200, past what the check keeps. */
const overMax = (() => {
  const head = cleanText(52_000);
  const page = `${head}\n${FIXTURE_ORDER}\n${cleanText(60_000 - head.length - FIXTURE_ORDER.length - 2)}`;
  return page.slice(0, 60_000);
})();

/** The test cell's two pages (from the library), plus the long pages only tests read. */
export const FIXTURE_PAGES = {
  ...LIVE_FIXTURE_PAGES,
  "long-tail": longTail,
  "over-max": overMax,
} as const;

/**
 * The stub's answer for one decisions request: for the content question, injection when the chunk
 * holds the order; for the tool-call question, a routine call.
 */
export function standInDecide(body: Record<string, unknown>): StubDecision {
  const questions = (body.questions ?? {}) as Record<string, unknown>;
  if (!Object.hasOwn(questions, "injection")) return routineAt(0.05);
  const state = body.state as { content?: unknown } | undefined;
  return String(state?.content ?? "").includes(FIXTURE_ORDER) ? injectionAt(0.92) : cleanAt(0.04);
}
