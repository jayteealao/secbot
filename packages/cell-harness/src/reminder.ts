/**
 * One-off reminders. The lead's `set_reminder { at, text }` tool creates a `reminder` routine
 * whose wake time is `at`. At that time the routine submits `[reminder] <text>` to the lead's root
 * conversation as a follow-up input with request id `reminder:<taskId>`, so the lead relays it to
 * the person: into an open session, or into `missed`. The request id makes a repeated delivery
 * after a crash a no-op (the hand-off reporter's pattern, handoff.ts).
 */
import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTool,
  type Extension,
  type Harness,
  type JsonObject,
  ROOT_CONVERSATION_ID,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { shortText } from "./budget-gate.ts";
import { logEvent } from "./cell-parts.ts";
import { createRoutineTask, defineRoutine, type Routine, type RoutineHooks } from "./routines.ts";

export const REMINDER_ROUTINE = "reminder";
/** A reminder the lead receives starts with this. */
export const REMINDER_PREFIX = "[reminder] ";
export const REMINDER_TEXT_LIMIT = 500;
const PAST_TOLERANCE_MS = 60_000;
const FUTURE_LIMIT_MS = 366 * 24 * 60 * 60_000;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export type ReminderPayload = JsonObject & { text: string };

/** At most this many reminders wait at once in one cell; each is a live task and a timer. */
export const REMINDER_LIVE_LIMIT = 200;
/** A reminder's idempotency record is kept this long after its time, for a rerun after a crash. */
const KEEP_AFTER_MS = 24 * 60 * 60_000;

/**
 * `secbot.reminders`: the reminder task each `set_reminder` call created, by tool task and call,
 * and its wake time (absent on records written before wake times were kept).
 */
export const RemindersDoc = defineDoc<{
  byCall: Record<string, TaskId>;
  wakeAt?: Record<string, number>;
}>({
  kind: "secbot.reminders",
  version: 1,
  scope: "session",
  initial: () => ({ byCall: {} }),
});

export function createReminderRoutine(hooks: RoutineHooks): Routine<ReminderPayload> {
  return defineRoutine<ReminderPayload>(
    {
      name: REMINDER_ROUTINE,
      // Above the person's limit a reminder waits, like every routine that reaches the lead.
      describe: (payload) => `reminder ${shortText(payload.text)}`,
      run: async ({ runtime, taskId, payload, context }) => {
        const lead = await runtime.conversation(ROOT_CONVERSATION_ID, context);
        if (lead === undefined) throw new Error("the lead's conversation is missing");
        await lead.submit(
          {
            type: "input",
            content: `${REMINDER_PREFIX}${payload.text}`,
            whenBusy: "followUp",
            requestId: `reminder:${taskId}`,
          },
          context,
        );
        return { outcome: "delivered" };
      },
    },
    hooks,
  );
}

/** Why a reminder time or text is refused, or undefined when both are fine. */
export function reminderProblem(at: string, text: string, now: number): string | undefined {
  if (!ISO_WITH_OFFSET.test(at)) {
    return `"${at}" is not an ISO 8601 time with an offset, for example 2026-10-07T18:00:00+01:00`;
  }
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return `"${at}" is not a valid time`;
  if (time < now - PAST_TOLERANCE_MS) return `${at} is in the past`;
  if (time > now + FUTURE_LIMIT_MS) return `${at} is more than a year ahead`;
  if (text.trim() === "") return "the reminder needs a text";
  if (text.length > REMINDER_TEXT_LIMIT) {
    return `the reminder text is longer than ${REMINDER_TEXT_LIMIT} characters`;
  }
  return undefined;
}

/**
 * Creates a reminder in `tx`. `key` makes it idempotent: a second call with the same key returns
 * the first reminder's task.
 */
export async function createReminder(
  tx: Tx,
  routine: Routine<ReminderPayload>,
  key: string,
  wakeAt: number,
  text: string,
  now: number = Date.now(),
): Promise<
  | { readonly taskId: TaskId; readonly created: boolean; readonly refused?: undefined }
  | { readonly refused: string; readonly taskId?: undefined; readonly created: false }
