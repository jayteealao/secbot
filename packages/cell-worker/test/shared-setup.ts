/**
 * The stand-in for shared household jobs: the worker, real `owner` and `second` person cells,
 * and a real household cell that runs shared jobs on the faux gateway. With two fleets the owner
 * cell reaches the household over HTTP through the worker's internal route (as the owner's fleet
 * does across fleets); with one, every cell uses the household binding.
 *
 * Scripted models: a lead line `SHARE <title>` makes the lead propose a shared job; a wake with an
 * offer makes the other lead give the offer and ask in its own words; a joined notice makes the
 * lead say the notice's line; the household job answers a fixed plan text.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { DEFAULT_PERSON_LIMIT_USD, JobBoardDoc, type JobRow } from "@secbot/cell-harness";
import {
  addSpend,
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  until,
} from "@secbot/cell-harness/testing";
import { CellClient } from "../../cli/src/client.ts";
import { type Frame, frameRenderer } from "../../cli/src/commands/chat.ts";
import { answerShared, SHARED_NOT_SENT, sharedOf } from "../../cli/src/commands/shared-confirm.ts";
import type { Io } from "../../cli/src/io.ts";
import { run } from "../../cli/src/main.ts";
import { sha256Hex } from "../src/device-auth.ts";
import type { SocketLike } from "../src/person-cell.ts";
import { route, type WorkerEnv } from "../src/routes.ts";
import {
  closeAll,
  type GuardSetup,
  guardSetup,
  HOST,
  KEY,
  OPERATOR_KEY,
  scripted,
} from "./guard-setup.ts";

/** The second person's device key (a fake test key). */
export const SECOND_KEY = "second-laptop-key-89abcdef0123456789abcdef01234567"; // gitleaks:allow (fake test key)

/** What a command printed and its exit code. */
export interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Writes a command's output under SECBOT_EVIDENCE_DIR (stdout, stderr, exit code), when set. */
export async function evidence(name: string, ran: Ran): Promise<void> {
  const where = process.env.SECBOT_EVIDENCE_DIR;
  if (where === undefined || where === "") return;
  await mkdir(where, { recursive: true });
  await writeFile(join(where, `${name}.stdout.txt`), ran.out);
  await writeFile(join(where, `${name}.stderr.txt`), ran.err);
  await writeFile(join(where, `${name}.exit-code`), `${ran.code}\n`);
}

/** Writes one JSON evidence file under SECBOT_EVIDENCE_DIR, when set. */
export async function evidenceJson(name: string, value: unknown): Promise<void> {
  const where = process.env.SECBOT_EVIDENCE_DIR;
  if (where === undefined || where === "") return;
  await mkdir(where, { recursive: true });
  await writeFile(join(where, name), `${JSON.stringify(value, null, 2)}\n`);
}

export const PERSONS = ["owner", "second"] as const;
export const HOUSEHOLD_URL = "http://household.internal:8789";
export const HOUSEHOLD_PLAN =
  "Plan: Saturday market at 9, then the hardware store; split the list.";

/** The lead's words when it gives a person an offer (the spec's ask). */
export const OFFER_ASK = "Want to share this one? Answer with /join or /decline.";

/** The lead's words after it asked the other person to share a job. */
export const askedText = (other: string) => `I asked ${other} to share it.`;

/** The lead's words when it relays a result it pulled with `job_result`. */
export const relayText = (result: string) => `Result for you: ${result}`;

/**
 * The scripted models for shared jobs; any other line falls back to the guard's `CALL` script.
 * After a tool, the lead's words follow that tool's own result, never its system prompt: after
 * giving an offer it asks; after proposing it says it asked; after `job_result` it relays the
 * result. A failure or risky wake makes the lead pull that result.
 */
