/**
 * The CLI's connection to its own person's cell: HTTP for commands and a WebSocket for chat, each
 * with `Authorization: Bearer <device key>` (Node 24's global WebSocket takes a `headers` option;
 * checked on this machine's Node 24.14 against a local server). The CLI reaches only the person in
 * its device file.
 */
import { CliError, cellUrl, type Device, type Environment, readDevice } from "./config.ts";

export class CellClient {
  // Plain fields, not constructor parameter properties: `mise run cli` runs this file with Node's
  // type stripping, which accepts erasable TypeScript only.
  readonly base: string;
  readonly device: Device;
  private readonly fetcher: typeof fetch;

  constructor(
    base: string,
    device: Device,
    fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.base = base;
    this.device = device;
    this.fetcher = fetcher;
  }

  static async from(environment: Environment, fetcher?: typeof fetch): Promise<CellClient> {
    return new CellClient(await cellUrl(environment), await readDevice(environment), fetcher);
  }

  get headers(): Record<string, string> {
    return { authorization: `Bearer ${this.device.key}` };
  }

  path(route: string): string {
    return `/v1/cells/${this.device.person}${route}`;
  }

  /** Calls a cell route; a refusal or an error becomes a CliError with the cell's reason. */
  async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${this.path(route)}`, {
        method,
        headers: {
          ...this.headers,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new CliError(`cannot reach the cell: ${(error as Error).message}`);
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status === 401 || response.status === 403) {
      throw new CliError(
        `the cell refused this device (${String(payload.error ?? response.status)})`,
      );
    }
    if (!response.ok)
      throw new CliError(String(payload.error ?? `the cell answered ${response.status}`));
    return payload as T;
  }

  sessionUrl(): string {
    return `${this.base.replace(/^http/, "ws")}${this.path("/session")}`;
  }

  openSocket(): WebSocket {
    // Node's WebSocket is undici's, whose constructor takes `WebSocketInit { headers }`
    // (source: node_modules/.pnpm/undici-types@7.24.6/node_modules/undici-types/websocket.d.ts:71,147-151);
    // the DOM type this package compiles against only knows `protocols`.
    // sdlc-debt: cast to undici's constructor type; drop it when the package compiles without lib "dom".
    const NodeWebSocket = WebSocket as unknown as new (
      url: string,
      init: { headers: Record<string, string> },
    ) => WebSocket;
    return new NodeWebSocket(this.sessionUrl(), { headers: this.headers });
  }
}
