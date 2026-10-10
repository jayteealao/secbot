/**
 * The secrets cell, as a person cell's agents see it: `secret_get` returns a secret granted to
 * the calling agent, and `broker_call` asks the secrets cell to make a call to a health or
 * production target with a token the agent never holds. Both run behind the guard like every tool.
 *
 * The calling agent is the role of the calling conversation (the roster), never a name the model
 * gives; the person is this cell. A refusal from the secrets cell, or "secrets cell unavailable"
 * when it does not answer, becomes an error result and one activity record with the layer
 * `secrets`. A request is never retried with a cached value and never sent without its secret.
 *
 * Every value `secret_get` returns joins the redactor's learned values (redact.ts), and so do the
 * values the secrets cell names for this person when the cell opens, so no record, log, prompt, or
 * model state shows them.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { appendRecord, recordOf } from "./activity.ts";
import { errorFields, logEvent } from "./cell-parts.ts";
import { addKnownSecretValues, setKnownSecretValues } from "./redact.ts";
import { roleOf } from "./telemetry.ts";

/** What a person sees when the secrets cell does not answer. */
export const SECRETS_UNAVAILABLE = "secrets cell unavailable";

/** `secret`: an agent may read it. `health` and `production`: used only through the broker. */
export type SecretKind = "secret" | "health" | "production";

/** One secret of a person, as listed: never its value. */
export interface SecretListing {
  readonly name: string;
  readonly kind: SecretKind;
  /** The agents the person granted it to. */
  readonly grants: readonly string[];
  /** The agents the owner's allowlist lets the person grant it to. */
  readonly allowed: readonly string[];
  readonly keyId: string;
  readonly createdAt: number;
}

/** A call the secrets cell makes for an agent: a path under the target's address. */
export interface BrokerRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: string;
}

/** The target's answer, with the token and token-shaped text redacted, capped at 64 KiB. */
export interface BrokerAnswer {
  /** The HTTP status, or 0 when the target did not answer. */
  readonly status: number;
  readonly body: string;
}

/** A stored secret: the owner's `add`; the value is never returned. */
export interface SecretInput {
  readonly person: string;
  readonly name: string;
  readonly value: string;
  /** A health or production target: the secrets cell makes those calls itself. */
  readonly broker?: {
    readonly kind: "health" | "production";
    readonly url: string;
    readonly header: string;
  };
}

export interface RotateResult {
  readonly from: string;
  readonly keyId: string;
  readonly rewrapped: number;
  readonly remaining: number;
}

/**
 * The secrets cell's methods. A refusal throws `SecretsRefused` with the reason a person reads;
 * no answer throws `SecretsUnavailable`.
 */
export interface SecretsClient {
  /** `requestId` ties the secrets cell's log lines to the call (`<task>:<call>`). */
  get(
    person: string,
    agent: string,
    name: string,
    requestId?: string,
  ): Promise<{ readonly value: string }>;
  broker(
    person: string,
    agent: string,
    name: string,
    request: BrokerRequest,
    requestId?: string,
  ): Promise<BrokerAnswer>;
  list(person: string): Promise<readonly SecretListing[]>;
  grant(person: string, secret: string, agent: string): Promise<{ readonly granted: boolean }>;
  revoke(person: string, secret: string, agent: string): Promise<{ readonly revoked: boolean }>;
  add(input: SecretInput): Promise<{ readonly keyId: string; readonly replaced: boolean }>;
  allowlist(
    person: string,
    secret: string,
    agent: string,
    action: "add" | "remove",
  ): Promise<{ readonly changed: boolean; readonly revoked: boolean }>;
  rotate(): Promise<RotateResult>;
  /** The values of this person's granted non-broker secrets, for the redactor only. */
  redactionValues(person: string): Promise<readonly string[]>;
}

/** The secrets cell refused the request; the message is the reason a person reads. */
export class SecretsRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsRefused";
  }
}

/** The secrets cell did not answer (or answered 5xx). */
export class SecretsUnavailable extends Error {
  constructor(message = SECRETS_UNAVAILABLE) {
    super(message);
    this.name = "SecretsUnavailable";
  }
}

/** The reason a person reads for a failed secrets request. */
export const secretsReason = (error: unknown): string =>
  error instanceof SecretsRefused ? error.message : SECRETS_UNAVAILABLE;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

/** The id that ties a secrets request to its tool call in every cell's log. */
const requestIdOf = (api: Pick<ToolExecutionApi, "taskId" | "callId">) =>
  `${String(api.taskId)}:${api.callId}`;

export interface SecretsExtensionOptions {
  readonly now: () => number;
  readonly timeZone: string;
}

/**
 * Loads this person's granted values into the redactor once per activation; until a load
 * succeeds, each secrets call tries again first.
 */
