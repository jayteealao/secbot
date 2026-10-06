/**
 * The lead's prompt section listing the current specialists. Sections render before each request
 * from committed documents (pi-durable README "System Prompt"), so a specialist the owner adds is
 * in the lead's next request, and only a changed list is sent again.
 */
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";
import { RosterDoc } from "./docs.ts";

const firstSentence = (text: string) => {
  const end = text.indexOf(". ");
  return end === -1 ? text : text.slice(0, end + 1);
};

export function createLeadExtension(): Extension {
  return defineExtension({
    name: "secbot-lead",
    sections: [
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
