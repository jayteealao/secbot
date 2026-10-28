/**
 * The lead's hand-off note: before older messages of the lead's conversation are summarized, the
 * lead's model writes a short note for itself (open promises, pending questions, the person's
 * recent preferences) from those messages and its previous note. The note is committed, shown in
 * the lead's prompt after the compaction, and its call is the lead's spend. Job state stays on the
 * board, never in the note.
 *
 * Compaction hooks are read-only (pi-durable `HookApi extends DocumentReader`), so the note is
 * written through the harness's own commit, as the job gate writes a pause. The model's answer is
 * kept in the compaction task's memo first, so a crash before the commit asks the model once. A
 * failed call keeps the previous note and never declines the compaction.
 */
import type { AssistantMessage, Models, Usage } from "@earendil-works/pi-ai";
import {
  CompactionTask,
  defineExtension,
  type Extension,
  type Harness,
  hook,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { errorFields, logEvent } from "./cell-parts.ts";
import { HandoffNoteDoc, RoleModelsDoc } from "./docs.ts";
import { transcriptText } from "./lead-tools.ts";
import { addToolUsage } from "./month-ledger.ts";
import {
  DEFAULT_LEAD_MODEL,
  GATEWAY_PROVIDER,
  HANDOFF_NOTE_MAX_CHARS,
  HANDOFF_NOTE_PROMPT,
  HANDOFF_NOTE_SOURCE_CHARS,
  HANDOFF_USAGE_KEY,
  LEAD_ROLE,
} from "./release-defaults.ts";

export interface HandoffNoteDeps {
  readonly person: string;
  readonly harness: () => Harness;
  readonly models: () => Models;
  readonly now: () => number;
}

/** The note call's answer, kept in the compaction task's memo (its usage as JSON text). */
type NoteMemo = { text: string; usage: string | null; sourceChars: number };

const textOf = (message: AssistantMessage): string =>
  message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

/** The note call's one user message: the previous note, then the messages about to be summarized. */
export function noteRequest(previous: string, source: string): string {
  return `Your previous note:\n${previous === "" ? "(none)" : previous}\n\n<transcript>\n${source}\n</transcript>`;
}

export function createHandoffNoteExtension(deps: HandoffNoteDeps): Extension {
  const { person } = deps;
  return defineExtension({
    name: "secbot-handoff-note",
    hooks: [
      hook(CompactionTask, {
        beforeCompact: async (compaction, api, context) => {
          if (String(api.conversationId) !== String(ROOT_CONVERSATION_ID)) return undefined;
          try {
            const source = transcriptText(compaction.entries, HANDOFF_NOTE_SOURCE_CHARS);
            let note = await api.memo<NoteMemo>("handoff-note", context);
            if (note === undefined) {
              const previous = (await api.snapshot(HandoffNoteDoc, context))?.note?.text ?? "";
              const overrides = (await api.snapshot(RoleModelsDoc, context))?.overrides ?? {};
              const modelId = overrides[LEAD_ROLE] ?? DEFAULT_LEAD_MODEL;
              const model = deps.models().getModel(GATEWAY_PROVIDER, modelId);
              if (model === undefined) throw new Error(`unknown model ${modelId}`);
              const message = await deps.models().completeSimple(
                model,
                {
                  systemPrompt: HANDOFF_NOTE_PROMPT,
                  messages: [
                    {
                      role: "user",
                      content: noteRequest(previous, source),
                      timestamp: deps.now(),
                    },
                  ],
                },
                context.abortSignal === undefined ? {} : { signal: context.abortSignal },
              );
              if (message.stopReason === "error" || message.stopReason === "aborted") {
                throw new Error(message.errorMessage ?? "the note call failed");
              }
              const text = textOf(message).trim().slice(0, HANDOFF_NOTE_MAX_CHARS);
              if (text === "") throw new Error("the note call answered with nothing");
              note = await api.memo<NoteMemo>(
                "handoff-note",
                {
                  text,
                  usage: message.usage === undefined ? null : JSON.stringify(message.usage),
                  sourceChars: source.length,
                },
                context,
              );
            }
            const kept = note;
            const usage = kept.usage === null ? null : (JSON.parse(kept.usage) as Usage);
            const firstKept = String(compaction.firstKept);
            const written = await deps.harness().commit(async (tx) => {
              const doc = await tx.doc(HandoffNoteDoc);
              // This compaction's note is written once, even when the hook runs again.
              if (doc.note?.firstKept === firstKept) return false;
              doc.note = {
                text: kept.text,
                at: deps.now(),
                firstKept,
                compactions: (doc.note?.compactions ?? 0) + 1,
              };
              if (usage !== null) {
                await addToolUsage(tx, ROOT_CONVERSATION_ID, HANDOFF_USAGE_KEY, usage);
              }
              return true;
            }, context);
            if (written) {
              logEvent("handoff_note.written", {
                cell: person,
                note_chars: kept.text.length,
                source_chars: kept.sourceChars,
                cost_usd: usage?.cost.total ?? 0,
              });
            }
          } catch (error) {
            logEvent("handoff_note.failed", { cell: person, ...errorFields(error) }, "warn");
          }
          return undefined;
        },
      }),
    ],
  });
}
