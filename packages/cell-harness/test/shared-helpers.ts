// A household stand-in for the shared store's tests: a bare harness with the job and review tasks
// in relay mode, on the faux gateway, and helpers to build operations.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  type Extension,
  Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import { openCelldStorageWithDatabase } from "@secbot/cell-storage";
import { JobBoardDoc, type JobRow } from "../src/docs.ts";
import type { SharedOp } from "../src/household-contract.ts";
import { createJobTask, type JobTask } from "../src/job-task.ts";
import { createReviewTask } from "../src/result-review.ts";
import {
  createFauxGateway,
  FakeCelldStorage,
  fauxAssistantMessage,
  fauxText,
  type Responder,
  resultReviewer,
} from "./fixtures.ts";

export const plans: Responder = (request) =>
  fauxAssistantMessage([fauxText(`plan for both: ${request.lastText}`)]);

export interface HouseholdStandIn {
  readonly harness: Harness;
  readonly task: JobTask;
  commit<T>(change: (tx: Tx) => Promise<T>): Promise<T>;
  row(n: number): Promise<JobRow | undefined>;
  close(): Promise<void>;
}

export async function openHouseholdStandIn(
  respond: Responder = plans,
  extensions: readonly Extension[] = [],
): Promise<HouseholdStandIn> {
  const gateway = createFauxGateway(resultReviewer(respond));
  const ReviewTask = createReviewTask({
    person: "household",
    now: () => Date.now(),
    extensions: () => [],
    relay: true,
  });
  const task = createJobTask({
    person: "household",
    review: () => ReviewTask,
    gate: () => undefined,
    timeZone: "UTC",
    extensions: () => extensions,
    relay: true,
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "household-test", tasks: [task, ReviewTask] }));
  const durable = await openCelldStorageWithDatabase(new FakeCelldStorage());
  const harness = await Harness.open(
    durable.storage,
    { models: gateway.models, registry, now: () => Date.now() },
    BACKGROUND_CONTEXT,
  );
  await harness.root(BACKGROUND_CONTEXT);
  harness.resume();
  return {
    harness,
    task,
    commit: (change) => harness.commit(change, BACKGROUND_CONTEXT),
    row: async (n) => (await harness.snapshot(JobBoardDoc, BACKGROUND_CONTEXT))?.jobs[String(n)],
    close: () => harness.close(BACKGROUND_CONTEXT),
  };
}

let seq = 0;
const nextId = () => `op-${++seq}`;

export const propose = (
  person = "owner",
  other = "second",
  change: Partial<Extract<SharedOp, { kind: "propose" }>> = {},
): SharedOp => ({
  kind: "propose",
  opId: nextId(),
  person,
  other,
  local: 4,
  title: "plan the May trip",
  brief: "Plan the May trip for both of us.",
  priority: "routine",
  deadline: null,
  tier: "cheap",
  effort: "medium",
  estimateUsd: 0.25,
  ...change,
});

export const answer = (
  household: number,
  join: boolean,
  person = "second",
  local = 7,
): SharedOp => ({
  kind: "answer",
  opId: nextId(),
  person,
  household,
  local,
  join,
});
