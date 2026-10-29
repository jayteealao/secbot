// Readers of a conversation's entries for the job tests: the lead's answers, tool results, and
// wake notices, oldest first.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";

/** Every entry of a conversation, oldest first. */
export async function entriesOf(conversation: Conversation): Promise<EntryRecord[]> {
  const page = await conversation.entries({}, 1_000, undefined, BACKGROUND_CONTEXT);
  return [...page.items].reverse();
}

/** The text of an entry's first model message. */
export function entryText(entry: EntryRecord): string {
  const message = entry.model?.[0] as Message | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  return (content ?? [])
    .flatMap((part) => (part.type === "text" ? [(part as { text: string }).text] : []))
    .join("");
}

/** The role of an entry's first model message. */
export const entryRole = (entry: EntryRecord): string | undefined =>
  (entry.model?.[0] as Message | undefined)?.role;

/** The assistant's text answers (tool-calling turns without text are left out). */
export async function answersOf(conversation: Conversation): Promise<string[]> {
  return (await entriesOf(conversation))
    .filter((entry) => entryRole(entry) === "assistant")
    .map(entryText)
    .filter((said) => said !== "");
}

/** Every tool result's text. */
export async function toolResultsOf(conversation: Conversation): Promise<string[]> {
  return (await entriesOf(conversation))
    .filter((entry) => entryRole(entry) === "toolResult")
    .map(entryText);
}

/** The tool calls the assistant made, by name, in order. */
export async function toolCallsOf(conversation: Conversation): Promise<string[]> {
  return (await entriesOf(conversation)).flatMap((entry) => {
    const message = entry.model?.[0] as Message | undefined;
    if (message?.role !== "assistant") return [];
    return (message.content as readonly { type: string; name?: string }[])
      .filter((part) => part.type === "toolCall")
      .map((part) => part.name ?? "");
  });
}

/** The wake notices the lead received. */
export async function wakeNoticesOf(conversation: Conversation): Promise<string[]> {
  return (await entriesOf(conversation))
    .filter((entry) => entryRole(entry) === "user")
    .map(entryText)
    .filter((said) => said.startsWith("[job "));
}
