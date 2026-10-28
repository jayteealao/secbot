// The scripted model of the held-call crash test, shared by the child that is killed and the
// parent that reopens the cell: the lead answers the chat line with one job start, and answers
// every tool result and notice with plain text.
import { fauxAssistantMessage, fauxText, fauxToolCall, type Responder } from "./fixtures.ts";

export const CRASH_BRIEF = "Find direct trains to Leeds on Friday.";
export const CRASH_HANDOFF = "please start a research job on this";

export const approvalCrashResponder: Responder = (request) => {
  if (request.role === "lead" && request.lastText === CRASH_HANDOFF) {
    return fauxAssistantMessage(
      [
        fauxToolCall("start_job", {
          title: "trains to Leeds",
          brief: CRASH_BRIEF,
          template: "research",
        }),
      ],
      { stopReason: "toolUse" },
    );
  }
  return fauxAssistantMessage([fauxText(`${request.role} done`)]);
};
