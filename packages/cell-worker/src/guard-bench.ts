/**
 * `GuardBenchCell`: the test cell's guard bench. Deployed only in the test-cell bundle
 * (wrangler.conformance.jsonc), never to a person cell. It opens the real cell harness and guard
 * on its own storage, with a scripted lead that makes permitted `household_read` calls, the live
 * decision model through the fleet's OpenRouter key, and a scripted reviewer that answers allow at
 * once, so the reviewer adds no time and makes no outside call. It measures the time the rules
 * plus the decision model add to each call from the guard's own `guard.verdict` events.
 *
 *   POST /lab/guard-bench?calls=N   start N measured calls (1-200, default 100) after 5 warm-up
 *                                   calls; 409 while a run is going
 *   GET  /lab/guard-bench-state     { done, measured, results? }
 */
import {
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type CellHarness,
  DEFAULT_LEAD_MODEL,
  DEFAULT_SPECIALIST_MODEL,
  onLogEvent,
  openCellHarness,
  type Reviewer,
} from "@secbot/cell-harness";
import type { CelldCellStorage } from "@secbot/cell-storage";
import { releaseVersion } from "./health.ts";

export const BENCH_PERSON = "bench";
export const BENCH_TEXT = "[bench] permitted calls";
export const BENCH_TOOL = "household_read";
export const WARMUP_CALLS = 5;
export const DEFAULT_BENCH_CALLS = 100;
export const MAX_BENCH_CALLS = 200;
/** A run that has not seen every call by then ends with what it measured. */
const RUN_DEADLINE_MS = 10 * 60_000;

export interface BenchEnv {
  readonly OPENROUTER_API_KEY?: string;
  readonly OPENROUTER_BASE_URL?: string;
}

export interface BenchState {
  readonly storage: CelldCellStorage;
  waitUntil?(promise: Promise<unknown>): void;
}

export interface BenchOptions {
  /** Tests: a shorter run deadline. */
  readonly deadlineMs?: number;
}

/** One `guard.verdict` of a bench call. */
export interface BenchSample {
  readonly durationMs: number;
  readonly ruleMs: number | null;
  readonly verdict: string;
  /** "pass", "mark", "would mark", "fallback", or null. */
  readonly decision: string | null;
  readonly model: string | null;
  readonly fallback: string | null;
  readonly costUsd: number;
}

export interface BenchResults {
  readonly measured: number;
  readonly warmup: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  /** The p95 over the calls the decision model passed (no reviewer in their time at all). */
  readonly passedP95Ms: number | null;
  readonly ruleP95Ms: number | null;
  readonly marks: number;
  readonly fallbacks: Readonly<Record<string, number>>;
  readonly models: readonly string[];
  readonly costUsd: number;
  readonly timedOut: boolean;
}

/** The nearest-rank percentile of `values`, or null for none. Pure. */
export function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? null;
}

/** The bench's numbers over the measured samples (the warm-up ones already dropped). Pure. */
export function summarizeBench(
  samples: readonly BenchSample[],
  timedOut = false,
  warmup = WARMUP_CALLS,
): BenchResults {
  const durations = samples.map((sample) => sample.durationMs);
  const fallbacks: Record<string, number> = {};
  for (const sample of samples) {
    if (sample.fallback !== null)
      fallbacks[sample.fallback] = (fallbacks[sample.fallback] ?? 0) + 1;
  }
  const cost = samples.reduce((sum, sample) => sum + sample.costUsd, 0);
  return {
    measured: samples.length,
    warmup,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    passedP95Ms: percentile(
      samples.filter((sample) => sample.decision === "pass").map((sample) => sample.durationMs),
      0.95,
    ),
    ruleP95Ms: percentile(
      samples.flatMap((sample) => (sample.ruleMs === null ? [] : [sample.ruleMs])),
      0.95,
    ),
    marks: samples.filter(
      (sample) => sample.decision === "mark" || sample.decision === "would mark",
    ).length,
    fallbacks,
    models: [
      ...new Set(samples.flatMap((sample) => (sample.model === null ? [] : [sample.model]))),
    ],
    costUsd: Number(cost.toFixed(6)),
    timedOut,
  };
}

const numberOr = (value: unknown, fallback: number | null) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const textOr = (value: unknown) => (typeof value === "string" ? value : null);

/** The sample in one `guard.verdict` event's fields. */
export function sampleOf(fields: Readonly<Record<string, unknown>>): BenchSample {
  return {
    durationMs: numberOr(fields.duration_ms, 0) ?? 0,
    ruleMs: numberOr(fields.rule_ms, null),
    verdict: textOr(fields.verdict) ?? "",
    decision: textOr(fields.decision),
    model: textOr(fields.decision_model),
    fallback: textOr(fields.fallback),
    costUsd: numberOr(fields.cost_usd, 0) ?? 0,
  };
}

