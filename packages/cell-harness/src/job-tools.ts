/**
 * The tools a job conversation has beside its template's: search the transcripts of its own
 * earlier attempts after a restart. A job has no tool that starts a subagent.
 */
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type Harness,
  type ToolRegistration,
  type Wrap,
  wrapTool,
} from "@earendil-works/pi-durable";
import { JobBoardDoc } from "./docs.ts";
import type { JobHolds } from "./job-holds.ts";
import { type HistoryHit, searchHistoryWindow } from "./history-search.ts";
import { jobOf } from "./telemetry.ts";

export interface JobToolsDeps {
  readonly person: string;
  readonly harness: () => Harness;
  readonly holds: JobHolds;
  readonly now: () => number;
  /** Every other tool a job conversation has: each call is recorded on the job's row. */
  readonly wrapped: readonly string[];
}

/**
 * Records a tool's name on the calling job's row, in the tool's own commit before the tool runs
 * (a hook cannot write), so a risky tool marks the result even when the call fails or the cell
 * stops right after it. A call from any other conversation runs unchanged.
 */
export function toolsUsedWraps(names: readonly string[]): Wrap[] {
  return names.map((name) =>
    // Only the name of the first argument is read: the wrapper decorates whichever tool won.
    wrapTool({ name } as ToolRegistration, (inner) => ({
      ...inner,
      execute: async (args, api, context) => {
        const n = await jobOf(api, api.conversationId, context);
        if (n !== null) {
          await api.commit(async (tx) => {
            const row = (await tx.doc(JobBoardDoc)).jobs[String(n)];
            if (row === undefined || String(row.conversationId) !== String(api.conversationId)) {
              return;
            }
            if (!row.toolsUsed.includes(name)) row.toolsUsed.push(name);
          }, context);
        }
        return inner.execute(args, api, context);
      },
    })),
  );
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const refusal = (value: string) => ({ ...text(value), isError: true });

export function createJobToolsExtension(deps: JobToolsDeps): Extension {
  const searchOldJob = defineTool({
    name: "search_old_job",
    description:
      "Search the transcripts of this job's earlier attempts (after the lead restarted it), newest attempt first. Every word of the query must appear.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Words to look for." }),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 20, description: "At most this many (default 10)." }),
      ),
    }),
    // Read-only: safe to run again after a crash.
    replay: "safe",
    execute: async (args, api, context) => {
      const n = await jobOf(api, api.conversationId, context);
      if (n === null) return refusal("Only a job can search its earlier attempts.");
      const row = (await api.snapshot(JobBoardDoc, context))?.jobs[String(n)];
      const runs = [...(row?.runs ?? [])].reverse();
      if (runs.length === 0) return text("This job has no earlier attempt.");
      const limit = args.limit ?? 10;
      const found: string[] = [];
      for (const [index, run] of runs.entries()) {
        if (run.conversationId === null || found.length >= limit) continue;
        const result = await searchHistoryWindow(
          deps.harness(),
          args.query,
          { limit: limit - found.length, conversationId: run.conversationId },
          context,
        );
        const attempt = runs.length - index;
        for (const hit of result.hits as HistoryHit[]) {
          found.push(`attempt ${attempt} #${hit.entryId} ${hit.role}: ${hit.text}`);
        }
      }
      return {
        ...text(
          found.length === 0
            ? `No messages of this job's earlier attempts match "${args.query}".`
            : found.join("\n\n"),
        ),
        details: { matches: found.length },
      };
    },
  });
  const tools = [searchOldJob];
  return defineExtension({
    name: "secbot-job-tools",
    tools,
    wraps: toolsUsedWraps([...deps.wrapped, ...tools.map((tool) => tool.name)]),
  });
}
