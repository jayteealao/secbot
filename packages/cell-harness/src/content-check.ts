/**
 * The content check: every web page, mail, or file a job reads is checked by the decision model
 * before the job's conversation keeps it. Long content is cut at the check's maximum and split into
 * overlapping chunks, every chunk is checked, and a hit, a timeout, or an error stops the job: the
 * check fails closed, in every guard mode.
 */
import type { Context } from "@earendil-works/chord";
import { withoutAbortSignal } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  defineExtension,
  type Extension,
  type Harness,
  hook,
  ROOT_CONVERSATION_ID,
  type TaskId,
  type ToolExecutionResult,
  type ToolRegistration,
  ToolTask,
  type Wrap,
  wrapTool,
} from "@earendil-works/pi-durable";
import { errorFields, logEvent } from "./cell-parts.ts";
import {
  buildContentState,
  DecisionFailure,
  type DecisionModel,
  type DecisionModels,
} from "./decision-model.ts";
import { type JobBlock, JobBoardDoc } from "./docs.ts";
import { readDecisionAdapter } from "./guard-settings.ts";
import { blockReason, blockRow, markOutside } from "./job-board.ts";
import { addGuardUsage } from "./month-ledger.ts";
import { readingKindOf } from "./outside-tools.ts";
import {
  CONTENT_CHECK_MAX_BYTES,
  CONTENT_CHECK_PARALLEL,
  CONTENT_CHUNK_BYTES,
  CONTENT_CHUNK_OVERLAP_BYTES,
  OUTSIDE_CONTENT_TOOLS,
  type OutsideKind,
} from "./release-defaults.ts";
import { jobOf } from "./telemetry.ts";

/** A chunk's size as written into the decision request: its JSON-escaped UTF-8 bytes. */
export function requestBytes(text: string): number {
  return new TextEncoder().encode(JSON.stringify(text)).length - 2;
}

const encoder = new TextEncoder();

/** One code point's size in the request (a quote, a backslash, or a control character grows). */
function pointBytes(point: string): number {
  const code = point.codePointAt(0) ?? 0;
  if (code === 0x22 || code === 0x5c) return 2;
  if (code < 0x20) return JSON.stringify(point).length - 2;
  return encoder.encode(point).length;
}

export interface ChunkSizes {
  /** The largest chunk, in request bytes. */
  readonly chunkBytes: number;
  /** How far each chunk after the first starts before the previous one ends, in request bytes. */
  readonly overlapBytes: number;
  /** Content past this many UTF-8 bytes is cut before it is checked, and never kept. */
  readonly maxBytes: number;
}

export interface Chunks {
  readonly chunks: string[];
  /** Where each chunk starts in `checkedText` (UTF-16 offsets). */
  readonly starts: number[];
  /** The text that is checked and kept: the content cut to `maxBytes` on a code-point edge. */
  readonly checkedText: string;
  /** True when content past `maxBytes` was cut. */
  readonly cut: boolean;
}

/**
 * Cuts the text at `maxBytes` and splits what is kept into chunks that cover every character of it:
 * each chunk at most `chunkBytes`, each after the first starting up to `overlapBytes` before the
 * previous one ends (so a short sentence across a boundary is whole in one chunk), and only on
 * code-point edges. An empty text is one empty chunk.
 */
export function chunkContent(text: string, sizes: ChunkSizes): Chunks {
  const points: string[] = [];
  const offsets: number[] = [];
  let kept = 0;
  let offset = 0;
  let cut = false;
  for (const point of text) {
    const size = encoder.encode(point).length;
    if (kept + size > sizes.maxBytes) {
      cut = true;
      break;
    }
    kept += size;
    points.push(point);
    offsets.push(offset);
    offset += point.length;
  }
  const checkedText = text.slice(0, offset);
  offsets.push(offset);
  if (points.length === 0) return { chunks: [""], starts: [0], checkedText, cut };

  const costs = points.map(pointBytes);
  const chunks: string[] = [];
  const starts: number[] = [];
  let start = 0;
  for (;;) {
    let end = start;
    let size = 0;
    while (end < points.length && size + (costs[end] ?? 0) <= sizes.chunkBytes) {
      size += costs[end] ?? 0;
      end++;
    }
    // A single code point larger than a chunk still goes alone (never split, never skipped).
    if (end === start) end++;
    const from = offsets[start] ?? 0;
    starts.push(from);
    chunks.push(checkedText.slice(from, offsets[end]));
    if (end >= points.length) break;
    // The next chunk starts as far back as the overlap allows, and always after this start.
    let next = end;
    let back = 0;
    while (next - 1 > start && back + (costs[next - 1] ?? 0) <= sizes.overlapBytes) {
      next--;
      back += costs[next] ?? 0;
    }
    start = next;
  }
  return { chunks, starts, checkedText, cut };
}

