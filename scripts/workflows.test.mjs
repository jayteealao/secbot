// Structure of the server workflows: the release order and gates, the secrets-stage skip, the
// restore drill's schedule, and that every mise call names a real task.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = (name) =>
  yaml.load(readFileSync(join(root, ".github", "workflows", name), "utf8"));
const release = workflow("release-server.yml");
const drill = workflow("restore-drill.yml");

const needsOf = (job) => [job.needs ?? []].flat();

/** Every job the named job waits for, directly or through others. */
function ancestors(jobs, name, seen = new Set()) {
  for (const parent of needsOf(jobs[name])) {
    if (!seen.has(parent)) {
      seen.add(parent);
      ancestors(jobs, parent, seen);
    }
  }
  return seen;
}

test("the release runs build, conformance, the test cell and its integration suite before any production stage", () => {
  const jobs = release.jobs;
  const order = [
    "build",
    "conformance",
    "deploy-test-cell",
    "integration-test-cell",
    "verify-test-cell",
    "snapshot-cells",
    "deploy-owner-cell",
    "verify-owner-cell",
    "deploy-person-and-household-cells",
    "verify-person-and-household-cells",
  ];
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      ancestors(jobs, order[i]).has(order[i - 1]),
      `${order[i]} must run after ${order[i - 1]}`,
    );
  }
  assert.deepEqual(needsOf(jobs["integration-test-cell"]), ["deploy-test-cell"]);
  assert.equal(jobs["integration-test-cell"].environment, "test-cell");
  const run = jobs["integration-test-cell"].steps.map((step) => step.run ?? "").join("\n");
  assert.match(run, /mise run test:integration -- --env test-cell/);
  // Only the snapshot job asks for the production approval.
  const approvals = Object.entries(jobs).filter(([, job]) => job.environment === "production");
  assert.deepEqual(
    approvals.map(([name]) => name),
    ["snapshot-cells"],
  );
});

test("the staged deploys name the owner first, then the second person and the household", () => {
  const deployCommand = (name) =>
    release.jobs[name].steps
      .map((step) => step.run ?? "")
      .find((run) => run.includes("mise run deploy"));
  assert.match(deployCommand("deploy-owner-cell"), /--cells owner$/);
  assert.match(deployCommand("deploy-person-and-household-cells"), /--cells person,household$/);
});

test("the secrets stage is skipped until the secrets cell exists, and the final checks still run", () => {
  const secrets = release.jobs["deploy-secrets-cell"];
  assert.match(secrets.if, /^\$\{\{ vars\.SECBOT_SECRETS_CELL == 'true' \}\}$/);
  const all = release.jobs["verify-all-cells"];
  assert.deepEqual(needsOf(all).sort(), [
    "deploy-secrets-cell",
    "verify-person-and-household-cells",
  ]);
  assert.match(all.if, /!cancelled\(\)/);
  assert.match(all.if, /needs\.verify-person-and-household-cells\.result == 'success'/);
  assert.match(all.if, /"success","skipped"/);
  assert.match(all.if, /needs\.deploy-secrets-cell\.result/);
  assert.deepEqual(needsOf(release.jobs["github-release"]), ["build", "verify-all-cells"]);
});

test("every job after the secrets stage still runs when that stage is skipped", () => {
  // GitHub skips every job in the chain after a skipped job unless the job's own `if` uses a
  // status function (docs: "a failure or skip applies to all jobs in the dependency chain from
  // the point of failure or skip onwards"), so each later job needs !cancelled() and checks its
  // needs' results itself.
  const jobs = release.jobs;
  const after = Object.keys(jobs).filter((name) =>
    ancestors(jobs, name).has("deploy-secrets-cell"),
  );
  assert.ok(after.includes("github-release"));
  for (const name of after) {
    const condition = jobs[name].if ?? "";
    assert.match(condition, /!cancelled\(\)/, `${name} has no !cancelled() in its if`);
    for (const parent of needsOf(jobs[name])) {
      assert.match(
        condition,
        new RegExp(`needs\\.${parent}\\.result`),
        `${name} does not check needs.${parent}.result`,
      );
    }
  }
});

test("the restore drill runs monthly and on dispatch, behind the production approval and the release gate", () => {
  // js-yaml reads the bare key `on` as the string "on" (YAML 1.2 core schema).
  const on = drill.on;
  assert.ok(on.workflow_dispatch, "dispatch");
  assert.deepEqual(
    on.schedule.map((entry) => entry.cron),
    ["17 6 1 * *"],
  );
  const job = drill.jobs.drill;
  assert.equal(job.environment, "production");
  assert.match(job.if, /^\$\{\{ vars\.SDLC_GATE_SERVER_RELEASE == 'true' \}\}$/);
  const run = job.steps.map((step) => step.run ?? step.with?.cmd ?? "").join("\n");
  assert.match(run, /mise run restore:drill/);
  assert.match(run, /mise run check:cells -- --env test-cell/);
});

test("every mise call in the server workflows names a task in mise.toml", () => {
  const tasks = new Set(
    [
      ...readFileSync(join(root, "mise.toml"), "utf8").matchAll(
        /^\[tasks\.(?:"([^"]+)"|([\w-]+))\]/gm,
      ),
    ].map((match) => match[1] ?? match[2]),
  );
  for (const name of ["release-server.yml", "rollback.yml", "restore.yml", "restore-drill.yml"]) {
    const text = readFileSync(join(root, ".github", "workflows", name), "utf8");
    for (const match of text.matchAll(/mise run ([\w:-]+)/g)) {
      assert.ok(
        tasks.has(match[1]),
        `${name} calls mise run ${match[1]}, which mise.toml does not define`,
      );
    }
  }
});
