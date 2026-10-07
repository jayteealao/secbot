// Regression: a close before the first open replaces the connection promise; startup must wait on
// the current one, so a later successful reconnect lets chat() read input instead of hanging.
import { describe, expect, it } from "vitest";
import type { CellClient } from "../src/client.ts";
import { chat } from "../src/commands/chat.ts";
import type { Io } from "../src/io.ts";

class FakeSocket {
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.emit("close");
  }
}

describe("chat startup", () => {
  it("reads input after the first connection closes before opening and the second opens", async () => {
    const sockets: FakeSocket[] = [];
    const client = {
      request: async () => ({}),
      openSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        const attempt = sockets.length;
        // First attempt closes before open; the second opens.
        setTimeout(() => socket.emit(attempt === 1 ? "close" : "open"), 5);
        return socket as unknown as WebSocket;
      },
    } as unknown as CellClient;
    let out = "";
    let reading = false;
    const io: Io = {
      stdout: (text) => {
        out += text;
      },
      stderr: () => {},
      lines: async function* () {
        reading = true;
        // No input: end the stream at once.
        yield* [];
      },
    };
    const result = await Promise.race([
      chat(client, io, { reconnectMs: 10 }),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 3_000)),
    ]);
    expect(result).toBe(0);
    expect(reading).toBe(true);
    expect(sockets).toHaveLength(2);
    expect(out).toContain("connection lost; reconnecting");
  });
});
