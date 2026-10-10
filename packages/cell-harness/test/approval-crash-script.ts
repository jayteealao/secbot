// The scripted model of the held-call crash test, shared by the child that is killed and the
// parent that reopens the cell: the lead answers the chat line with one hand-off call, and
// answers every tool result and report with plain text.
import { fauxAssistantMessage, fauxText, fauxToolCall, type Responder } from "./fixtures.ts";

export const CRASH_BRIEF = "Find direct trains to Leeds on Friday.";
export const CRASH_HANDOFF = "please hand this to research";

export const approvalCrashResponder: Responder = (request) => {
  if (request.role === "lead" && request.lastText === CRASH_HANDOFF) {
    return fauxAssistantMessage(
      [fauxToolCall("handoff", { specialist: "research", brief: CRASH_BRIEF })],
      { stopReason: "toolUse" },
    );
  }
  return fauxAssistantMessage([fauxText(`${request.role} done`)]);
};
