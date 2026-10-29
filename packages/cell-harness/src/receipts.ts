/**
 * Background receipts for the lead's remote tools. A tool that calls another cell (the household
 * list, a secret, a brokered call) holds its round until that cell answers; on the lead's
 * conversation that would hold the person's next message behind it. So on the lead's conversation
 * the call commits a receipt and a receipt task and answers at once; the task runs the same effect
 * function the tool runs (household-tools.ts, secret-tools.ts) and stores the answer on the
 * receipt, which the lead reads with `read_result`. Inside a job the tools stay inline: a job's own
 * call holds only that job.
 *
 * pi-durable has no "run this tool in the background" switch (a tool's `execute` is the round,
 * installed pi-durable dist/harness/types.d.ts:169), so the background part is this task.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  type DocumentReader,
  defineTask,
  defineTool,
  ROOT_CONVERSATION_ID,
  type ToolExecutionResult,
  type ToolRegistration,
  type Tx,
  type Wrap,
  wrapTool,
} from "@earendil-works/pi-durable";
import { logEvent } from "./cell-parts.ts";
import { type Receipt, ReceiptDoc, ReceiptsDoc } from "./docs.ts";
import {
  type HouseholdChangeArgs,
  type HouseholdClient,
  type HouseholdReadArgs,
  householdChange,
  householdRead,
} from "./household-tools.ts";
import {
  type BrokerArgs,
  brokerCall,
  type SecretsCall,
  type SecretsDeps,
  secretGet,
} from "./secret-tools.ts";

/** The receipt task's kind. */
export const RECEIPT_KIND = "secbot.receipt";

/** The lead's tools that call another cell, and so run in the background on the lead. */
export const REMOTE_TOOLS = ["household_read", "household_change", "secret_get", "broker_call"];

/** Tools whose call is never repeated blindly after a crash (their `replay: "unsafe"`). */
const UNSAFE = new Set(["broker_call"]);

export interface RemoteDeps {
  readonly person: string;
  readonly household: () => HouseholdClient | undefined;
  /** Absent: the secret tools answer "secrets cell unavailable". */
  readonly secrets?: SecretsDeps;
}

type ReceiptInput = {
  /** The receipt's key, `r<n>`. */
  key: string;
  tool: string;
  args: JsonValue;
  /** The tool call's task and call id: a household change's operation id is made from them. */
  toolTaskId: string;
  callId: string;
  startedAt: number;
};
type ReceiptState = { phase: "start" } | { phase: "effect" };