/** One read of outside content to check: its kind, the reading tool, and the text. */
export interface ContentRead {
  readonly kind: OutsideKind;
  readonly tool: string;
  readonly text: string;
}

interface Checked {
  /** How many chunks the kept text has. */
  readonly chunks: number;
  readonly checkedText: string;
  readonly cut: boolean;
  /** What the answers cost, failed ones included. */
  readonly costUsd: number;
  readonly usages: Usage[];
}

/** The check's verdict on one read: clean, or why it stops the job and at which chunk. */
export type ContentVerdict =
  | (Checked & { readonly outcome: "clean" })
  | (Checked & {
      readonly outcome: "hit" | "timeout" | "error";
      /** The chunk that answered (from 0), or null when the check failed before any chunk. */
      readonly chunk: number | null;
      /** The answer's choice for a hit, the failure's cause, or `thrown`. */
      readonly cause: string;
    });

type Stop = { outcome: "hit" | "timeout" | "error"; chunk: number | null; cause: string };

/** The note after content that was cut at the check's maximum. */
export const CUT_NOTE = "\n[secbot: the rest was cut at 50 KB and not read]";

/**
 * The sizes a job's read is checked with: the kept text and the cut note together stay within
 * the check's maximum, which is also pi-durable's default bound on a result, so the bound never
 * cuts the kept text again (it would drop the note).
 */
export const READ_SIZES: ChunkSizes = {
  chunkBytes: CONTENT_CHUNK_BYTES,
  overlapBytes: CONTENT_CHUNK_OVERLAP_BYTES,
  maxBytes: CONTENT_CHECK_MAX_BYTES - encoder.encode(CUT_NOTE).length,
};

/** The abort reason of a signal, as an error to throw. */
const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The content check was aborted", "AbortError");

/**
 * Checks one read: the kept text's chunks are asked, `parallel` at a time; the first answer that is
 * not clean ends the others (their aborts are not failures). A hit stops with the chunk; a timeout
 * stops as `timeout`; any other failure or throw stops as `error`. An abort of `signal` is thrown.
 */
export async function checkContent(
  model: DecisionModel,
  read: ContentRead,
  signal?: AbortSignal,
  sizes: ChunkSizes = READ_SIZES,
  parallel: number = CONTENT_CHECK_PARALLEL,
): Promise<ContentVerdict> {
  if (signal?.aborted) throw abortError(signal);
  const { chunks, checkedText, cut } = chunkContent(read.text, sizes);
  const inner = new AbortController();
  const onAbort = () => inner.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  let stop: Stop | null = null;
  let costUsd = 0;
  const usages: Usage[] = [];
  let next = 0;
  const worker = async () => {
    while (stop === null && !inner.signal.aborted) {
      const index = next++;
      if (index >= chunks.length) return;
      try {
        const state = buildContentState({
          kind: read.kind,
          tool: read.tool,
          index,
          of: chunks.length,
          text: chunks[index] ?? "",
        });
        const answer = await model.checkContent(state, inner.signal);
        costUsd += answer.costUsd;
        if (answer.usage !== undefined) usages.push(answer.usage);
        if (answer.outcome !== "clean")
          stop ??= { outcome: "hit", chunk: index, cause: answer.choice };
      } catch (error) {
        if (error instanceof DecisionFailure) {
          costUsd += error.costUsd;
          if (error.usage !== undefined) usages.push(error.usage);
        }
        // An abort after another chunk's stop, or the outer abort, is not this chunk's failure.
        if (stop !== null || signal?.aborted) return;
        stop =
          error instanceof DecisionFailure
            ? {
                outcome: error.cause === "timeout" ? "timeout" : "error",
                chunk: index,
                cause: error.cause,
              }
            : { outcome: "error", chunk: index, cause: "thrown" };
      }
      if (stop !== null) inner.abort();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(parallel, chunks.length) }, worker));
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (signal?.aborted) throw abortError(signal);
  const checked = { chunks: chunks.length, checkedText, cut, costUsd, usages };
  // The workers set `stop`; flow analysis does not follow closures.
  const found = stop as Stop | null;
  return found === null ? { outcome: "clean", ...checked } : { ...found, ...checked };
}

