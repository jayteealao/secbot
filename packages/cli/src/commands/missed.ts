// `secbot missed`: what the lead said while no session was open, oldest first.
import type { CellClient } from "../client.ts";
import type { Io } from "../io.ts";

type Missed =
  | { kind: "answer"; entryId: number; text: string }
  | { kind: "followup"; entryId: number; from: string; text: string };

export async function missed(client: CellClient, io: Io): Promise<number> {
  const { messages } = await client.request<{ messages: Missed[] }>("GET", "/missed");
  if (messages.length === 0) {
    io.stdout("no missed messages\n");
    return 0;
  }
  for (const message of messages) {
    io.stdout(
      message.kind === "answer"
        ? `lead: ${message.text}\n`
        : `[from ${message.from}] ${message.text}\n`,
    );
  }
  return 0;
}
