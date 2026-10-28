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
 * A scripted lead that starts a research job for fasting questions, pulls a result when a wake
 * notice arrives or a `CALL job_result` line asks (a routine result waits for the lead), and
 * relays it as `Research says: <result>`. It stands in for the model's decision; the live check on
 * the test cell uses the real one.
 */
export function researchResponder(request: FauxRequest) {
  if (request.role === "lead") {
    if (request.last?.role === "toolResult") {
      const pulled = /\nResult:\n([\s\S]*)$/.exec(request.lastText)?.[1];
      if (pulled !== undefined) return fauxAssistantMessage([fauxText(`Research says: ${pulled}`)]);
      return fauxAssistantMessage([fauxText("I asked research.")]);
    }
    const wake = /^\[job (\d+) [a-z]+(?: [a-z0-9 ]+)?: pull it with job_result\]/.exec(
      request.lastText,
    );
    if (wake !== null) {
      return fauxAssistantMessage([fauxToolCall("job_result", { job: Number(wake[1]) })], {
        stopReason: "toolUse",
      });
    }
    const calls = scriptedCalls(request.lastText);
    if (calls.length > 0) {
      return fauxAssistantMessage(
        calls.map((call) => fauxToolCall(call.name, call.args)),
        { stopReason: "toolUse" },
      );
    }
    if (request.lastText.includes("fasting")) {
      return fauxAssistantMessage(
        [
          fauxToolCall("start_job", {
            title: "fasting and sleep",
            brief: BRIEF,
            template: "research",
          }),
        ],
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage([fauxText("Hello.")]);
  }
  return fauxAssistantMessage([fauxText(`${request.role} finding: evidence is mixed.`)]);
}

/** The person's line that makes a scripted lead pull job 1's result. */
export const PULL_JOB_1 = 'CALL job_result {"job":1}';

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
