/**
 * The content check: every web page, mail, or file a job reads is checked by the decision model
 * before the job's conversation keeps it. Long content is cut at the check's maximum and split into
 * overlapping chunks, every chunk is checked, and a hit, a timeout, or an error stops the job: the
 * check fails closed, in every guard mode.
 */
import type { Usage } from "@earendil-works/pi-ai";
import { type ToolRegistration, type Wrap, wrapTool } from "@earendil-works/pi-durable";
import { buildContentState, DecisionFailure, type DecisionModel } from "./decision-model.ts";
import { markOutside } from "./job-board.ts";
import {
  CONTENT_CHECK_MAX_BYTES,
  CONTENT_CHECK_PARALLEL,
  CONTENT_CHUNK_BYTES,
  CONTENT_CHUNK_OVERLAP_BYTES,
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

const DEFAULT_SIZES: ChunkSizes = {
  chunkBytes: CONTENT_CHUNK_BYTES,
  overlapBytes: CONTENT_CHUNK_OVERLAP_BYTES,
  maxBytes: CONTENT_CHECK_MAX_BYTES,
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
  sizes: ChunkSizes = DEFAULT_SIZES,
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
          await api.commit(async (tx) => {
            await markOutside(tx, n, api.conversationId, name, kind, now());
          }, context);
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
