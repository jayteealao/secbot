/**
 * The content check: every web page, mail, or file a job reads is checked by the decision model
 * before the job's conversation keeps it. Long content is cut at the check's maximum and split into
 * overlapping chunks, every chunk is checked, and a hit, a timeout, or an error stops the job: the
 * check fails closed, in every guard mode.
 */

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
