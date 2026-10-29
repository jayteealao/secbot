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
import {
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@secbot/cell-harness/testing";
import type { Io } from "../../cli/src/io.ts";
import { run } from "../../cli/src/main.ts";
import { sha256Hex } from "../src/device-auth.ts";
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
  await writeFile(
    join(where, `${name}.exit-code`),
    `${ran.code}
`,
  );
}

/** Writes one JSON evidence file under SECBOT_EVIDENCE_DIR, when set. */
export async function evidenceJson(name: string, value: unknown): Promise<void> {
  const where = process.env.SECBOT_EVIDENCE_DIR;
  if (where === undefined || where === "") return;
  await mkdir(where, { recursive: true });
  await writeFile(
    join(where, name),
    `${JSON.stringify(value, null, 2)}
`,
  );
}

export const PERSONS = ["owner", "second"] as const;
export const HOUSEHOLD_URL = "http://household.internal:8789";
export const HOUSEHOLD_PLAN =
  "Plan: Saturday market at 9, then the hardware store; split the list.";

/** The lead's words when it gives a person an offer (the spec's ask). */
export const OFFER_ASK = "Want to share this one? Answer with /join or /decline.";

/** The scripted models for shared jobs; any other line falls back to the guard's `CALL` script. */
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
  }
  if (request.role === "lead" && request.last?.role === "toolResult") {
    // After giving an offer, the lead asks in its own words.
    if (/shared offer|offer_shared|share the cost/.test(request.system + request.lastText)) {
      return fauxAssistantMessage([fauxText(OFFER_ASK)]);
    }
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
  /** Sets a person's monthly limit under their spend, so their budget counts as used up. */
  budgetOver(person: string): Promise<void>;
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
  let restoreFetch: (() => void) | undefined;
  if (options.fleets === 2) {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(HOUSEHOLD_URL)) {
        return route(new Request(input instanceof Request ? input : url, init), setup.env);
      }
      return original(input, init);
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
    budgetOver: async (person) => {
      // A zero limit: any spend at all is at or over it.
      await setup.harness(person).setLimit(0, "owner");
    },
    close: async () => {
      restoreFetch?.();
      await closeAll(setup);
      for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    },
  };
}