export function redactionLoader(person: string, client: () => SecretsClient | undefined) {
  let loaded: Promise<void> | undefined;
  return (): Promise<void> => {
    const secrets = client();
    if (secrets === undefined) return Promise.resolve();
    loaded ??= secrets.redactionValues(person).then(
      // A load replaces this cell's learned values, so a value no longer granted is let go.
      (values) => setKnownSecretValues(person, values),
      (error: unknown) => {
        loaded = undefined;
        logEvent("secrets.redaction_unloaded", { cell: person, ...errorFields(error) }, "warn");
      },
    );
    return loaded;
  };
}

export function createSecretsExtension(
  person: string,
  client: () => SecretsClient | undefined,
  options: SecretsExtensionOptions,
  loadRedaction: () => Promise<void> = redactionLoader(person, client),
): Extension {
  /** One `secrets`-layer activity record for a refused or unanswered request. */
  async function refused(
    api: Pick<ToolExecutionApi, "taskId" | "callId" | "commit">,
    fields: {
      readonly agent: string;
      readonly label: string;
      readonly arguments: Record<string, JsonValue>;
      readonly reason: string;
    },
    context: Context,
  ) {
    const record = recordOf({
      key: `${String(api.taskId)}:${api.callId}:secrets`,
      at: options.now(),
      kind: "verdict",
      agent: fields.agent,
      tool: fields.label,
      verdict: "refused",
      layer: "secrets",
      reason: fields.reason,
      ruleId: null,
      ruleLevel: null,
      arguments: fields.arguments,
      keep: [],
      cost: 0,
    });
    await api.commit((tx) => appendRecord(tx, record, options.timeZone), context);
    logEvent(
      "secrets.request",
      {
        cell: person,
        role: fields.agent,
        tool: fields.label,
        task_id: api.taskId,
        call_id: api.callId,
        outcome: "refused",
        reason: record.reason,
      },
      "warn",
    );
  }

  const get = defineTool({
    name: "secret_get",
    description:
      "Read one secret that the person granted to you, by name. Health and production secrets are never returned: use broker_call for those.",
    parameters: Type.Object({ name: Type.String({ description: "The secret's name." }) }),
    replay: "safe",
    execute: async (args, api, context) => {
      const agent = await roleOf(api, api.conversationId, context);
      const label = `secret ${args.name}`;
      const secrets = client();
      try {
        if (secrets === undefined) throw new SecretsUnavailable();
        await loadRedaction();
        const { value } = await secrets.get(person, agent, args.name, requestIdOf(api));
        addKnownSecretValues([value], person);
        logEvent("secrets.request", {
          cell: person,
          role: agent,
          tool: label,
          task_id: api.taskId,
          call_id: api.callId,
          outcome: "ok",
        });
        return { ...text(value), details: { name: args.name } };
      } catch (error) {
        const reason = secretsReason(error);
        await refused(api, { agent, label, arguments: { name: args.name }, reason }, context);
        return { ...text(`Refused: ${reason}.`), isError: true };
      }
    },
  });

  const broker = defineTool({
    name: "broker_call",
    description:
      "Ask the secrets cell to call a health or production service for you with a secret the person granted to you. You never see the token; you get the service's answer.",
    parameters: Type.Object({
      secret: Type.String({ description: "The broker secret's name." }),
      method: Type.Union([
        Type.Literal("GET"),
        Type.Literal("POST"),
        Type.Literal("PUT"),
        Type.Literal("PATCH"),
        Type.Literal("DELETE"),
      ]),
      path: Type.String({ description: "The path under the service's address, starting with /." }),
      body: Type.Optional(Type.String({ description: "The request body, as text." })),
    }),
    // A brokered call can change something outside: a crash mid-call is never repeated blindly.
    replay: "unsafe",
    execute: async (args, api, context) => {
      const agent = await roleOf(api, api.conversationId, context);
      const label = `broker ${args.secret}`;
      const secrets = client();
      const request: BrokerRequest = {
        method: args.method,
        path: args.path,
        ...(args.body === undefined ? {} : { body: args.body }),
      };
      try {
        if (secrets === undefined) throw new SecretsUnavailable();
        await loadRedaction();
        const answer = await secrets.broker(person, agent, args.secret, request, requestIdOf(api));
        logEvent("secrets.request", {
          cell: person,
          role: agent,
          tool: label,
          task_id: api.taskId,
          call_id: api.callId,
          outcome: "ok",
          status: answer.status,
        });
        const said =
          answer.status === 0
            ? answer.body
            : `The service answered ${answer.status}.\n${answer.body}`;
        return {
          ...text(said),
          details: { secret: args.secret, status: answer.status },
          ...(answer.status === 0 || answer.status >= 400 ? { isError: true } : {}),
        };
      } catch (error) {
        const reason = secretsReason(error);
        await refused(
          api,
          {
            agent,
            label,
            arguments: { secret: args.secret, method: args.method, path: args.path },
            reason,
          },
          context,
        );
        return { ...text(`Refused: ${reason}.`), isError: true };
      }
    },
  });

  return defineExtension({ name: "secbot-secrets", tools: [get, broker] });
}
