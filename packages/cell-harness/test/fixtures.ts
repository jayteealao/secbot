/**
 * Test fixtures: a person cell's harness on the node:sqlite celld stand-in, with pi-ai's faux
 * provider registered as "openrouter" (the release's model ids plus one more) behind the same
 * credit-pause decorator the gateway uses. No network, no key. Also an in-process household cell
 * (the real change log on the stand-in) for the household tools.
 */
import {
  type AssistantMessage,
  createModels,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { CelldSqliteDatabase } from "../../cell-storage/src/index.ts";
import { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { ChangeLog } from "../../household-cell/src/change-log.ts";
import { withCreditPause } from "../src/credit-pause.ts";
import type { HouseholdChange, HouseholdClient } from "../src/household-tools.ts";
import {
  type CellEnv,
  type CellHarness,
  type OpenCellOptions,
  openCellHarness,
} from "../src/open-harness.ts";
import { DEFAULT_LEAD_MODEL, DEFAULT_SPECIALIST_MODEL } from "../src/release-defaults.ts";

export { FakeCelldStorage, fauxAssistantMessage, fauxText, fauxToolCall };

/** A third catalog id the tests switch a role to. */
export const ALTERNATE_MODEL = "anthropic/claude-sonnet-5.5";

const text = (content: Message["content"]): string =>
  typeof content === "string"
    ? content
    : (content as readonly { type: string; text?: string }[])
        .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
        .join("");

/** What one faux request is about: who asks (from the system prompt) and the newest message. */
export interface FauxRequest {
  readonly system: string;
  readonly last: Message | undefined;
  readonly lastText: string;
  readonly modelId: string;
  /** "lead", or the specialist named in the system prompt, or "unknown". */
  readonly role: string;
}

export function describeRequest(context: TranscriptContext, modelId: string): FauxRequest {
  const messages = context.messages as readonly Message[];
  const system = [
    (context as { systemPrompt?: string }).systemPrompt ?? "",
    ...messages
      .filter((m) => (m.role as string) === "system")
      .flatMap((m) => [
        text(m.content),
        ...Object.values((m as { sections?: Record<string, string | null> }).sections ?? {}).map(
          (section) => section ?? "",
        ),
      ]),
  ].join("\n");
  const last = messages.findLast((m) => (m.role as string) !== "system");
  const specialist = /You are the ([a-z0-9-]+) specialist/.exec(system)?.[1];
  const custom = /You are the custom specialist "([a-z0-9-]+)"/.exec(system)?.[1];
  const role = system.includes("You are the lead agent")
    ? "lead"
    : (specialist ?? custom ?? "unknown");
  return { system, last, lastText: last === undefined ? "" : text(last.content), modelId, role };
}

export type Responder = (request: FauxRequest) => AssistantMessage | Promise<AssistantMessage>;

export interface FauxGateway {
  readonly models: ReturnType<typeof createModels>;
  /** Every request, in order. */
  readonly requests: FauxRequest[];
  respond: Responder;
}

/** A plain answer, or a lead that answers "OK" to tool results and reports. */
export const defaultResponder: Responder = (request) => {
  if (request.last?.role === "toolResult") return fauxAssistantMessage([fauxText("OK, briefed.")]);
  return fauxAssistantMessage([fauxText(`${request.role} says: ${request.lastText.slice(0, 40)}`)]);
};

export function createFauxGateway(
  respond: Responder = defaultResponder,
  options: { readonly tokensPerSecond?: number } = {},
): FauxGateway {
  const faux = fauxProvider({
    provider: "openrouter",
    ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
    models: [DEFAULT_LEAD_MODEL, DEFAULT_SPECIALIST_MODEL, ALTERNATE_MODEL].map((id) => ({
      id,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    })),
  });
  const gateway: FauxGateway = {
    models: createModels(),
    requests: [],
    respond,
  };
  const step: FauxResponseFactory = async (context, _options, _state, model) => {
    const request = describeRequest(context, model.id);
    gateway.requests.push(request);
    return gateway.respond(request);
  };
  faux.setResponses(Array.from({ length: 5_000 }, () => step));
  gateway.models.setProvider(withCreditPause(faux.provider));
  return gateway;
}

export interface TestCell {
  readonly storage: FakeCelldStorage;
  readonly gateway: FauxGateway;
  cell: CellHarness;
  /** Closes the harness and opens it again on the same storage, as after a restart. */
  reopen(): Promise<CellHarness>;
}

export async function openTestCell(
  options: {
    readonly person?: string;
    readonly env?: CellEnv;
    readonly gateway?: FauxGateway;
    readonly now?: () => number;
    readonly fetch?: typeof fetch;
    readonly household?: HouseholdClient;
    readonly onWakeChange?: () => void;
    readonly routines?: OpenCellOptions["routines"];
    readonly storage?: FakeCelldStorage;
    readonly extensions?: OpenCellOptions["extensions"];
  } = {},
): Promise<TestCell> {
  const storage = options.storage ?? new FakeCelldStorage();
  const gateway = options.gateway ?? createFauxGateway();
  const open = () =>
    openCellHarness(storage, {
      person: options.person ?? "owner",
      version: "v0.0.0-test",
      env: options.env ?? {},
      models: gateway.models,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.household === undefined ? {} : { household: options.household }),
      ...(options.onWakeChange === undefined ? {} : { onWakeChange: options.onWakeChange }),
      ...(options.routines === undefined ? {} : { routines: options.routines }),
      ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    });
  const test: TestCell = {
    storage,
    gateway,
    cell: await open(),
    async reopen() {
      await test.cell.close();
      test.cell = await open();
      return test.cell;
    },
  };
  return test;
}

/** Polls `check` every 5 ms for up to `ms` milliseconds of real time. */
export async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** An in-process household cell: the real change log on the stand-in, with every change recorded. */
export interface HouseholdStub extends HouseholdClient {
  readonly log: ChangeLog;
  readonly changes: HouseholdChange[];
}

export function createHouseholdStub(): HouseholdStub {
  const log = new ChangeLog(new CelldSqliteDatabase(new FakeCelldStorage()));
  const changes: HouseholdChange[] = [];
  return {
    log,
    changes,
    read: (document) => log.read(document),
    apply: (change) => {
      changes.push(change);
      return log.apply(change);
    },
  };
}

/** Every JSON log line written through console.log while `spy` was active. */
export function loggedEvents(calls: readonly unknown[][]): Record<string, unknown>[] {
  return calls.flatMap(([line]) => {
    try {
      const value = JSON.parse(String(line)) as unknown;
      return value !== null && typeof value === "object" ? [value as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}
