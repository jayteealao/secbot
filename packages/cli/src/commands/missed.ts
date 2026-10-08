// `secbot missed`: calls waiting for an answer first (HELD CALLS), then limit notices this device
// has not seen, then what the lead said while no session was open, oldest first.
import type { CellClient } from "../client.ts";
import type { Io } from "../io.ts";
import { type HeldCall, heldSection } from "./held.ts";
import { type Notice, noticeBlock, type Waiting } from "./usage.ts";

type Missed =
  | { kind: "answer"; entryId: number; text: string }
  | { kind: "followup"; entryId: number; from: string; text: string };

export async function missed(client: CellClient, io: Io): Promise<number> {
  const {
    held = [],
    notices = [],
    waiting = [],
    messages,
    remaining = 0,
  } = await client.request<{
    held?: HeldCall[];
    notices?: Notice[];
    waiting?: Waiting[];
    messages: Missed[];
    remaining?: number;
  }>("GET", "/missed");
  if (held.length === 0 && notices.length === 0 && messages.length === 0) {
    io.stdout("no missed messages\n");
    return 0;
  }
  const sections: string[][] = [];
  if (held.length > 0) sections.push(heldSection(held));
  for (const notice of notices) sections.push(noticeBlock(notice, waiting));
  if (sections.length > 0) {
    io.stdout(`${sections.map((lines) => lines.join("\n")).join("\n\n")}\n`);
    if (messages.length > 0) io.stdout("\n");
  }
  for (const message of messages) {
    io.stdout(
      message.kind === "answer"
        ? `lead: ${message.text}\n`
        : `[from ${message.from}] ${message.text}\n`,
    );
  }
  if (remaining > 0) io.stdout(`${remaining} more; run "secbot missed" again\n`);
  return 0;
}
