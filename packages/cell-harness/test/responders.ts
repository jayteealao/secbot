import {
  type FauxRequest,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Responder,
} from "./fixtures.ts";

export const BRIEF =
  "Summarize what is known about intermittent fasting and sleep, with the uncertainty.";

/**
 * A scripted lead that hands fasting questions to research by calling the tool, and relays the
 * report. It stands in for the model's decision; the live check on the test cell uses the real one.
 */
export function handoffResponder(request: FauxRequest) {
  if (request.role === "lead") {
    if (request.last?.role === "toolResult") {
      return fauxAssistantMessage([fauxText("I asked research.")]);
    }
    if (request.lastText.startsWith("[handoff research answered]")) {
      return fauxAssistantMessage([fauxText(`Research says: ${request.lastText.slice(28)}`)]);
    }
    if (request.lastText.includes("fasting")) {
      return fauxAssistantMessage(
        [fauxToolCall("handoff", { specialist: "research", brief: BRIEF })],
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage([fauxText("Hello.")]);
  }
  return fauxAssistantMessage([fauxText(`${request.role} finding: evidence is mixed.`)]);
}

/** A research brief the scripted lead sends with start_job. */
export const JOB_BRIEF = "Compare direct flights to Lisbon in May and list the cheapest three.";

/** A scripted `start_job` call line: the person's message carries it for the faux lead. */
export const startJobLine = (args: Record<string, unknown>) =>
  `CALL start_job ${JSON.stringify(args)}`;

/** The research job of the charter scenario, as a `start_job` call line. */
export const RESEARCH_JOB = startJobLine({
  title: "comparing direct flights to Lisbon in May",
  brief: JOB_BRIEF,
  template: "research",
  priority: "routine",
});

/** Every `CALL <tool> {json}` line of a text, in order. */
type CallArgs = Parameters<typeof fauxToolCall>[1];

export function scriptedCalls(text: string): { name: string; args: CallArgs }[] {
  return text.split("\n").flatMap((line) => {
    const match = /^CALL ([a-z_]+) (\{.*\})\s*$/.exec(line.trim());
    if (match === null) return [];
    return [{ name: match[1] as string, args: JSON.parse(match[2] as string) as CallArgs }];
  });
}

/**
 * A scripted lead for jobs: a person's message with `CALL <tool> {json}` lines calls those tools in
 * one round; after a `start_job` result it replies with the one-line notice the result gives; a
 * wake notice is acknowledged. A job conversation answers its brief.
 */
export function jobResponder(request: FauxRequest) {
  if (request.role === "lead") {
    if (request.last?.role === "toolResult") {
      const notice = /Tell the person in one line: (.*)$/m.exec(request.lastText)?.[1];
      return fauxAssistantMessage([fauxText(notice ?? "OK.")]);
    }
    const calls = scriptedCalls(request.lastText);
    if (calls.length > 0) {
      return fauxAssistantMessage(
        calls.map((call) => fauxToolCall(call.name, call.args)),
        { stopReason: "toolUse" },
      );
    }
    if (request.lastText.startsWith("[job ")) return fauxAssistantMessage([fauxText("Noted.")]);
    return fauxAssistantMessage([fauxText(`lead says: ${request.lastText.slice(0, 40)}`)]);
  }
  return fauxAssistantMessage([fauxText(`${request.role} finding: evidence is mixed.`)]);
}

/**
 * Holds a role's requests open until released: `hold("research")` makes every later research
 * request wait; `release("research")` lets the waiting ones and later ones answer.
 */
export interface Hold {
  hold(role: string): void;
  release(role: string): void;
  /** How many requests of `role` wait now. */
  waiting(role: string): number;
  wrap(inner: Responder): Responder;
}

export function createHold(): Hold {
  const held = new Map<string, { promise: Promise<void>; open: () => void; count: number }>();
  return {
    hold(role) {
      if (held.has(role)) return;
      let open = () => {};
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      held.set(role, { promise, open, count: 0 });
    },
    release(role) {
      held.get(role)?.open();
      held.delete(role);
    },
    waiting: (role) => held.get(role)?.count ?? 0,
    wrap: (inner) => async (request) => {
      const gate = held.get(request.role);
      if (gate !== undefined) {
        gate.count++;
        await gate.promise;
        gate.count--;
      }
      return inner(request);
    },
  };
}