export function sharedResponder(request: FauxRequest) {
  if (request.role === "household") {
    return fauxAssistantMessage([fauxText(HOUSEHOLD_PLAN)]);
  }
  if (request.role === "lead" && request.last?.role !== "toolResult") {
    const share = /^SHARE (.+)$/m.exec(request.lastText);
    if (share !== null) {
      const title = share[1] ?? "";
      return fauxAssistantMessage(
        [fauxToolCall("propose_shared_job", { title, brief: `${title}, for both of us.` })],
        { stopReason: "toolUse" },
      );
    }
    const offer = /\[job (\d+) shared offer from /.exec(request.lastText);
    if (offer !== null) {
      return fauxAssistantMessage([fauxToolCall("offer_shared", { job: Number(offer[1]) })], {
        stopReason: "toolUse",
      });
    }
    const joined = /Tell the person in one line: (.+)\]/.exec(request.lastText);
    if (joined !== null) return fauxAssistantMessage([fauxText(joined[1] ?? "")]);
    const wake = /^\[job (\d+) (failure|risky): pull it with job_result\]/.exec(request.lastText);
    if (wake !== null) {
      return fauxAssistantMessage([fauxToolCall("job_result", { job: Number(wake[1]) })], {
        stopReason: "toolUse",
      });
    }
  }
  if (request.role === "lead" && request.last?.role === "toolResult") {
    const said = request.lastText;
    if (said.startsWith("Ask the person in your own words now;")) {
      return fauxAssistantMessage([fauxText(OFFER_ASK)]);
    }
    const proposed = /^job \d+ waits for (\S+) to agree to share the cost;/.exec(said);
    if (proposed !== null) return fauxAssistantMessage([fauxText(askedText(proposed[1] ?? ""))]);
    const pulled = /^job \d+ "[^\n]*" \([a-z]+\), brief: [^\n]*\nResult:\n([\s\S]*)$/.exec(said);
    if (pulled !== null) return fauxAssistantMessage([fauxText(relayText(pulled[1] ?? ""))]);
  }
  return scripted(request);
}

export interface SharedSetup extends GuardSetup {
  /** Every outbound fetch the household cell made (its heartbeat pings, if any). */
  readonly householdFetches: string[];
  /** How many fleets serve the cells: one, or the owner's and the other one. */
  readonly fleets: 1 | 2;
  /**
   * The worker fetch of the fleet that serves `person` (the owner's fleet for `owner` and for the
   * operator's commands, as the owner's laptop reaches it).
   */
  fetchFor(person: string): typeof fetch;
  /**
   * Runs `secbot <argv>` in process as `person` with their device file (and the operator key with
   * `operator`), with no TTY.
   */
  secbotAs(person: string, argv: readonly string[], options?: { operator?: boolean }): Promise<Ran>;
  /**
   * Books spend over a small limit for `person` and waits until the household's budget board reads
   * the person as used up, as the household reads it when it splits a charge.
   */
  budgetOver(person: string): Promise<void>;
  /** Raises `person`'s limit back to the default and waits until the household reads it. */
  budgetBack(person: string): Promise<void>;
  /**
   * Two fleets: the next shared-job exchange `person` sends across fleets reaches the household,
   * which applies it, and its answer is lost (a 503), so the person sends the same ops again.
   */
  dropNextAnswer(person: string): void;
  /** Each shared-job exchange sent across fleets: who sent it, its op ids, and the answer status. */
  readonly crossFleetSyncs: { person: string; opIds: string[]; status: number }[];
  close(): Promise<void>;
}