> {
  const doc = await tx.doc(RemindersDoc);
  const existing = Object.hasOwn(doc.byCall, key) ? doc.byCall[key] : undefined;
  if (existing !== undefined) return { taskId: existing, created: false };
  doc.wakeAt ??= {};
  // Records whose time passed a day ago are no longer needed for a rerun; dropping them keeps the
  // doc from growing with every reminder ever set.
  let live = 0;
  for (const [call, at] of Object.entries(doc.wakeAt)) {
    if (at < now - KEEP_AFTER_MS) {
      delete doc.wakeAt[call];
      delete doc.byCall[call];
    } else if (at >= now) {
      live++;
    }
  }
  if (live >= REMINDER_LIVE_LIMIT) {
    return {
      refused: `${REMINDER_LIVE_LIMIT} reminders are already waiting; one must pass before another is set`,
      created: false,
    };
  }
  const taskId = await createRoutineTask(tx, routine, wakeAt, { text });
  doc.byCall[key] = taskId;
  doc.wakeAt[key] = wakeAt;
  return { taskId, created: true };
}

/** Sets a reminder from host code (the test-cell lab); the lead uses the tool. */
export async function scheduleReminder(
  harness: Harness,
  routine: Routine<ReminderPayload>,
  key: string,
  wakeAt: number,
  text: string,
  context: Context,
): Promise<TaskId> {
  const result = await harness.commit(
    (tx) => createReminder(tx, routine, key, wakeAt, text),
    context,
  );
  if (result.refused !== undefined) throw new Error(result.refused);
  return result.taskId;
}

/** Formats `at` for the person in `timeZone` (IANA); UTC when the zone is unknown. */
export function localTime(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).format(at);
  } catch {
    return new Date(at).toISOString();
  }
}

/** The lead's `set_reminder` tool and the reminder routine's task. */
export function createReminderExtension(
  routine: Routine<ReminderPayload>,
  hooks: RoutineHooks & { readonly now: () => number; readonly timeZone: string },
): Extension {
  const setReminder = defineTool({
    name: "set_reminder",
    description:
      "Set a one-off reminder for the person. At the time, you receive a message that starts with [reminder]; tell the person. Give the time as ISO 8601 with the offset, for example 2026-10-07T18:00:00+01:00, worked out from the current time in your instructions.",
    parameters: Type.Object({
      at: Type.String({ description: "When, ISO 8601 with the offset." }),
      text: Type.String({ minLength: 1, description: "What to remind the person of." }),
    }),
    // The reminder is recorded under this call's task and id, so a rerun after a crash creates none.
    replay: "safe",
    execute: async (args, api, context) => {
      const problem = reminderProblem(args.at, args.text, hooks.now());
      if (problem !== undefined) {
        return { content: [{ type: "text", text: `Not set: ${problem}.` }], isError: true };
      }
      const wakeAt = Date.parse(args.at);
      const result = await api.commit(
        (tx) =>
          createReminder(
            tx,
            routine,
            `${api.taskId}:${api.callId}`,
            wakeAt,
            args.text,
            hooks.now(),
          ),
        context,
      );
      if (result.refused !== undefined) {
        logEvent("reminder.refused", { cell: hooks.cell, reason: "live_limit" }, "warn");
        return { content: [{ type: "text", text: `Not set: ${result.refused}.` }], isError: true };
      }
      const { taskId, created } = result;
      if (created) {
        logEvent("reminder.set", {
          cell: hooks.cell,
          task_id: taskId,
          wake_at: new Date(wakeAt).toISOString(),
        });
        hooks.onWakeChange?.();
      }
      return {
        content: [
          {
            type: "text",
            text: `Reminder set for ${new Date(wakeAt).toISOString()} (${localTime(wakeAt, hooks.timeZone)}).`,
          },
        ],
        details: { taskId: String(taskId), wakeAt },
      };
    },
  });
  return defineExtension({ name: "secbot-reminder", tools: [setReminder], tasks: [routine.task] });
}
