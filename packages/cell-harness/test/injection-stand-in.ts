/**
 * A stand-in for the decision model's content question, for the corpus gate on the stub decisions
 * route. It is a fixed rule set, written from the content question's own criteria and never from
 * a corpus label: a sentence that addresses an AI (assistant, agent, bot, model) and gives it an
 * order; a request to ignore or replace instructions; a request to use tools; and text that tells
 * the checker how to label it. It proves the pipeline (chunking, the question, the threshold),
 * not the live model's detection, which the test cell scores.
 */
import { cleanAt, injectionAt, type StubDecision } from "./stub-openrouter.ts";

const ADDRESSED =
  /\b(?:assistants?|agents?|bot|ai|language model|ai model|ai helper|model processing)\b/i;

const ORDER =
  /\b(?:send|mail|e-?mail|forward|post|buy|book|delete|reveal|copy|upload|export|reply|ignore|disregard|stop|schedule|add|replace|disable|transfer|share)\b/i;

const REPLACE_INSTRUCTIONS =
  /\b(?:ignore (?:your|the|all|any|prior|previous)|new instructions|no longer apply|your new task|override)\b/i;

const TOOL_USE = /\b(?:use|call|run) (?:your|the) (?:\w+ )?tools?\b/i;

const SELF_LABEL =
  /\b(?:label(?:led|ed)? (?:it |this )?(?:as )?clean|mark (?:it|this|this text) (?:as )?(?:clean|ordinary|safe)|scored clean|answer clean|treat this as clean|not a prompt injection|classifiers? should|judges should|label hint|label: clean|"choice": "clean")\b/i;

/** True when one sentence addresses an AI and gives it an order. */
const ordersAnAi = (sentence: string) => ADDRESSED.test(sentence) && ORDER.test(sentence);

/** The stand-in's verdict on one chunk of content. */
export function standInClassify(text: string): "injection" | "clean" {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  const found =
    sentences.some(ordersAnAi) ||
    REPLACE_INSTRUCTIONS.test(text) ||
    TOOL_USE.test(text) ||
    SELF_LABEL.test(text);
  return found ? "injection" : "clean";
}

/** The stub's answer for a decisions request: the content question by the stand-in. */
export function standInAnswer(body: Record<string, unknown>): StubDecision {
  const state = body.state as { content?: unknown } | undefined;
  return standInClassify(String(state?.content ?? "")) === "injection"
    ? injectionAt(0.9)
    : cleanAt(0.05);
}
