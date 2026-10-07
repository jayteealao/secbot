/**
 * The lead's prompt sections: the current specialists, and the current time. Sections render
 * before each request from committed documents (pi-durable README "System Prompt"), so a
 * specialist the owner adds is in the lead's next request, and only a changed section is sent
 * again. The time is given to the minute, so it changes at most once a minute.
 */
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { RosterDoc } from "./docs.ts";
import { localTime } from "./reminder.ts";

export interface TimeEnv {
  /** The person's time zone (IANA, for example Europe/London); UTC when unset. */
  readonly SECBOT_TIME_ZONE?: string;
}

/** The zone the lead states times in: the configured one when the runtime knows it, else UTC. */
export function timeZoneOf(env: TimeEnv): string {
  const zone = env.SECBOT_TIME_ZONE?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

/** The time section's text at `now`. */
export function timeSection(now: number, timeZone: string): string {
  const minute = Math.floor(now / 60_000) * 60_000;
  return [
    `Now: ${new Date(minute).toISOString().slice(0, 16)}Z (UTC); ${localTime(minute, timeZone)} in ${timeZone}, the person's time zone.`,
    "Read times the person gives in their time zone unless they name another one.",
  ].join("\n");
}

const firstSentence = (text: string) => {
  const end = text.indexOf(". ");
  return end === -1 ? text : text.slice(0, end + 1);
};

export function createLeadExtension(
  clock: { readonly now: () => number; readonly timeZone: string } = {
    now: Date.now,
    timeZone: "UTC",
  },
): Extension {
  return defineExtension({
    name: "secbot-lead",
    sections: [
      section("time", () => timeSection(clock.now(), clock.timeZone)),
      section("specialists", async (input, context) => {
        const roster = await input.read.snapshot(RosterDoc, context);
        const names = Object.entries(roster?.specialists ?? {});
        if (names.length === 0) return "You have no specialists yet.";
        return [
          "Your specialists (brief one with the handoff tool):",
          ...names.map(([name, record]) => `- ${name}: ${firstSentence(record.instruction)}`),
        ].join("\n");
      }),
    ],
  });
}