const isLeadRequest = (context: TranscriptContext) => {
  const messages = context.messages as readonly Message[];
  const system = [
    (context as { systemPrompt?: string }).systemPrompt ?? "",
    ...messages
      .filter((message) => (message.role as string) === "system")
      .flatMap((message) =>
        Object.values((message as { sections?: Record<string, string | null> }).sections ?? {}),
      )
      .map((section) => section ?? ""),
  ].join("\n");
  return system.includes("You are the lead agent");
};

/** The scripted reviewer: allows at once, with no model call and no cost. */
const benchReviewer: Reviewer = {
  review: async () => ({ verdict: "allow", reason: "bench", model: "bench/scripted", costUsd: 0 }),
};

interface Run {
  readonly target: number;
  issued: number;
  readonly samples: BenchSample[];
  done: boolean;
  timedOut: boolean;
}

export class GuardBenchCell {
  private opening: Promise<CellHarness> | undefined;
  private run: Run | undefined;

  constructor(
    private readonly state: BenchState,
    private readonly env: BenchEnv,
    private readonly options: BenchOptions = {},
  ) {}

  /** The lead makes one permitted call per turn until the run's calls are issued, then answers. */
  private models() {
    const faux = fauxProvider({
      provider: "openrouter",
      models: [DEFAULT_LEAD_MODEL, DEFAULT_SPECIALIST_MODEL].map((id) => ({ id })),
    });
    faux.setResponses(
      Array.from(
        { length: 10_000 },
        (): FauxResponseFactory => async (request) => {
          const run = this.run;
          if (!isLeadRequest(request) || run === undefined || run.issued >= run.target) {
            return fauxAssistantMessage([fauxText("bench done")]);
          }
          run.issued++;
          return fauxAssistantMessage([fauxToolCall(BENCH_TOOL, { document: "list" })], {
            stopReason: "toolUse",
          });
        },
      ),
    );
    const models = createModels();
    models.setProvider(faux.provider);
    return models;
  }

  private cell(): Promise<CellHarness> {
    if (this.opening === undefined) {
      this.opening = openCellHarness(this.state.storage, {
        person: BENCH_PERSON,
        version: releaseVersion(),
        // Only the decision model's key and origin: no alert, heartbeat, or other setting.
        env: {
          ...(this.env.OPENROUTER_API_KEY === undefined
            ? {}
            : { OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY }),
          ...(this.env.OPENROUTER_BASE_URL === undefined
            ? {}
            : { OPENROUTER_BASE_URL: this.env.OPENROUTER_BASE_URL }),
        },
        models: this.models(),
        guard: { reviewer: benchReviewer },
      });
      this.opening.catch(() => {
        this.opening = undefined;
      });
    }
    return this.opening;
  }

  /** POST /lab/guard-bench: starts a run in the background. */
  async start(calls: number): Promise<Response> {
    if (this.run !== undefined && !this.run.done) {
      return Response.json({ error: "a bench run is going" }, { status: 409 });
    }
    const cell = await this.cell();
    const run: Run = {
      target: calls + WARMUP_CALLS,
      issued: 0,
      samples: [],
      done: false,
      timedOut: false,
    };
    this.run = run;
    const stop = onLogEvent((event, fields) => {
      if (event !== "guard.verdict" || fields.cell !== BENCH_PERSON || fields.tool !== BENCH_TOOL) {
        return;
      }
      run.samples.push(sampleOf(fields));
    });
    const startedAt = Date.now();
    try {
      await cell.submit(`${BENCH_TEXT} ${calls}`, `bench:${startedAt}`);
    } catch (error) {
      stop();
      run.done = true;
      throw error;
    }
    const deadline = startedAt + (this.options.deadlineMs ?? RUN_DEADLINE_MS);
    const work = (async () => {
      while (run.samples.length < run.target && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      stop();
      run.timedOut = run.samples.length < run.target;
      run.done = true;
    })();
    this.state.waitUntil?.(work);
    return Response.json({ started: true, calls, warmup: WARMUP_CALLS });
  }

  /** GET /lab/guard-bench-state. */
  status(): Record<string, unknown> {
    const run = this.run;
    if (run === undefined) return { done: false, measured: 0, started: false };
    const measured = run.samples.slice(WARMUP_CALLS);
    return {
      done: run.done,
      measured: measured.length,
      ...(run.done ? { results: summarizeBench(measured, run.timedOut) } : {}),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (route === "POST /lab/guard-bench") {
      const raw = url.searchParams.get("calls") ?? String(DEFAULT_BENCH_CALLS);
      const calls = /^\d{1,3}$/.test(raw) ? Number(raw) : Number.NaN;
      if (!(calls >= 1 && calls <= MAX_BENCH_CALLS)) {
        return Response.json({ error: `calls is 1-${MAX_BENCH_CALLS}` }, { status: 400 });
      }
      return this.start(calls);
    }
    if (route === "GET /lab/guard-bench-state") return Response.json(this.status());
    return Response.json({ error: "not found" }, { status: 404 });
  }

  /** Tests: closes the harness. */
  async close(): Promise<void> {
    const opening = this.opening;
    this.opening = undefined;
    if (opening !== undefined) await (await opening).close();
  }
}
