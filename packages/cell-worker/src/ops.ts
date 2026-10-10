/**
 * Operator routes: snapshots, restores, wipes, digests, heartbeat state, and the write-delay
 * probe. Only the VPS release tool calls them, from the host, with the operator key that host
 * setup generates on the VPS (`x-secbot-operator`); every other request is refused and logged as
 * `ops.refused`. The key is compared by SHA-256 without an early exit, and never logged.
 *
 *   POST /ops/snapshot?id=<id>[&cells=]  each cell dumps; the dump goes to the SNAPSHOTS bucket
 *                                        binding as snapshots/<id>/<cell>.json
 *   POST /ops/restore?id=<id>&cell=<c>   load that dump into the cell (refuses a later contract step)
 *   POST /ops/wipe?cells=                drop every table of the cells (test cell, after a drill)
 *   GET  /ops/digest?cells=              each cell's digest and row count
 *   GET  /ops/heartbeats?cells=          each cell's heartbeat routine state
 *   POST /ops/write                      one committed single-row write (test cell only)
 *   GET|POST|DELETE /ops/rules?cell=     a person's rules; the owner adds and removes owner rules
 *   GET  /ops/activity?cell=             a person's activity, for the owner
 *   GET|PUT /ops/mode?cell=              a person cell's guard mode (shadow or enforce)
 *   PUT  /ops/decision-model?cell=       a person cell's decision model (clef, clef-flash, jev)
 *   GET  /ops/cost[?cell=]               a person's month of spend, or the household's
 *   PUT  /ops/limits?cell=               a person's monthly limit ({"limitUsd": <usd>})
 *   PUT  /ops/limits?budget=developer    the household developer budget ({"limitUsd": <usd>})
 *   PUT  /ops/time-zone                  the household time zone, from the next month
 *   GET|PUT /ops/secrets?cell=           a person's secrets (never values); store one (value in body)
 *   PUT|DELETE /ops/secrets/allowlist?cell=  the owner's allowlist; removing an entry revokes its grant
 *   POST /ops/secrets/rotate             the next master key becomes current; records are re-wrapped
 *
 * The secrets cell is never snapshotted, wiped, or restored: the default cell set of those routes
 * leaves it out, and naming it is refused.
 *
 * The rules and activity routes are the owner's command line (`secbot rules --owner`,
 * `secbot activity --person`), with the same operator key from the owner's machine.
 *
 * The SNAPSHOTS binding is an `r2_buckets` entry: celld serves it from the fleet bucket under
 * `r2/secbot-snapshots/`, so a snapshot lives at the bucket provider, not on the VPS (celld v0.6.1
 * docs/README.md:477-481; `put(key, value, options)` and `get(key)` in
 * crates/celld/js/harness.js:1132-1190).
 */
import {
  type BudgetBoard,
  type CostView,
  costFromReport,
  DEFAULT_DEVELOPER_BUDGET_USD,
  DEVELOPER_ROLE,
  errorFields,
  type HeartbeatState,
  type HouseholdClient,
  householdCostView,
  logEvent,
  SECRETS_UNAVAILABLE,
  type SecretInput,
  type SecretsClient,
  SecretsRefused,
  SecretsUnavailable,
} from "@secbot/cell-harness";
import type { CellDump } from "@secbot/cell-storage";
import { isRefusedHouseholdChange } from "@secbot/household-cell";
import { sameHex, sha256Hex } from "./device-auth.ts";
import { contractStep } from "./health.ts";
import { HouseholdCallError } from "./household-client.ts";
import { OPERATOR_HEADER } from "./internal-rpc.ts";

/** What the operator routes need from a cell's stub (celld JS RPC). */
export interface SnapshotStub {
  snapshot(contractStep: number): Promise<CellDump>;
  restore(dump: CellDump, person: string): Promise<{ digest: string; rows: number }>;
  wipe(): Promise<void>;
  digest(): Promise<{ digest: string; rows: number }>;
  heartbeat(person: string): Promise<HeartbeatState>;
}

