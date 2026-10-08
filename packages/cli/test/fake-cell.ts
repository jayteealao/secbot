/**
 * An in-process stand-in for a person cell: the CLI's HTTP routes and a WebSocket session, behind
 * the same bearer-key check. The WebSocket side is a minimal RFC 6455 server (text frames only),
 * so the test needs no WebSocket library.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class ServerSocket {
  private buffer = Buffer.alloc(0);
  closed = false;

  constructor(
    private readonly socket: Duplex,
    private readonly onText: (text: string) => void,
  ) {
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("close", () => {
      this.closed = true;
    });
  }

  send(value: unknown): void {
    if (this.closed) return;
    const payload = Buffer.from(JSON.stringify(value));
    const header =
      payload.length < 126
        ? Buffer.from([0x81, payload.length])
        : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
    this.socket.write(Buffer.concat([header, payload]));
  }

  /** Drops the connection without a close frame, as when the cell moves. */
  drop(): void {
    this.closed = true;
    this.socket.destroy();
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const opcode = (this.buffer[0] ?? 0) & 0x0f;
      let length = (this.buffer[1] ?? 0) & 0x7f;
      let offset = 2;
      if (length === 126) {
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      }
      const end = offset + 4 + length;
      if (this.buffer.length < end) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, end));
      for (let index = 0; index < payload.length; index++)
        payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
      this.buffer = this.buffer.subarray(end);
      if (opcode === 0x8) {
        this.socket.end(Buffer.from([0x88, 0]));
        this.closed = true;
        return;
      }
      if (opcode === 0x1) this.onText(payload.toString("utf8"));
    }
  }
}

export interface FakeCell {
  readonly url: string;
  readonly sockets: ServerSocket[];
  readonly inputs: { text: string; requestId: string }[];
  readonly calls: { method: string; path: string; body: unknown; auth: string | undefined }[];
  /** Called with each new input; answer through the socket. */
  onInput: (input: { text: string; requestId: string }, socket: ServerSocket) => void;
  missed: unknown[];
  /** Held calls listed first by `/missed` and by `GET /approvals`. */
  held: unknown[];
  /** The answer route: number -> [status, body]; an unknown number answers 404. */
  answers: Record<number, [number, unknown]>;
  /** The guard routes: both rule levels, the activity answer, and a refusal for the next add. */
  rules: { owner: Record<string, unknown>[]; person: Record<string, unknown>[]; timeZone: string };
  activity: Record<string, unknown>;
  refuseNextAdd: string | undefined;
  /** The operator key the /ops routes accept. */
  operatorKey: string;
  close(): Promise<void>;
}

export async function startFakeCell(key: string, person = "owner"): Promise<FakeCell> {
  const cell: FakeCell = {
    url: "",
    sockets: [],
    inputs: [],
    calls: [],
    onInput: () => {},
    missed: [],
    held: [],
    answers: {},
    rules: { owner: [], person: [], timeZone: "UTC" },
    activity: { person, month: "2026-10", timeZone: "UTC", total: 0, records: [], next: null },
    refuseNextAdd: undefined,
    operatorKey: "operator-key-0123456789abcdef", // gitleaks:allow (fake test key)
    close: async () => {},
  };
  const seen = new Set<string>();
  const authorized = (request: IncomingMessage) =>
    request.headers.authorization === `Bearer ${key}`;
  const prefix = `/v1/cells/${person}`;
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      const path = request.url ?? "";
      const body = raw === "" ? undefined : (JSON.parse(raw) as Record<string, unknown>);
      cell.calls.push({
        method: request.method ?? "",
        path,
        body,
        auth: request.headers.authorization,
      });
      const reply = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const guard = (level: "owner" | "person", route: string) => {
        if (route === "rules" && request.method === "GET") return reply(200, cell.rules);
        if (route === "activity" && request.method === "GET") return reply(200, cell.activity);
        const given = (body ?? {}) as Record<string, unknown>;
        if (route === "rules" && request.method === "POST") {
          if (cell.refuseNextAdd !== undefined) {
            const error = cell.refuseNextAdd;
            cell.refuseNextAdd = undefined;
            return reply(400, { error });
          }
          const rule = { ...given, id: 100 + cell.rules[level].length, source: level, addedAt: 0 };
          cell.rules[level].push(rule);
          return reply(201, { rule });
        }
        if (route === "rules" && request.method === "DELETE") {
          const list = cell.rules[level];
          const index = list.findIndex(
            (rule) =>
              rule.agent === given.agent &&
              rule.tool === given.tool &&
              JSON.stringify(rule.match) === JSON.stringify(given.match),
          );
          if (index === -1) return reply(404, { error: "no rule" });
          const [removed] = list.splice(index, 1);
          return reply(200, { removed });
        }
        return reply(404, { error: "not found" });
      };
      if (path.startsWith("/ops/")) {
        if (request.headers["x-secbot-operator"] !== cell.operatorKey) {
          return reply(401, { error: "refused: operator_key" });
        }
        const url = new URL(path, "http://cell");
        if (url.searchParams.get("cell") !== "sam") return reply(404, { error: "no such cell" });
        return guard("owner", url.pathname.slice(5));
      }
      if (!authorized(request)) return reply(401, { error: "refused: unknown_key" });
      if (!path.startsWith(`${prefix}/`)) return reply(403, { error: "refused: other_person" });
      const route = path.slice(prefix.length);
      if (route === "/status")
        return reply(200, { status: "up", person, version: "v0.0.0-test", roles: ["lead"] });
      if (route === "/missed") {
        const messages = cell.missed;
        cell.missed = [];
        return reply(200, { held: cell.held, messages, remaining: 0 });
      }
      if (route === "/approvals" && request.method === "GET")
        return reply(200, { held: cell.held });
      const answer = /^\/approvals\/(\d+)$/.exec(route);
      if (answer !== null && request.method === "POST") {
        const number = Number(answer[1]);
        const [status, value] = cell.answers[number] ?? [404, { error: `no held call #${number}` }];
        return reply(status, value);
      }
      if (route === "/models" && request.method === "GET") {
        return reply(200, {
          roles: [
            { role: "lead", model: "anthropic/claude-opus-5.5", source: "release default" },
            { role: "research", model: "anthropic/claude-haiku-4.5", source: "release default" },
          ],
        });
      }
      if (route.startsWith("/models/") && request.method === "PUT") {
        const model = String(body?.model);
        if (!model.startsWith("anthropic/"))
          return reply(400, { error: `unknown model "${model}"` });
        return reply(200, { role: route.slice(8), model, source: "changed" });
      }
      const guardRoute = /^\/(rules|activity)(\?.*)?$/.exec(route);
      if (guardRoute !== null) return guard("person", guardRoute[1] ?? "");
      if (route === "/specialists" && request.method === "POST")
        return reply(201, { name: body?.name, status: "added" });
      return reply(404, { error: "not found" });
    });
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
    if (!authorized(request) || request.url !== `${prefix}/session`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}${GUID}`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const ws = new ServerSocket(socket, (text) => {
      const input = JSON.parse(text) as { text: string; requestId: string };
      ws.send({ type: "accepted", requestId: input.requestId });
      if (seen.has(input.requestId)) return;
      seen.add(input.requestId);
      cell.inputs.push(input);
      cell.onInput(input, ws);
    });
    cell.sockets.push(ws);
    ws.send({ type: "connected", lead: person });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(cell, {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of cell.sockets) socket.drop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}
