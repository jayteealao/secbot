// The person-cell worker: health, and the CLI routes of each person's cell behind the device check.
// It forwards every request to the person's cell unchanged; it never looks at a message to decide
// where it goes.
import { checkDevice, type DeviceEnv } from "./device-auth.ts";
import { type CellHealth, health } from "./health.ts";
import { DEVICE_HEADER, PERSON_HEADER, PersonCell, type PersonCellEnv } from "./person-cell.ts";

export { PersonCell };

/** The person cells of wave 1. */
export const PERSONS: readonly string[] = ["owner", "second"];

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface WorkerEnv extends DeviceEnv, PersonCellEnv {
  readonly PERSON_CELL: DurableObjectNamespaceLike;
}

const cellOf = (env: WorkerEnv, person: string) =>
  env.PERSON_CELL.get(env.PERSON_CELL.idFromName(person));

async function cellStatus(env: WorkerEnv, person: string): Promise<CellHealth> {
  if (!PERSONS.includes(person)) return { status: "down", reason: "unknown cell" };
  const response = await cellOf(env, person).fetch(
    new Request(`http://cell/v1/cells/${person}/status`, { headers: { [PERSON_HEADER]: person } }),
  );
  if (!response.ok) return { status: "down", reason: `status ${response.status}` };
  const body = (await response.json()) as { version: string; roles: string[] };
  return { status: "up", version: body.version, roles: body.roles };
}

const CELL_ROUTE = /^\/v1\/cells\/([a-z][a-z0-9-]{0,31})\//;

/** Every route except the test cell's conformance routes. */
export async function route(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return health(url, (person) => cellStatus(env, person));
  }
  const person = CELL_ROUTE.exec(url.pathname)?.[1];
  if (person === undefined || !PERSONS.includes(person)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const check = await checkDevice(request, env, person);
  if (!check.ok) {
    return Response.json({ error: `refused: ${check.reason}` }, { status: check.status });
  }
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.set(PERSON_HEADER, person);
  headers.set(DEVICE_HEADER, check.device);
  return cellOf(env, person).fetch(new Request(request, { headers }));
}

export default {
  fetch: (request: Request, env: WorkerEnv): Promise<Response> => route(request, env),
};