/** The part of an R2 bucket binding the routes use. */
export interface SnapshotBucket {
  put(
    key: string,
    value: string,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

export interface OpsEnv {
  readonly SECBOT_OPERATOR_KEY?: string;
  readonly SNAPSHOTS?: SnapshotBucket;
}

/** A refusal or a missing rule keeps its status across RPC (see person-cell.ts GuardAnswer). */
type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly error: string };

/** What the owner's rule and activity routes need from a person cell's stub (celld JS RPC). */
export interface GuardStub {
  ownerRules(person: string): Promise<Answer<unknown>>;
  addOwnerRule(person: string, input: unknown): Promise<Answer<unknown>>;
  removeOwnerRule(person: string, input: unknown): Promise<Answer<unknown>>;
  activityOf(
    person: string,
    query: { month?: string; before?: number; limit?: number },
  ): Promise<Answer<unknown>>;
  /** The guard mode and the decision model; absent on a stub built before them. */
  guardModeOf?(person: string): Promise<Answer<unknown>>;
  setGuardModeOf?(person: string, mode: unknown): Promise<Answer<unknown>>;
  setDecisionModelOf?(person: string, adapter: unknown): Promise<Answer<unknown>>;
  /** Spend and limits; absent on a stub built before them. */
  costOf?(person: string): Promise<Answer<CostView>>;
  setLimitOf?(person: string, usd: unknown): Promise<Answer<unknown>>;
  refreshBudget?(person: string): Promise<void>;
}

export interface OpsDeps {
  /** The cells this fleet serves, by name. */
  readonly cells: readonly string[];
  /** The stub of one served cell, or undefined when the fleet has no binding for it. */
  stubOf(cell: string): SnapshotStub | undefined;
  /** The guard RPC of one served person cell, or undefined for any other cell. */
  guardOf?(cell: string): GuardStub | undefined;
  /** Checks the activity query parameters (person-cell.ts activityQuery). */
  activityQuery?(
    params: URLSearchParams,
  ): { month?: string; before?: number; limit?: number } | { error: string };
  /** One committed single-row write (the test cell's lab); undefined elsewhere. */
  readonly write?: () => Promise<void>;
  /** The household cell's client (its budget board), or undefined when this fleet has none. */
  household?(): HouseholdClient | undefined;
  /** The secrets cell's client, or undefined when this fleet reaches none. */
  secrets?(): SecretsClient | undefined;
}

/** The secrets cell: never in a snapshot, wipe, digest, or heartbeat set of these routes. */
const SECRETS_CELL = "secrets";

const SNAPSHOT_ID = /^[A-Za-z0-9._-]{1,100}$/;

const json = (body: unknown, status = 200) => Response.json(body, { status });

const refuse = (route: string, reason: string, status: number) => {
  logEvent("ops.refused", { route, reason }, "warn");
  return json({ error: `refused: ${reason}` }, status);
};

/** True when the request carries the operator key; refuses every request when none is set. */
export async function hasOperatorKey(request: Request, env: OpsEnv): Promise<boolean> {
  const expected = env.SECBOT_OPERATOR_KEY ?? "";
  const given = request.headers.get(OPERATOR_HEADER) ?? "";
  if (expected === "" || given === "") return false;
  return sameHex(await sha256Hex(given), await sha256Hex(expected));
}

/** The cells a request names (`?cells=`), each one served by this fleet; all of them by default. */
function cellsOf(
  url: URL,
  deps: OpsDeps,
): { cells: string[] } | { error: string; status: 400 | 404 } {
  const named = (url.searchParams.get("cells") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => (name === "person" ? "second" : name));
  if (named.includes(SECRETS_CELL)) {
    return { error: "the secrets cell is never snapshotted", status: 400 };
  }
  const cells =
    named.length === 0 ? deps.cells.filter((cell) => cell !== SECRETS_CELL) : [...new Set(named)];
  const foreign = cells.find((cell) => !deps.cells.includes(cell));
  return foreign === undefined
    ? { cells }
    : { error: `cell ${foreign} is served by another fleet`, status: 404 };
}

const snapshotKey = (id: string, cell: string) => `snapshots/${id}/${cell}.json`;

/** The largest rule body the owner routes read. */
const RULE_BODY_LIMIT = 16 * 1024;

/**
 * The owner's view of one person's guard, behind the operator key:
 *
 *   GET    /ops/rules?cell=<person>       both levels of that person's rules
 *   POST   /ops/rules?cell=<person>       add an owner rule (body: agent, tool, verdict, match?)
 *   DELETE /ops/rules?cell=<person>       remove an owner rule (body: agent, tool, match?)
 *   GET    /ops/activity?cell=<person>&month=YYYY-MM&before=&limit=   that person's activity
 *   GET    /ops/mode?cell=<person>        the guard mode, since when, and the decision model
 *   PUT    /ops/mode?cell=<person>        switch the mode (body: {"mode": "shadow" | "enforce"})
 *   PUT    /ops/decision-model?cell=<person>   switch the decision model ({"adapter": "clef" | "clef-flash" | "jev"})
 *
 * No device-key route reaches the mode: only the operator key switches a cell to enforce.
 */
async function guardRoute(request: Request, url: URL, deps: OpsDeps): Promise<Response> {
  const raw = url.searchParams.get("cell") ?? "";
  const cell = raw === "person" ? "second" : raw;
  if (cell === "") return json({ error: "send ?cell=<person>" }, 400);
  if (!deps.cells.includes(cell)) {
    return json({ error: `cell ${cell} is served by another fleet` }, 404);
  }
  const guard = deps.guardOf?.(cell);
  if (guard === undefined) return json({ error: `${cell} is not a person cell` }, 404);
  const reply = (answer: Answer<unknown>, status = 200, key?: string) =>
    answer.ok
      ? json(key === undefined ? answer.value : { [key]: answer.value }, status)
      : json({ error: answer.error }, answer.status);
  if (request.method === "GET" && url.pathname === "/ops/activity") {
    const query = deps.activityQuery?.(url.searchParams) ?? {};
    if ("error" in query) return json({ error: query.error }, 400);
    return reply(await guard.activityOf(cell, query));
  }
  const modeRoute = url.pathname === "/ops/mode" || url.pathname === "/ops/decision-model";
  if (modeRoute && (guard.guardModeOf === undefined || guard.setGuardModeOf === undefined)) {
    return json({ error: `${cell} has no guard mode in this release` }, 404);
  }
  if (request.method === "GET" && url.pathname === "/ops/mode") {
    return reply((await guard.guardModeOf?.(cell)) as Answer<unknown>);
  }
  // The decision model is switched with PUT and read with GET /ops/mode.
  if (request.method === "GET" && url.pathname === "/ops/decision-model") {
    return json({ error: "not found" }, 404);
  }
  if (request.method === "GET") return reply(await guard.ownerRules(cell));
  const writes = modeRoute ? ["PUT"] : ["POST", "DELETE"];
  if (!writes.includes(request.method)) return json({ error: "not found" }, 404);
  const text = await request.text().catch(() => "");
  if (text.length > RULE_BODY_LIMIT) {
    return json({ error: `the body is over ${RULE_BODY_LIMIT} bytes` }, 413);
  }
  let body: unknown = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  const field = (name: string) =>
    body !== null && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
  if (url.pathname === "/ops/mode") {
    const answer = (await guard.setGuardModeOf?.(cell, field("mode"))) as Answer<unknown>;
    logEvent("ops.mode", { cell, ok: answer.ok });
    return reply(answer);
  }
  if (url.pathname === "/ops/decision-model") {
    const answer = (await guard.setDecisionModelOf?.(cell, field("adapter"))) as Answer<unknown>;
    logEvent("ops.decision_model", { cell, ok: answer.ok });
    return reply(answer);
  }
  if (request.method === "POST") {
    const answer = await guard.addOwnerRule(cell, body);
    logEvent("ops.rules", { cell, action: "add", ok: answer.ok });
    return reply(answer, 201, "rule");
  }
  const answer = await guard.removeOwnerRule(cell, body);
  logEvent("ops.rules", { cell, action: "remove", ok: answer.ok });
  return reply(answer, 200, "removed");
}

export { costFromReport, type HouseholdCostRow } from "@secbot/cell-harness";

const readBody = async (request: Request): Promise<Record<string, unknown> | undefined> => {
  const text = await request.text().catch(() => "");
  if (text.length > RULE_BODY_LIMIT) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** True when the household refused a setting (bad zone or amount), over HTTP or RPC. */
const householdRefused = (error: unknown) =>
  isRefusedHouseholdChange(error) || (error instanceof HouseholdCallError && error.status < 500);

/**
 * The owner's view of spend and limits, behind the operator key. A person's limit is that
 * person cell's own setting; the developer budget and the time zone are household settings on
 * the household cell's budget board, which every served cell reads again after a change.
 */
async function budgetRoute(request: Request, url: URL, deps: OpsDeps): Promise<Response> {
  const raw = url.searchParams.get("cell");
  const cell = raw === "person" ? "second" : raw;
  const household = deps.household?.();
  const persons = deps.cells.filter((name) => deps.guardOf?.(name)?.costOf !== undefined);
  const board = async (): Promise<BudgetBoard | undefined> => {
    if (household?.budget === undefined) return undefined;
    try {
      return await household.budget();
    } catch (error) {
      logEvent("ops.board_unread", { ...errorFields(error) }, "warn");
      return undefined;
    }
  };

  if (request.method === "GET" && url.pathname === "/ops/cost") {
    if (cell !== null) {
      const guard = deps.guardOf?.(cell);
      if (deps.cells.includes(cell) && guard?.costOf !== undefined) {
        const answer = await guard.costOf(cell);
        return answer.ok
          ? json({ ...answer.value, asOf: Date.now() })
          : json({ error: answer.error }, answer.status);
      }
      const read = await board();
      const report = read?.reports.find((each) => each.cell === cell);
      if (read === undefined || report === undefined) {
        return json({ error: `no spend known for ${cell}` }, 404);
      }
      return json(costFromReport(report, read));
    }
    const read = await board();
    const live: CostView[] = [];
    for (const person of persons) {
      const answer = await deps.guardOf?.(person)?.costOf?.(person);
      if (answer?.ok === true) live.push(answer.value);
    }
    return json(householdCostView(live, read, Date.now()));
  }

  if (request.method !== "PUT") return json({ error: "not found" }, 404);
  const body = await readBody(request);
  if (body === undefined) return json({ error: `the body is over ${RULE_BODY_LIMIT} bytes` }, 413);

  if (url.pathname === "/ops/limits" && cell !== null) {
    if (!deps.cells.includes(cell)) {
      return json({ error: `cell ${cell} is served by another fleet` }, 404);
    }
    const guard = deps.guardOf?.(cell);
    if (guard?.setLimitOf === undefined)
      return json({ error: `${cell} is not a person cell` }, 404);
    const answer = await guard.setLimitOf(cell, body.limitUsd);
    logEvent("ops.limits", { cell, budget: "person", ok: answer.ok });
    return answer.ok ? json(answer.value) : json({ error: answer.error }, answer.status);
  }

  const developer =
    url.pathname === "/ops/limits" && url.searchParams.get("budget") === DEVELOPER_ROLE;
  const zone = url.pathname === "/ops/time-zone";
  if (!developer && !zone) {
    return json({ error: "send ?cell=<person> or ?budget=developer" }, 400);
  }
  if (household?.setBudget === undefined) {
    return json({ error: "no household cell in this fleet" }, 503);
  }
  const change = developer ? { developerLimitUsd: body.limitUsd } : { timeZone: body.timeZone };
  if (Object.values(change)[0] === undefined) {
    return json(
      { error: developer ? 'send {"limitUsd": <usd>}' : 'send {"timeZone": "<IANA>"}' },
      400,
    );
  }
  try {
    const settings = await household.setBudget(change as never);
    logEvent("ops.limits", { budget: developer ? DEVELOPER_ROLE : "time_zone", ok: true });
    // Each served person cell reads the new settings now; another fleet's at its next report.
    for (const person of persons) {
      await deps
        .guardOf?.(person)
        ?.refreshBudget?.(person)
        .catch((error: unknown) => {
          logEvent("ops.refresh_failed", { cell: person, ...errorFields(error) }, "warn");
        });
    }
    return json({
      timeZone: settings.timeZone,
      developerLimitUsd: settings.developerLimitUsd ?? DEFAULT_DEVELOPER_BUDGET_USD,
    });
  } catch (error) {
    if (!householdRefused(error)) throw error;
    logEvent("ops.limits", { budget: developer ? DEVELOPER_ROLE : "time_zone", ok: false });
    return json(
      { error: `refused: ${error instanceof Error ? error.message : String(error)}` },
      400,
    );
  }
}

/**
 * The owner's secrets, behind the operator key. A value arrives only in a request body (the CLI
 * reads it from standard input) and is never in an answer or a log line.
 *
 *   GET    /ops/secrets?cell=<person>            that person's secrets, grants, and allowlist
 *   PUT    /ops/secrets?cell=<person>            store one: {"name", "value", "broker"?}
 *   PUT    /ops/secrets/allowlist?cell=<person>  allow: {"secret", "agent"}
 *   DELETE /ops/secrets/allowlist?cell=<person>  stop allowing (revokes the grant)
 *   POST   /ops/secrets/rotate                   the next master key; every record re-wrapped
 */
async function secretsRoute(request: Request, url: URL, deps: OpsDeps): Promise<Response> {
  const secrets = deps.secrets?.();
  if (secrets === undefined) return json({ error: `refused: ${SECRETS_UNAVAILABLE}` }, 503);
  const raw = url.searchParams.get("cell") ?? "";
  const person = raw === "person" ? "second" : raw;
  const route = `${request.method} ${url.pathname}`;
  try {
    if (route === "POST /ops/secrets/rotate") {
      const result = await secrets.rotate();
      logEvent("ops.secrets", { action: "rotate", ok: true, key_id: result.keyId });
      return json(result);
    }
    if (person === "") return json({ error: "send ?cell=<person>" }, 400);
    if (route === "GET /ops/secrets") return json({ person, secrets: await secrets.list(person) });
    const body = await readBody(request);
    if (body === undefined)
      return json({ error: `the body is over ${RULE_BODY_LIMIT} bytes` }, 413);
    const field = (name: string) => (typeof body[name] === "string" ? (body[name] as string) : "");
    if (route === "PUT /ops/secrets") {
      const broker = body.broker as SecretInput["broker"] | undefined;
      const result = await secrets.add({
        person,
        name: field("name"),
        value: field("value"),
        ...(broker === undefined || broker === null ? {} : { broker }),
      });
      logEvent("ops.secrets", { action: "add", person, secret: field("name"), ok: true });
      return json({ person, name: field("name"), ...result });
    }
    if (url.pathname === "/ops/secrets/allowlist" && ["PUT", "DELETE"].includes(request.method)) {
      const action = request.method === "PUT" ? "add" : "remove";
      const result = await secrets.allowlist(person, field("secret"), field("agent"), action);
      logEvent("ops.secrets", { action: `allowlist-${action}`, person, ok: true });
      return json({ person, secret: field("secret"), agent: field("agent"), ...result });
    }
    return json({ error: "not found" }, 404);
  } catch (error) {
    if (error instanceof SecretsRefused) {
      logEvent("ops.secrets", { route, person, ok: false }, "warn");
      return json({ error: `refused: ${error.message}` }, 400);
    }
    if (error instanceof SecretsUnavailable) {
      return json({ error: `refused: ${SECRETS_UNAVAILABLE}` }, 503);
    }
    throw error;
  }
}

/** Handles one `/ops/*` request; the caller has checked the path prefix. */
export async function ops(request: Request, env: OpsEnv, deps: OpsDeps): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  if (!(await hasOperatorKey(request, env))) return refuse(url.pathname, "operator_key", 401);
  const stub = (cell: string) => {
    const found = deps.stubOf(cell);
    if (found === undefined) throw new Error(`cell ${cell} has no binding in this fleet`);
    return found;
  };

  if (
    url.pathname === "/ops/rules" ||
    url.pathname === "/ops/mode" ||
    url.pathname === "/ops/decision-model" ||
    route === "GET /ops/activity"
  ) {
    return guardRoute(request, url, deps);
  }

  if (url.pathname === "/ops/secrets" || url.pathname.startsWith("/ops/secrets/")) {
    return secretsRoute(request, url, deps);
  }

  if (
    url.pathname === "/ops/cost" ||
    url.pathname === "/ops/limits" ||
    url.pathname === "/ops/time-zone"
  ) {
    return budgetRoute(request, url, deps);
  }

  if (route === "POST /ops/write") {
    if (deps.write === undefined) return json({ error: "no write probe in this bundle" }, 404);
    const started = Date.now();
    await deps.write();
    return json({ ms: Date.now() - started });
  }

  if (route === "POST /ops/restore") {
    const id = url.searchParams.get("id") ?? "";
    const raw = url.searchParams.get("cell") ?? "";
    const cell = raw === "person" ? "second" : raw;
    if (!SNAPSHOT_ID.test(id)) return json({ error: "send id=<snapshot id>" }, 400);
    if (cell === "secrets") return refuse(url.pathname, "secrets_cell", 403);
    if (!deps.cells.includes(cell)) {
      return json({ error: `cell ${cell} is served by another fleet` }, 404);
    }
    if (env.SNAPSHOTS === undefined) return json({ error: "no SNAPSHOTS binding" }, 503);
    const object = await env.SNAPSHOTS.get(snapshotKey(id, cell));
    if (object === null) return json({ error: `snapshot ${id} not found for cell ${cell}` }, 404);
    const dump = JSON.parse(await object.text()) as CellDump;
    if (dump.contractStep > contractStep()) {
      return json(
        {
          error: `refusing a snapshot past contract step ${contractStep()} (snapshot ${id} has step ${dump.contractStep})`,
        },
        409,
      );
    }
    const result = await stub(cell).restore(dump, cell);
    return json({ cell, ...result });
  }

  const selected = cellsOf(url, deps);
  if ("error" in selected) return json({ error: selected.error }, selected.status);
  const { cells } = selected;

  if (route === "POST /ops/snapshot") {
    const id = url.searchParams.get("id") ?? "";
    if (!SNAPSHOT_ID.test(id)) return json({ error: "send id=<snapshot id>" }, 400);
    if (env.SNAPSHOTS === undefined) return json({ error: "no SNAPSHOTS binding" }, 503);
    // A snapshot is write-once: it is the rollback boundary the deploy ledger names, so a rerun
    // with the same id must fail here, before any object is touched, never replace it.
    for (const cell of cells) {
      if ((await env.SNAPSHOTS.get(snapshotKey(id, cell))) !== null) {
        return json(
          { error: `snapshot ${id} already exists for cell ${cell}; refusing to overwrite it` },
          409,
        );
      }
    }
    const snapshots = [];
    for (const cell of cells) {
      const dump = await stub(cell).snapshot(contractStep());
      const body = JSON.stringify(dump);
      await env.SNAPSHOTS.put(snapshotKey(id, cell), body, {
        customMetadata: {
          digest: dump.digest,
          rows: String(dump.rows),
          contractStep: String(dump.contractStep),
        },
      });
      logEvent("ops.snapshot", { id, cell, bytes: body.length });
      snapshots.push({ cell, digest: dump.digest, rows: dump.rows, bytes: body.length });
    }
    return json({ id, contractStep: contractStep(), snapshots });
  }
  if (route === "POST /ops/wipe") {
    for (const cell of cells) await stub(cell).wipe();
    return json({ wiped: cells });
  }
  if (route === "GET /ops/digest") {
    const answer: Record<string, { digest: string; rows: number }> = {};
    for (const cell of cells) answer[cell] = await stub(cell).digest();
    return json({ cells: answer });
  }
  if (route === "GET /ops/heartbeats") {
    const answer: Record<string, HeartbeatState | { error: string }> = {};
    for (const cell of cells) {
      try {
        answer[cell] = await stub(cell).heartbeat(cell);
      } catch (error) {
        answer[cell] = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    return json({ cells: answer });
  }
  return json({ error: "not found" }, 404);
}