const textOf = (result: ToolExecutionResult): string =>
  (result.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

const UNAVAILABLE_SECRETS: Omit<SecretsDeps, "person"> = {
  client: () => undefined,
  options: { now: Date.now, timeZone: "UTC" },
  loadRedaction: async () => {},
};

/** Runs one remote tool's effect, as the tool itself would on the lead. */
async function runEffect(
  deps: RemoteDeps,
  input: ReceiptInput,
  call: SecretsCall,
  context: Context,
): Promise<ToolExecutionResult> {
  const args = input.args as Record<string, unknown>;
  switch (input.tool) {
    case "household_read":
      return householdRead(deps.household(), args as HouseholdReadArgs);
    case "household_change":
      return householdChange(
        deps.household(),
        args as unknown as HouseholdChangeArgs,
        `${deps.person}:${input.toolTaskId}:${input.callId}`,
        deps.person,
      );
    case "secret_get":
      return secretGet(
        deps.secrets ?? { person: deps.person, ...UNAVAILABLE_SECRETS },
        call,
        args as { name: string },
        context,
      );
    case "broker_call":
      return brokerCall(
        deps.secrets ?? { person: deps.person, ...UNAVAILABLE_SECRETS },
        call,
        args as unknown as BrokerArgs,
        context,
      );
    default:
      return {
        content: [{ type: "text", text: `No background tool named ${input.tool}.` }],
        isError: true,
      };
  }
}

/** Stores a receipt's outcome, once. */
async function store(
  tx: Tx,
  key: string,
  outcome: Pick<Receipt, "status" | "text" | "isError">,
): Promise<void> {
  const receipt = (await tx.doc(ReceiptDoc, key, null)).receipt;
  if (receipt === null || receipt.status !== "running") return;
  receipt.status = outcome.status;
  receipt.text = outcome.text;
  receipt.isError = outcome.isError;
}

export function createReceiptTask(deps: RemoteDeps) {
  const { person } = deps;
  const finished = (input: ReceiptInput, outcome: string, at: number) =>
    logEvent(
      "receipt.finished",
      {
        cell: person,
        receipt: input.key,
        tool: input.tool,
        outcome,
        duration_ms: Math.max(0, at - input.startedAt),
      },
      outcome === "ok" ? "info" : "warn",
    );
  return defineTask<ReceiptInput, ReceiptState, null>({
    name: RECEIPT_KIND,
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      // The first commit marks the call started: a run of `effect` after it is a rerun.
      start: (_receipt, runtime, context) =>
        runtime.commit(() => ({ status: "running", checkpoint: { phase: "effect" } }), context),
      effect: async (receipt, runtime, context) => {
        const { input } = receipt;
        const rerun = (await runtime.memo<boolean>("began", context)) === true;
        if (rerun && UNSAFE.has(input.tool)) {
          await runtime.commit(async (tx) => {
            await store(tx, input.key, {
              status: "interrupted",
              text: `The ${input.tool} call was interrupted by a restart and was not repeated; it may or may not have reached the service.`,
              isError: true,
            });
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
          finished(input, "interrupted", runtime.now());
          return;
        }
        await runtime.memo("began", true, context);
        const call: SecretsCall = {
          taskId: input.toolTaskId,
          callId: input.callId,
          agent: "lead",
          commit: async (change, commitContext) => {
            let out: Awaited<ReturnType<typeof change>> | undefined;
            await runtime.commit(async (tx) => {
              out = await change(tx);
              return undefined;
            }, commitContext);
            return out as Awaited<ReturnType<typeof change>>;
          },
        };
        let result: ToolExecutionResult;
        try {
          result = await runEffect(deps, input, call, context);
        } catch (error) {
          result = {
            content: [
              {
                type: "text",
                text: `The ${input.tool} call failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
        await runtime.commit(async (tx) => {
          await store(tx, input.key, {
            status: "done",
            text: textOf(result),
            isError: result.isError === true,
          });
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
        finished(input, result.isError === true ? "error" : "ok", runtime.now());
      },
    },
    abort: (receipt, runtime, context) =>
      runtime.commit(async (tx) => {
        await store(tx, receipt.input.key, {
          status: "interrupted",
          text: `The ${receipt.input.tool} call was stopped.`,
          isError: true,
        });
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
  });
}

export type ReceiptTask = ReturnType<typeof createReceiptTask>;

/**
 * The lead's wraps of the remote tools: on the lead's conversation, a call commits its receipt and
 * receipt task and answers at once; anywhere else it runs the tool as before.
 */
export function remoteWraps(
  person: string,
  Receipt: ReceiptTask,
  turnOf: (
    api: Parameters<ToolRegistration["execute"]>[1],
    context: Context,
  ) => Promise<number | null>,
  now: () => number,
): Wrap[] {
  return REMOTE_TOOLS.map((name) =>
    // Only the name of the first argument is read: the wrapper decorates whichever tool won.
    wrapTool({ name } as ToolRegistration, (inner) => ({
      ...inner,
      execute: async (args, api, context) => {
        if (api.conversationId !== ROOT_CONVERSATION_ID) return inner.execute(args, api, context);
        const turn = await turnOf(api, context);
        const startedAt = now();
        const key = await api.commit(async (tx) => {
          const receipts = await tx.doc(ReceiptsDoc);
          const number = receipts.nextNumber;
          receipts.nextNumber = number + 1;
          const key = `r${number}`;
          receipts.open.push(key);
          (await tx.doc(ReceiptDoc, key, null)).receipt = {
            number,
            tool: name,
            turn,
            status: "running",
            text: "",
            isError: false,
            sensitive: name === "secret_get",
            at: startedAt,
            readAt: null,
          };
          await tx.createTask(
            Receipt,
            {
              key,
              tool: name,
              args: args as JsonValue,
              toolTaskId: String(api.taskId),
              callId: api.callId,
              startedAt,
            },
            { ownership: { kind: "conversation" }, background: true },
          );
          return key;
        }, context);
        logEvent("receipt.started", { cell: person, receipt: key, tool: name, turn });
        return {
          content: [
            {
              type: "text",
              text: `receipt ${key}: ${name} runs in the background; read it with read_result.`,
            },
          ],
          details: { receipt: key, tool: name },
        };
      },
    })),
  );
}

/** What a sensitive receipt holds once the lead has read it. */
export const SENSITIVE_READ = "(read once; the value is not kept)";

/** The lead's `read_result`: a receipt's stored answer, or that it is still running. */
export function createReadResultTool(now: () => number) {
  return defineTool({
    name: "read_result",
    description:
      "Read the stored result of a tool call that ran in the background, by its receipt (for example r3).",
    parameters: Type.Object({
      receipt: Type.String({ pattern: "^r[0-9]+$", description: "The receipt, such as r3." }),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const read = await api.commit(async (tx) => {
        const receipt = (await tx.doc(ReceiptDoc, args.receipt, null)).receipt;
        if (receipt === null) return { error: `No receipt ${args.receipt}.` };
        if (receipt.status === "running") return { running: true as const };
        receipt.readAt ??= now();
        const open = (await tx.doc(ReceiptsDoc)).open;
        const at = open.indexOf(args.receipt);
        if (at !== -1) open.splice(at, 1);
        const text = receipt.text;
        // A secret's value is handed over once and not kept: the receipt holds no second copy.
        if (receipt.sensitive && receipt.readAt !== null) receipt.text = SENSITIVE_READ;
        return { tool: receipt.tool, text, isError: receipt.isError };
      }, context);
      if ("error" in read) {
        return { content: [{ type: "text", text: read.error }], isError: true };
      }
      if ("running" in read) {
        return {
          content: [{ type: "text", text: `receipt ${args.receipt}: still running.` }],
          details: { receipt: args.receipt, status: "running" },
        };
      }
      return {
        content: [{ type: "text", text: `receipt ${args.receipt} (${read.tool}):\n${read.text}` }],
        details: { receipt: args.receipt, status: "done" },
        ...(read.isError ? { isError: true } : {}),
      };
    },
  });
}

/** Every receipt of the lead still listed as open (running or unread), oldest first. */
export async function openReceipts(
  reader: Pick<DocumentReader, "snapshot">,
  context: Context,
): Promise<(Receipt & { readonly key: string })[]> {
  const open = (await reader.snapshot(ReceiptsDoc, context))?.open ?? [];
  const found: (Receipt & { readonly key: string })[] = [];
  for (const key of open) {
    const receipt = (await reader.snapshot(ReceiptDoc, key, context))?.receipt;
    if (receipt !== null && receipt !== undefined) found.push({ ...receipt, key });
  }
  return found;
}
