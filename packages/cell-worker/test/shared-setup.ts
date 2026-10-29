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
import {
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@secbot/cell-harness/testing";
import { route } from "../src/routes.ts";
import { closeAll, type GuardSetup, guardSetup, OPERATOR_KEY, scripted } from "./guard-setup.ts";

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
  /** Sets a person's monthly limit under their spend, so their budget counts as used up. */
  budgetOver(person: string): Promise<void>;
  close(): Promise<void>;
}

export async function sharedSetup(options: {
  readonly fleets: 1 | 2;
  readonly clock?: () => number;
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
    budgetOver: async (person) => {
      // A zero limit: any spend at all is at or over it.
      await setup.harness(person).setLimit(0, "owner");
    },
    close: async () => {
      restoreFetch?.();
      await closeAll(setup);
    },
  };
}