export async function sharedSetup(options: {
  readonly fleets: 1 | 2;
  readonly clock?: () => number;
  /** The cost of one answered model step, in USD (default $0.01), so jobs settle charges. */
  readonly stepCostUsd?: (modelId: string) => number;
}): Promise<SharedSetup> {
  const householdFetches: string[] = [];
  const householdFetch: typeof fetch = async (input) => {
    householdFetches.push(input instanceof Request ? input.url : String(input));
    return new Response(null, { status: 204 });
  };
  const setup = await guardSetup(options.fleets === 2 ? "second,household" : undefined, {
    household: true,
    persons: PERSONS,
    respond: sharedResponder,
    householdFetch,
    sockets: true,
    stepCostUsd: options.stepCostUsd ?? (() => 0.01),
    ...(options.clock === undefined ? {} : { now: options.clock }),
    // Two fleets: the owner's fleet has no household cell of its own and calls the household's
    // fleet over HTTP with the operator key.
    ...(options.fleets === 2
      ? {
          personEnv: (person: string): Record<string, string> =>
            person === "owner"
              ? { SECBOT_HOUSEHOLD_URL: HOUSEHOLD_URL, SECBOT_OPERATOR_KEY: OPERATOR_KEY }
              : {},
        }
      : {}),
  });
  // Both persons have a device.
  const env = setup.env as { SECBOT_DEVICE_KEYS?: string };
  env.SECBOT_DEVICE_KEYS = `${env.SECBOT_DEVICE_KEYS ?? ""},laptop2:second:${await sha256Hex(SECOND_KEY)}`;
  // Two fleets: the owner's fleet serves only the owner's cell and reaches the household's fleet
  // at its private address, over the same cells.
  const ownerEnv: WorkerEnv =
    options.fleets === 2
      ? { ...setup.env, SECBOT_FLEET_CELLS: "owner", SECBOT_HOUSEHOLD_URL: HOUSEHOLD_URL }
      : setup.env;
  const fetchOf =
    (env: WorkerEnv): typeof fetch =>
    (input, init) =>
      route(new Request(input instanceof Request ? input : String(input), init), env);
  const fetchFor = (person: string) => fetchOf(person === "owner" ? ownerEnv : setup.env);
  const dirs: string[] = [];
  const secbotAs = async (
    person: string,
    argv: readonly string[],
    runOptions: { operator?: boolean } = {},
  ): Promise<Ran> => {
    const dir = await mkdtemp(join(tmpdir(), `secbot-shared-${person}-`));
    dirs.push(dir);
    await writeFile(
      join(dir, "device.json"),
      JSON.stringify({
        name: person === "owner" ? "laptop" : "laptop2",
        person,
        key: person === "owner" ? KEY : SECOND_KEY,
      }),
    );
    let out = "";
    let err = "";
    const io: Io = {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      lines: async function* () {},
    };
    const environment = {
      env: {
        SECBOT_CONFIG_DIR: dir,
        SECBOT_CELL_URL: `http://${HOST}`,
        ...(runOptions.operator === true ? { SECBOT_OPERATOR_KEY: OPERATOR_KEY } : {}),
      },
      home: dir,
    };
    const code = await run([...argv], {
      environment,
      io,
      fetch: fetchFor(runOptions.operator === true ? "owner" : person),
    });
    return { code, out, err };
  };
  const drops = new Set<string>();
  const crossFleetSyncs: { person: string; opIds: string[]; status: number }[] = [];
  /** Waits until the household's newest spend report for `person` reads used up (or not). */
  const householdReads = async (person: string, over: boolean) => {
    const household = setup.household;
    if (household === undefined) throw new Error("no household cell");
    await until(async () => {
      const report = (await household.budget()).reports.find((each) => each.cell === person);
      return report !== undefined && report.spentUsd >= report.limitUsd === over;
    });
  };
  const limitTo = async (person: string, usd: number, over: boolean) => {
    const harness = setup.harness(person);
    await harness.setLimit(usd, "owner");
    harness.budget.watch.trigger();
    await harness.budget.watch.settled();
    await householdReads(person, over);
  };
  let restoreFetch: (() => void) | undefined;
  if (options.fleets === 2) {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(HOUSEHOLD_URL)) return original(input, init);
      const request = new Request(input instanceof Request ? input : url, init);
      if (!url.endsWith("/internal/household/shared-sync")) return route(request, setup.env);
      const body = (await request.clone().json()) as {
        person: string;
        ops: { opId: string }[];
      };
      const answered = await route(request, setup.env);
      const lost = drops.delete(body.person);
      const status = lost ? 503 : answered.status;
      crossFleetSyncs.push({ person: body.person, opIds: body.ops.map((op) => op.opId), status });
      return lost ? Response.json({ error: "unavailable" }, { status: 503 }) : answered;
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
  }
  return {
    ...setup,
    householdFetches,
    fleets: options.fleets,
    fetchFor,
    secbotAs,
    crossFleetSyncs,
    budgetOver: async (person) => {
      // The limit must be above zero, so the spend goes over a small one.
      await addSpend(setup.harness(person), 0.02);
      await limitTo(person, 0.01, true);
    },
    budgetBack: (person) => limitTo(person, DEFAULT_PERSON_LIMIT_USD, false),
    dropNextAnswer: (person) => {
      if (options.fleets !== 2 || person !== "owner") {
        throw new Error("only the owner's exchange crosses fleets");
      }
      drops.add(person);
    },
    close: async () => {
      restoreFetch?.();
      delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
      await closeAll(setup);
      for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A scripted `secbot chat` session of one person on the stand-in. */
export interface ChatSession {
  /** Opens the person's real session route with their device key; frames print as chat prints them. */
  open(): Promise<void>;
  /** Sends one line as `secbot chat` routes it: a join or decline to its route, others to the lead. */
  say(line: string): Promise<void>;
  /** Drops the connection and opens it again, with the same renderer (as chat keeps one). */
  reconnect(): Promise<void>;
  close(): Promise<void>;
  /** What the session printed to stdout, with the person's own lines as `> <line>`. */
  out(): string;
  err(): string;
  /** How many route calls the session's own client made (the join and decline routes). */
  routed(): number;
}

/**
 * `secbot chat` for `person`, driven in process: one CLI renderer for the whole session, a stand-in
 * socket pair on the person cell's real session route, and the CLI's own join and decline path.
 */
export function chatSession(setup: SharedSetup, person: string): ChatSession {
  let out = "";
  let err = "";
  const io: Io = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    lines: async function* () {},
  };
  const renderer = frameRenderer(io);
  let routed = 0;
  const client = new CellClient(
    `http://${HOST}`,
    {
      name: person === "owner" ? "laptop" : "laptop2",
      person,
      key: person === "owner" ? KEY : SECOND_KEY,
    },
    (input, init) => {
      routed += 1;
      return setup.fetchFor(person)(input, init);
    },
  );
  let socket: (SocketLike & { closed: boolean }) | undefined;
  let requestNo = 0;
  const cell = () => {
    const found = setup.cells.get(person);
    if (found === undefined) throw new Error(`the ${person} cell is not open`);
    return found;
  };
  const session: ChatSession = {
    async open() {
      const server = {
        closed: false,
        send(data: string) {
          if (!this.closed) renderer.handle(JSON.parse(data) as Frame);
        },
        close() {
          this.closed = true;
        },
      };
      socket = server;
      (globalThis as { WebSocketPair?: unknown }).WebSocketPair = class {
        0 = { send() {}, close() {} };
        1 = server;
      };
      // Node refuses a 101 Response, so the opening settles as a rejection after the frames.
      await setup
        .fetchFor(person)(`http://${HOST}${client.path("/session")}`, { headers: client.headers })
        .catch(() => undefined);
    },
    async say(line) {
      out += `> ${line}\n`;
      const shared = sharedOf(line.trim());
      if (shared.kind === "join" || shared.kind === "decline") {
        renderer.print("");
        await answerShared(client, io, shared.job, shared.kind === "join");
        return;
      }
      if (shared.kind === "malformed") {
        io.stderr(`${SHARED_NOT_SENT}\n`);
        return;
      }
      if (socket === undefined) throw new Error("no open chat");
      await cell().webSocketMessage(
        socket,
        JSON.stringify({ type: "input", text: line, requestId: `${person}-chat-${++requestNo}` }),
      );
    },
    async reconnect() {
      await session.close();
      await session.open();
    },
    async close() {
      const current = socket;
      if (current === undefined) return;
      await cell().webSocketClose(current, 1000);
      current.closed = true;
      socket = undefined;
    },
    out: () => out,
    err: () => err,
    routed: () => routed,
  };
  return session;
}

/** The household's own board row for its job `n` (where its task id and conversation live). */
export async function householdRow(setup: SharedSetup, n: number): Promise<JobRow | undefined> {
  const household = setup.household as unknown as
    | { open(): Promise<{ readonly harness: Harness }> }
    | undefined;
  if (household === undefined) throw new Error("no household cell");
  // The household cell keeps its harness private; the stand-in reads its board directly.
  const { harness } = await household.open();
  return (await harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT))?.jobs[String(n)];
}

/** Every line within 80 columns, with no control code but the newline. */
export function fitsTerminal(text: string): boolean {
  return text
    .split("\n")
    .every(
      (line) =>
        line.length <= 80 &&
        [...line].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
    );
}
