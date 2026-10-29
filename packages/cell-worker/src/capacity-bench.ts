/**
 * `CapacityBenchCell`: the test cell's capacity bench. Deployed only in the test-cell bundle
 * (wrangler.conformance.jsonc), never to a person cell. It opens the real cell harness on its own
 * storage with the fleet's OpenRouter key, so every job runs the production job path (templates,
 * tiers, models, guard, content check, budget, ledger) on a live model; only the lead is scripted,
 * so starting N jobs at once needs no lead decision and costs nothing. Each job gets one cheap
 * research brief: call `fixture_slow_lookup` once and answer its text in one line, so the jobs of
 * a level stay running together for the slow tool's wait. The host's capacity task reads the
 * bench's isolate heap from celld while a level runs, and the job rows' times from the state route.
 *
 *   POST /lab/capacity?jobs=N&slow=S     start a level: N jobs at once (1-16), each holding S
 *                                        seconds on the slow tool (5-300); 409 while one runs
 *   GET  /lab/capacity-state             { level, done, startedAt, processStartedAt, jobs }
 *
 * A new level leaves the earlier levels' jobs on the board and reports only its own.
 */

import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
  type Provider,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import {
  type CellHarness,
  createGatewayModels,
  DEFAULT_LEAD_MODEL,
  DEFAULT_SPECIALIST_MODEL,
  ENDED,
  type GatewayEnv,
  HarnessSlot,
  openCellHarness,
  type Reviewer,
  TIER_MODELS,
} from "@secbot/cell-harness";
import type { CelldCellStorage } from "@secbot/cell-storage";
import { releaseVersion } from "./health.ts";

export const CAPACITY_PERSON = "capacity-bench";
export const CAPACITY_TEXT = "[bench] start";
export const MAX_CAPACITY_JOBS = 16;
export const MIN_SLOW_SECONDS = 5;
export const MAX_SLOW_SECONDS = 300;

/** When this isolate started: a changed value between two reads means the bench restarted. */
const PROCESS_STARTED_AT = Date.now();

/** The cheap research brief each bench job gets. */
export const benchBrief = (n: number) =>
  `Call fixture_slow_lookup once with topic ${n} and answer its text in one line.`;

export interface CapacityBenchEnv extends GatewayEnv {}

export interface CapacityBenchState {
  readonly storage: CelldCellStorage;
  waitUntil?(promise: Promise<unknown>): void;
}

/** One job of the current level, as the capacity task reads it. */
export interface CapacityJob {
  readonly n: number;
  readonly status: string;
  readonly createdAt: number;
  /** From the level's start to the lead's receipt for this job (the row's creation). */
  readonly receiptMs: number;
  readonly endedAt: number | null;
  readonly costUsd: number;
}

interface Level {
  readonly level: number;
  readonly jobs: number;
  readonly startedAt: number;
  /** The board number of the level's first job: earlier rows belong to earlier levels. */
  readonly firstNumber: number;
}

/** True for a request of the lead conversation (its system prompt names the lead agent). */
function isLeadRequest(context: TranscriptContext): boolean {
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
}

/** The newest non-system message's text. */
function lastText(context: TranscriptContext): { role: string; text: string } {
  const last = (context.messages as readonly Message[]).findLast(
    (message) => (message.role as string) !== "system",
  );
  if (last === undefined) return { role: "", text: "" };
  const content = (last as { content?: unknown }).content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((part: { type?: string; text?: string }) =>
              part.type === "text" && typeof part.text === "string" ? [part.text] : [],
            )
            .join("")
        : "";
  return { role: last.role, text };
}

/** The scripted reviewer: allows at once, with no model call and no cost. */
const benchReviewer: Reviewer = {
  review: async () => ({ verdict: "allow", reason: "bench", model: "bench/scripted", costUsd: 0 }),
};

export class CapacityBenchCell {
  private readonly slot: HarnessSlot<CellHarness>;
  private current: Level | undefined;
  private levels = 0;
  /** The slow tool reads this at each call, so every level sets its own wait. */
  private readonly slow = { slowMs: MIN_SLOW_SECONDS * 1000 };

  constructor(
    private readonly state: CapacityBenchState,
    private readonly env: CapacityBenchEnv,
  ) {
    this.slot = new HarnessSlot(
      CAPACITY_PERSON,
      (onReport) => this.open(onReport),
      state.waitUntil?.bind(state),
    );
  }

