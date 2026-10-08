import { type FauxRequest, fauxAssistantMessage, fauxText, fauxToolCall } from "./fixtures.ts";

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
