/**
 * A minimal harness for the waiting-hook crash test: pi-durable on the cell storage adapter, with
 * one probe extension that holds a `safe` and an `unsafe` tool and a `beforeTool` hook. The hook
 * records each run, writes a task memo, then does what the caller says (wait forever, or pass).
 * Shared by hook-crash-child.ts (the process the test kills) and crash.test.ts (the reopen).
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ToolCall, Type } from "@earendil-works/pi-ai";
import {
  type Conversation,
  createRegistry,
  defineExtension,
  defineTool,
  type Extension,
  type Harness,
  Harness as HarnessFactory,
  hook,
  ToolTask,
} from "@earendil-works/pi-durable";
import { openCelldStorageWithDatabase } from "@secbot/cell-storage";
import type { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { modelRef } from "../src/model-map.ts";
import { DEFAULT_LEAD_MODEL } from "../src/release-defaults.ts";
import {
  type FauxGateway,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Responder,
} from "./fixtures.ts";

export type ReplayPolicy = "safe" | "unsafe";

export const PROBE_TOOLS = { safe: "probe_safe", unsafe: "probe_unsafe" } as const;

/** The memo the hook writes before it waits; first writer wins. */
export const FIRST_RUN_MEMO = "hook-crash:first-run";

export interface HookRun {
  readonly callId: string;
  readonly taskId: string;
  readonly pid: number;
  /** The memo value the hook got back: the first run's value when that run's write survived. */
  readonly memo: { readonly pid: number; readonly callId: string };
}

export interface HookProbe {
  readonly extension: Extension;
  /** Every hook run in this process, in order. */
  readonly runs: HookRun[];
  /** Tool executions in this process, per policy. */
  readonly executions: Record<ReplayPolicy, number>;
}

/** What the hook returns after it has recorded its run: a promise that never settles, or no decision. */
export type HookBehavior = (call: ToolCall) => Promise<undefined>;

export const waitForever: HookBehavior = () => new Promise(() => {});
export const pass: HookBehavior = async () => undefined;

export function createHookProbe(behavior: HookBehavior): HookProbe {
  const runs: HookRun[] = [];
  const executions: Record<ReplayPolicy, number> = { safe: 0, unsafe: 0 };
  const probeTool = (policy: ReplayPolicy) =>
    defineTool({
      name: PROBE_TOOLS[policy],
      description: `A probe tool with replay "${policy}".`,
      parameters: Type.Object({ note: Type.Optional(Type.String()) }),
      replay: policy,
      execute: async () => {
        executions[policy]++;
        return { content: [{ type: "text", text: `ran ${PROBE_TOOLS[policy]}` }] };
      },
    });
  const extension = defineExtension({
    name: "hook-crash-probe",
    tools: [probeTool("safe"), probeTool("unsafe")],
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          const memo = await api.memo(
            FIRST_RUN_MEMO,
            { pid: process.pid, callId: call.id },
            context,
          );
          runs.push({ callId: call.id, taskId: String(api.taskId), pid: process.pid, memo });
          return behavior(call);
        },
      }),
    ],
  });
  return { extension, runs, executions };
}

/** Answers the user message with one call to the probe tool, and the tool result with text. */
export function probeResponder(policy: ReplayPolicy): Responder {
  return (request) =>
    request.last?.role === "toolResult"
      ? fauxAssistantMessage([fauxText("probe done")])
      : fauxAssistantMessage([fauxToolCall(PROBE_TOOLS[policy], { note: "probe" })], {
          stopReason: "toolUse",
        });
}

/** Opens the probe harness on `storage`. It does not call `resume()`. */
export async function openProbeHarness(
  storage: FakeCelldStorage,
  gateway: FauxGateway,
  probe: HookProbe,
  context: Context = BACKGROUND_CONTEXT,
): Promise<{ harness: Harness; root: Conversation }> {
  const durable = await openCelldStorageWithDatabase(storage);
  const registry = createRegistry();
  registry.install(probe.extension);
  const harness = await HarnessFactory.open(
    durable.storage,
    { models: gateway.models, registry, settings: { extensions: [probe.extension] } },
    context,
  );
  const root = await harness.root(context, { agent: { model: modelRef(DEFAULT_LEAD_MODEL) } });
  return { harness, root };
}