  /** The lead is scripted (no model call); every other request goes to the live gateway. */
  private models() {
    const faux = fauxProvider({
      provider: "openrouter",
      models: [
        ...new Set([DEFAULT_LEAD_MODEL, DEFAULT_SPECIALIST_MODEL, ...Object.values(TIER_MODELS)]),
      ].map((id) => ({ id })),
    });
    faux.setResponses(
      Array.from(
        { length: 10_000 },
        (): FauxResponseFactory => async (context) => {
          const last = lastText(context);
          const match = new RegExp(`^\\${CAPACITY_TEXT} (\\d+)$`).exec(last.text.trim());
          if (last.role !== "user" || match === null) {
            return fauxAssistantMessage([fauxText("ok")]);
          }
          const count = Number(match[1]);
          return fauxAssistantMessage(
            Array.from({ length: count }, (_, i) =>
              fauxToolCall("start_job", {
                title: `bench job ${i + 1}`,
                brief: benchBrief(i + 1),
                template: "research",
                priority: "research",
              }),
            ),
            { stopReason: "toolUse" },
          );
        },
      ),
    );
    const live: Provider = openrouterProvider();
    const routed = Object.assign(Object.create(live) as Provider, {
      stream: ((model, context, options) =>
        isLeadRequest(context)
          ? faux.provider.stream(model, context, options)
          : live.stream(model, context, options)) as Provider["stream"],
      streamSimple: ((model, context, options) =>
        isLeadRequest(context)
          ? faux.provider.streamSimple(model, context, options)
          : live.streamSimple(model, context, options)) as Provider["streamSimple"],
    });
    return createGatewayModels(this.env, routed);
  }

  private cell(): Promise<CellHarness> {
    return this.slot.get();
  }

  private open(onReport: (error: unknown) => void): Promise<CellHarness> {
    return openCellHarness(this.state.storage, {
      person: CAPACITY_PERSON,
      version: releaseVersion(),
      // Only the model key and origin: no alert, heartbeat, or other setting.
      env: {
        ...(this.env.OPENROUTER_API_KEY === undefined
          ? {}
          : { OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY }),
        ...(this.env.OPENROUTER_BASE_URL === undefined
          ? {}
          : { OPENROUTER_BASE_URL: this.env.OPENROUTER_BASE_URL }),
      },
      models: this.models(),
      fixtureTools: this.slow,
      onReport,
      guard: { reviewer: benchReviewer },
    });
  }

  /** POST /lab/capacity: starts one level in the background. */
  async start(jobs: number, slowSeconds: number): Promise<Response> {
    if (this.current !== undefined && !(await this.levelDone(this.current))) {
      return Response.json({ error: "a capacity level is running" }, { status: 409 });
    }
    const cell = await this.cell();
    this.slow.slowMs = slowSeconds * 1000;
    const firstNumber = (await cell.board()).nextNumber;
    const level: Level = {
      level: ++this.levels,
      jobs,
      startedAt: Date.now(),
      firstNumber,
    };
    this.current = level;
    await cell.submit(`${CAPACITY_TEXT} ${jobs}`, `capacity:${level.level}:${level.startedAt}`);
    return Response.json({ started: true, level: level.level, jobs, slowSeconds });
  }

  private async levelJobs(level: Level): Promise<CapacityJob[]> {
    const board = await (await this.cell()).board();
    return Object.values(board.jobs)
      .filter(
        (row) => row.number >= level.firstNumber && row.number < level.firstNumber + level.jobs,
      )
      .sort((a, b) => a.number - b.number)
      .map((row) => ({
        n: row.number - level.firstNumber + 1,
        status: row.status,
        createdAt: row.createdAt,
        receiptMs: Math.max(0, row.createdAt - level.startedAt),
        endedAt: row.endedAt,
        costUsd: row.cost,
      }));
  }

  private async levelDone(level: Level): Promise<boolean> {
    const jobs = await this.levelJobs(level);
    return jobs.length === level.jobs && jobs.every((job) => ENDED.has(job.status as never));
  }

  /** GET /lab/capacity-state. */
  async status(): Promise<Record<string, unknown>> {
    const level = this.current;
    if (level === undefined) {
      return {
        level: 0,
        done: false,
        startedAt: null,
        processStartedAt: PROCESS_STARTED_AT,
        jobs: [],
      };
    }
    const jobs = await this.levelJobs(level);
    return {
      level: level.level,
      done: jobs.length === level.jobs && jobs.every((job) => ENDED.has(job.status as never)),
      startedAt: level.startedAt,
      processStartedAt: PROCESS_STARTED_AT,
      jobs,
    };
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (error) {
      // A request that meets a database celld closed closes the harness for the next request.
      this.slot.lost(error);
      throw error;
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (route === "POST /lab/capacity") {
      const jobs = Number(url.searchParams.get("jobs") ?? "");
      const slow = Number(url.searchParams.get("slow") ?? "");
      if (!Number.isInteger(jobs) || jobs < 1 || jobs > MAX_CAPACITY_JOBS) {
        return Response.json({ error: `jobs is 1-${MAX_CAPACITY_JOBS}` }, { status: 400 });
      }
      if (!Number.isInteger(slow) || slow < MIN_SLOW_SECONDS || slow > MAX_SLOW_SECONDS) {
        return Response.json(
          { error: `slow is ${MIN_SLOW_SECONDS}-${MAX_SLOW_SECONDS} seconds` },
          { status: 400 },
        );
      }
      return this.start(jobs, slow);
    }
    if (route === "GET /lab/capacity-state") return Response.json(await this.status());
    return Response.json({ error: "not found" }, { status: 404 });
  }

  /** Tests: closes the harness. */
  async close(): Promise<void> {
    await this.slot.close();
  }
}