/**
 * Decorates each reading tool. On a job's conversation, the tool's own commit marks the job as
 * having read outside content before the tool runs (so a crash or a failed read still leaves the
 * mark). In every conversation, the tool's progress output, details, and diagnostics are dropped:
 * they would reach the conversation's live slot, which a crash or an abort turns into a result
 * without the check. The result itself is checked after the tool returns.
 */
export function contentCheckWraps(
  person: string,
  readers: Readonly<Record<string, OutsideKind>>,
  now: () => number,
): Wrap[] {
  return Object.entries(readers).map(([name, kind]) =>
    // Only the name of the first argument is read: the wrapper decorates whichever tool won.
    wrapTool({ name } as ToolRegistration, (inner) => ({
      ...inner,
      execute: async (args, api, context) => {
        const n = await jobOf(api, api.conversationId, context);
        if (n !== null) {
          const marked = await api.commit(
            (tx) => markOutside(tx, n, api.conversationId, name, kind, now()),
            context,
          );
          if (marked) {
            logEvent("job.outside_marked", { cell: person, job: n, source: kind, tool: name });
          }
        }
        const silent = {
          ...api,
          output: () => {},
          diagnostic: () => {},
          details: async () => {},
        };
        return inner.execute(args, silent, context);
      },
    })),
  );
}

/** What a job's conversation keeps in place of content the check stopped. */
export const WITHHELD_TEXT = "[secbot: this content was withheld; the job is stopped]";

/** The lead's wake notice for a blocked job. */
export const blockedNotice = (n: number, block: JobBlock): string =>
  `[job ${n} blocked: ${blockReason(block)}; read it with job_result]`;

const withheld = (): ToolExecutionResult => ({
  content: [{ type: "text", text: WITHHELD_TEXT }],
  isError: true,
  diagnostics: [],
});

/** The size a stop logs when the check failed before it measured the content. */
const UNKNOWN_SIZE = { chunks: 0, contentBytes: 0 };

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

export interface ContentCheckDeps {
  readonly person: string;
  readonly harness: () => Harness;
  /** The decision models by adapter; the cell's current adapter answers (as for the guard). */
  readonly decision: DecisionModels;
  /** Reading tools the cell declares beside the release table. */
  readonly readers: Readonly<Record<string, OutsideKind>>;
  readonly now: () => number;
}

/**
 * The text a reading tool returned, as one string: every text part (an error result too). A part
 * that is not text cannot be checked, so it gives null. An error result with no text is read
 * from its error diagnostics, which may quote the outside source.
 */
function resultText(result: ToolExecutionResult): string | null {
  const parts = result.content ?? [];
  if (parts.some((part) => part.type !== "text")) return null;
  const text = parts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
  if (text !== "" || result.isError !== true) return text;
  return (result.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.message)
    .join("\n");
}

/**
 * The content check on job conversations: the reading tools' wraps (`contentCheckWraps`) and an
 * `afterTool` hook that checks a reading tool's result before the conversation keeps it. It never
 * reads the guard mode: it stops a job in shadow mode too. A clean result is kept as its checked
 * text only (no details or diagnostics). Anything else (a hit, a timeout, an error, a part that is
 * not text, or any throw but an abort) blocks the job in one commit, tells the lead once, stops
 * the job's task, and keeps only a withheld line.
 */
export function createContentCheckExtension(deps: ContentCheckDeps): Extension {
  const { person, harness, now } = deps;
  const readers = { ...OUTSIDE_CONTENT_TOOLS, ...deps.readers };

  /**
   * Blocks the job's current run in one commit (with the check's usage), tells the lead once, and
   * stops the job's task once this read's tool task has settled with the withheld line (an abort
   * now would settle the read as aborted instead). The job gate stops a blocked job's task too, at
   * its next step, so a crash before the stop does not let it run on.
   */
  const block = async (
    n: number,
    api: { readonly conversationId: ConversationId; readonly taskId: TaskId },
    stop: JobBlock,
    usages: readonly Usage[],
    size: { readonly chunks: number; readonly contentBytes: number },
    context: Context,
  ) => {
    // The job may be stopping already: the block commits whatever happens to the call.
    const quiet = withoutAbortSignal(context);
    const row = await harness().commit(async (tx) => {
      for (const usage of usages) await addGuardUsage(tx, api.conversationId, "decision", usage);
      const blocked = await blockRow(tx, n, api.conversationId, stop);
      return blocked === null ? null : { taskId: blocked.taskId };
    }, quiet);
    if (row === null) return;
    logEvent(
      "job.injection_stop",
      {
        cell: person,
        job: n,
        source: stop.kind,
        tool: stop.tool,
        outcome: stop.cause,
        chunk: stop.chunk,
        chunks: size.chunks,
        content_bytes: size.contentBytes,
      },
      "warn",
    );
    const lead = await harness().conversation(ROOT_CONVERSATION_ID, quiet);
    await lead?.submit(
      {
        type: "input",
        content: blockedNotice(n, stop),
        whenBusy: "followUp",
        requestId: `blocked:${n}:${String(api.conversationId)}`,
      },
      quiet,
    );
    const jobTask = row.taskId;
    if (jobTask === null) return;
    void harness()
      .waitForTask(api.taskId, quiet)
      .then(() => harness().abortTask(jobTask, quiet))
      // The cell closing first leaves the stop to the job gate on the next open.
      .catch(() => {});
  };

  return defineExtension({
    name: "secbot-content-check",
    wraps: contentCheckWraps(person, readers, now),
    hooks: [
      hook(ToolTask, {
        afterTool: async (call, result, api, context) => {
          const kind = readingKindOf(call.name, readers);
          if (kind === null) return undefined;
          const n = await jobOf(api, api.conversationId, context);
          if (n === null) return undefined;
          const row = (await api.snapshot(JobBoardDoc, context))?.jobs[String(n)];
          // A re-run of a read after a crash, or a read racing the stop: never kept.
          if (row?.status === "blocked") return withheld();
          const failed = (cause: "error" | "timeout" | "hit", chunk: number | null): JobBlock => ({
            cause,
            kind,
            tool: call.name,
            chunk,
            at: now(),
          });
          try {
            const text = resultText(result);
            if (text === null) {
              await block(n, api, failed("error", null), [], UNKNOWN_SIZE, context);
              return withheld();
            }
            const started = Date.now();
            const model = deps.decision(await readDecisionAdapter(api, context));
            const verdict = await checkContent(
              model,
              { kind, tool: call.name, text },
              context.abortSignal,
            );
            const size = { chunks: verdict.chunks, contentBytes: utf8Bytes(text) };
            logEvent("content.checked", {
              cell: person,
              job: n,
              tool: call.name,
              source: kind,
              chunks: verdict.chunks,
              content_bytes: size.contentBytes,
              cut: verdict.cut,
              cost_usd: verdict.costUsd,
              duration_ms: Date.now() - started,
            });
            if (verdict.outcome !== "clean") {
              if (verdict.outcome !== "hit") {
                // Why the check failed: a provider outage and a code fault read differently.
                logEvent(
                  "content.check_failed",
                  {
                    cell: person,
                    job: n,
                    tool: call.name,
                    outcome: verdict.outcome,
                    cause: verdict.cause,
                    chunk: verdict.chunk,
                  },
                  "warn",
                );
              }
              const stop = failed(verdict.outcome, verdict.chunk);
              await block(n, api, stop, verdict.usages, size, context);
              return withheld();
            }
            if (verdict.usages.length > 0) {
              await harness().commit(async (tx) => {
                for (const usage of verdict.usages) {
                  await addGuardUsage(tx, api.conversationId, "decision", usage);
                }
              }, context);
            }
            return {
              content: [
                { type: "text", text: verdict.checkedText + (verdict.cut ? CUT_NOTE : "") },
              ],
              ...(result.isError === undefined ? {} : { isError: result.isError }),
              ...(result.usage === undefined ? {} : { usage: result.usage }),
              diagnostics: [],
            };
          } catch (error) {
            if (context.abortSignal?.aborted) throw error;
            logEvent(
              "content.check_failed",
              {
                cell: person,
                job: n,
                tool: call.name,
                outcome: "error",
                cause: "thrown",
                chunk: null,
                ...errorFields(error),
              },
              "warn",
            );
            await block(n, api, failed("error", null), [], UNKNOWN_SIZE, context);
            return withheld();
          }
        },
      }),
    ],
  });
}
