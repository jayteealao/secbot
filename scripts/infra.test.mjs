// The cell log settings in the celld role: celld's own lines are filtered to warn while every
// cell line is kept, the cells log to their own journal namespace with its own retention, and the
// change stays inside Secbot's scope (no VPS-wide journald config, no filter in the file the
// release tool sources), and the secrets cell's key helper role.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const role = join(root, "infra", "ansible", "roles", "celld");
const read = (...parts) => readFileSync(join(...parts), "utf8");
const defaults = yaml.load(read(role, "defaults", "main.yml"));
const unit = read(role, "templates", "celld@.service.j2");
const journalConf = read(role, "templates", "journald-namespace.conf.j2");

/** The lines of one [Section] of a unit or config file, comments dropped. */
function section(text, name) {
  const lines = [];
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) inside = line === `[${name}]`;
    else if (inside && line && !line.startsWith("#")) lines.push(line);
  }
  return lines;
}

/** Every task file under infra/ansible, parsed. */
function taskFiles(dir = join(root, "infra", "ansible")) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...taskFiles(path));
    else if (/\.ya?ml$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("the celld unit sets the log filter and the log namespace from the role defaults", () => {
  const service = section(unit, "Service");
  assert.ok(service.includes("Environment=RUST_LOG={{ celld_log_filter }}"));
  assert.ok(service.includes("LogNamespace={{ celld_log_namespace }}"));
});

test("the default filter keeps every cell line at info and celld's own lines at warn", () => {
  const directives = defaults.celld_log_filter.split(",");
  assert.equal(directives[0], "warn");
  assert.ok(directives.includes("cell_console=info"));
  assert.match(defaults.celld_log_namespace, /^[a-z][a-z0-9-]*$/);
});

test("the namespace journal is persistent and capped by the role defaults", () => {
  const journal = section(journalConf, "Journal");
  assert.ok(journal.includes("Storage=persistent"));
  assert.ok(journal.includes("SystemMaxUse={{ celld_journal_max_use }}"));
  assert.ok(journal.includes("SystemKeepFree={{ celld_journal_keep_free }}"));
  assert.ok(journal.includes("MaxRetentionSec={{ celld_journal_retention }}"));
  // A monthly cost estimate needs at least 35 days of lines.
  const days = Number.parseInt(defaults.celld_journal_retention, 10);
  assert.ok(defaults.celld_journal_retention.endsWith("day") && days >= 35);
});

test("the namespace config goes to the namespace's own file and restarts the journal before the cells", () => {
  const tasks = yaml.load(read(role, "tasks", "main.yml"));
  const task = tasks.find(
    (t) => t["ansible.builtin.template"]?.src === "journald-namespace.conf.j2",
  );
  assert.ok(task);
  assert.equal(
    task["ansible.builtin.template"].dest,
    "/etc/systemd/journald@{{ celld_log_namespace }}.conf",
  );
  assert.deepEqual(task.notify, ["Restart the cell journal", "Restart celld instances"]);
  const handlers = yaml.load(read(role, "handlers", "main.yml")).map((h) => h.name);
  assert.ok(
    handlers.indexOf("Restart the cell journal") < handlers.indexOf("Restart celld instances"),
  );
  assert.ok(handlers.indexOf("Reload systemd") < handlers.indexOf("Restart the cell journal"));
});

test("no task writes the VPS-wide journald config or one of its drop-ins", () => {
  for (const file of taskFiles()) {
    const text = read(file);
    assert.doesNotMatch(text, /\/etc\/systemd\/journald\.conf(\.d)?\b/, file);
  }
});

test("the fleet env file, which the release tool sources, carries no log filter", () => {
  assert.doesNotMatch(read(role, "templates", "celld.env.j2"), /RUST_LOG/);
});

// The secrets cell's key helper: its unit runs as its own user on loopback with hardening and
// answers the celld user's sockets, the celld units cannot see the keys, the first master key is
// made once on the host and never shown, and no key file is in the repo.
const helperRole = join(root, "infra", "ansible", "roles", "secrets_key_helper");
const helperUnit = read(helperRole, "templates", "secbot-key-helper@.service.j2");
const helperTasks = yaml.load(read(helperRole, "tasks", "main.yml"));

test("the key helper unit runs as its own user, hardened, and writes only its own key directory", () => {
  const service = section(helperUnit, "Service");
  for (const line of [
    "User=secbot-keys",
    "Group=secbot-keys",
    "UMask=0077",
    "NoNewPrivileges=true",
    "ProtectSystem=strict",
    "ReadWritePaths=/etc/secbot/secrets-keys/%i",
    "ProtectHome=true",
    "PrivateTmp=true",
    "PrivateDevices=true",
    "CapabilityBoundingSet=",
    "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
  ]) {
    assert.ok(service.includes(line), line);
  }
  const start = service.find((line) => line.startsWith("ExecStart="));
  assert.equal(
    start,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a systemd variable in the unit, not JS
    "ExecStart=/usr/local/bin/secbot-key-helper --key-dir /etc/secbot/secrets-keys/%i --port ${SECBOT_KEY_HELPER_PORT} --peer-user celld",
  );
});

test("the celld units cannot see the key directory", () => {
  const celldUnit = read(role, "templates", "celld@.service.j2");
  assert.ok(section(celldUnit, "Service").includes("InaccessiblePaths=-/etc/secbot/secrets-keys"));
});

test("the key helper's user exists and owns every key file, old hosts included", () => {
  const user = helperTasks.find((t) => t["ansible.builtin.user"] !== undefined);
  assert.equal(user["ansible.builtin.user"].name, "secbot-keys");
  assert.equal(user["ansible.builtin.user"].system, true);
  const migrate = helperTasks.find((t) => /every existing key file/.test(t.name));
  assert.equal(migrate["ansible.builtin.file"].owner, "secbot-keys");
  assert.equal(migrate["ansible.builtin.file"].recurse, true);
  assert.equal(migrate["ansible.builtin.file"].mode, undefined);
});

test("the key helper binds loopback only", () => {
  const helper = read(helperRole, "files", "secbot-key-helper");
  assert.match(helper, /ThreadingHTTPServer\(\("127\.0\.0\.1", args\.port\)/);
  assert.doesNotMatch(helper, /0\.0\.0\.0|"::"/);
});

test("the first master key is made once, with umask 077, and never logged", () => {
  const task = helperTasks.find((t) => /first master key once/.test(t.name));
  assert.ok(task);
  assert.equal(task.no_log, true);
  assert.match(task["ansible.builtin.shell"], /umask 077/);
  assert.match(task["ansible.builtin.shell"], /head -c 32 \/dev\/urandom/);
  assert.equal(task.args.creates, "/etc/secbot/secrets-keys/{{ item }}/k1.key");
  const owner = helperTasks.find((t) => /first master key to the key helper's user/.test(t.name));
  assert.equal(owner["ansible.builtin.file"].owner, "secbot-keys");
  assert.equal(owner["ansible.builtin.file"].mode, "0400");
  const current = helperTasks.find((t) => /first key current/.test(t.name));
  assert.equal(current["ansible.builtin.copy"].force, false);
});

test("the key helper role never installs a package or a runtime", () => {
  const text = read(helperRole, "tasks", "main.yml");
  assert.doesNotMatch(text, /ansible\.builtin\.(apt|package|dnf|yum|pip)\b/);
});

test("no master key file is in the repo", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
  assert.deepEqual(
    tracked.filter((path) => /\.key$|secrets-keys\//.test(path)),
    [],
  );
});

// The release tool's guard-bench lab routes: test cell only, like the durability lab's routes.
const releaseTool = read(
  root,
  "infra",
  "ansible",
  "roles",
  "deploy_users",
  "files",
  "secbot-release",
);

/** The body of one shell function of the release tool, up to its closing brace. */
function shellFunction(name) {
  const start = releaseTool.indexOf(`\n${name}() {\n`);
  assert.ok(start >= 0, `${name} is defined`);
  return releaseTool.slice(start, releaseTool.indexOf("\n}\n", start));
}

test("the release tool allows the guard-bench routes and checks --calls", () => {
  const routes = /\[\[ "\$lab_route" =~ \^\(([^)]*)\)\$ \]\]/.exec(releaseTool)?.[1].split("|");
  assert.ok(routes?.includes("guard-bench") && routes.includes("guard-bench-state"));
  // The durability lab's routes stay as they were.
  for (const route of ["arm", "state", "load", "load-state"]) assert.ok(routes.includes(route));
  assert.match(releaseTool, /--calls\) calls="\$value"/);
  assert.match(releaseTool, /--adapter\) adapter="\$value"/);
  assert.match(
    releaseTool,
    /\[\[ "\$adapter" =~ \^\(clef\|clef-flash\|jev\)\$ \]\] \|\| die "bad --adapter/,
  );
  assert.match(releaseTool, /\[\[ "\$calls" =~ \^\[0-9\]\{1,3\}\$ \]\] \|\| die "bad --calls/);
});

test("the guard-bench routes run only on the test cell, as POST with calls and GET for the state", () => {
  const lab = shellFunction("do_lab");
  // test_cell_only comes before any other step, so production never reaches the bench.
  assert.match(lab, /^\s*do_lab\(\) \{\s*test_cell_only\n/);
  assert.match(
    lab,
    /path="\/lab\/guard-bench\?calls=\$\{calls:-100\}\$\{adapter:\+&adapter=\$adapter\}"/,
  );
  assert.match(lab, /guard-bench-state\) method=GET ;;/);
  assert.match(shellFunction("test_cell_only"), /\[ "\$env" = "test-cell" \] \|\| die/);
});

test("a deploy to the fleet that serves the secrets cell stops early without its key helper", () => {
  const render = shellFunction("render_app");
  assert.match(
    render,
    /\[ -n "\$serves_secrets" \] && ! \/usr\/bin\/systemctl is-active --quiet "secbot-key-helper@\$target_env"; then\n\s+die "the secrets cell's key helper/,
  );
});

test("the guard-bench routes send the operator key, which the worker asks for there", () => {
  const lab = shellFunction("do_lab");
  assert.match(
    lab,
    /guard-bench \| guard-bench-state\) header="\$\(operator_header "\$\(env_of_fleet test\)"\)" ;;/,
  );
  assert.match(lab, /\$\{header:\+-H "@\$header"\}/);
  assert.ok(lab.includes('[ -z "$header" ] || rm -f "$header"'));
});

test("the guard bench's examples run: --examples [--repeat 1-3] sends examples=1 with the repeat", () => {
  const lab = shellFunction("do_lab");
  assert.match(
    lab,
    /path="\/lab\/guard-bench\?examples=1&repeat=\$\{repeat:-2\}\$\{adapter:\+&adapter=\$adapter\}"/,
  );
  assert.match(releaseTool, /--examples\) examples=1; i=\$\(\(i \+ 1\)\) ;;/);
  assert.match(releaseTool, /--repeat\) repeat="\$value"/);
});

/** Runs the release tool's argument checks only: each command here is refused before any step. */
function refusal(command) {
  try {
    execFileSync(
      "bash",
      [
        join(root, "infra", "ansible", "roles", "deploy_users", "files", "secbot-release"),
        "deploy-test",
      ],
      { env: { ...process.env, SSH_ORIGINAL_COMMAND: command }, encoding: "utf8", stdio: "pipe" },
    );
  } catch (error) {
    return { status: error.status, stderr: String(error.stderr) };
  }
  return { status: 0, stderr: "" };
}

// The checks run the tool under bash, so they need a Linux shell (CI, or WSL on a Windows host).
test("the release tool refuses --examples and --repeat outside the guard bench's examples run", {
  skip: process.platform === "win32" ? "needs a Linux bash" : false,
}, () => {
  const refused = [
    [
      "lab --env test-cell --route guard-bench --examples --calls 5",
      /--calls or --examples, not both/,
    ],
    ["lab --env test-cell --route state --examples", /--examples needs --route guard-bench/],
    ["lab --env test-cell --route guard-bench --repeat 2", /--repeat needs --examples/],
    ["lab --env test-cell --route guard-bench --examples --repeat 4", /bad --repeat '4'/],
    ["lab --env test-cell --route guard-bench --examples --repeat 0", /bad --repeat '0'/],
    ["lab --env production --route guard-bench --examples", /may not use environment 'production'/],
  ];
  for (const [command, message] of refused) {
    const { status, stderr } = refusal(command);
    assert.equal(status, 1, command);
    assert.match(stderr, message, command);
  }
});

/**
 * Runs the release tool's do_snapshot for production against a temporary deploy directory.
 * `deployed` lists the fleets that have a current deploy; `failing` lists the fleets whose
 * snapshot call fails. The lock and the operator call are stubs: the stub answers like a cell.
 */
function snapshotRun({ deployed, failing = [] }) {
  const deploys = mkdtempSync(join(tmpdir(), "secbot-snapshot-"));
  try {
    for (const fleet of deployed) mkdirSync(join(deploys, fleet, "current"), { recursive: true });
    const oneLiner = (name) => {
      const line = new RegExp(`^${name}\\(\\) \\{.*\\}$`, "m").exec(releaseTool)?.[0];
      assert.ok(line, `${name} is defined`);
      return line;
    };
    const script = [
      "set -euo pipefail",
      `DEPLOYS='${deploys}'`,
      "env=production snapshot_id=pre-v1.0.0-1",
      `failing=' ${failing.join(" ")} '`,
      'die() { echo "secbot-release: $*" >&2; exit 1; }',
      "with_lock() { :; }",
      'ops_call() { [[ "$failing" != *" $1 "* ]] || return 1; echo "{\\"snapshots\\":[{\\"cell\\":\\"$1-cell\\"}],\\"contractStep\\":3}"; }',
      shellFunction("fleets_of_env"),
      "}",
      oneLiner("fleet_dir"),
      shellFunction("do_snapshot"),
      "}",
      "do_snapshot",
    ].join("\n");
    const { status, stdout, stderr } = spawnSync("bash", ["-s"], {
      input: script,
      encoding: "utf8",
    });
    return { status, stdout, stderr };
  } finally {
    rmSync(deploys, { recursive: true, force: true });
  }
}

test("the first release's snapshot skips only the fleets that fail and were never deployed", {
  skip: process.platform === "win32" ? "needs a Linux bash" : false,
}, () => {
  const skipLine = (fleet) =>
    `fleet ${fleet} skipped: snapshot failed and nothing was ever deployed here`;

  // (a) No deploy and no running app: both fleets are skipped, and the list is empty.
  const none = snapshotRun({ deployed: [], failing: ["prod-owner", "prod-shared"] });
  assert.equal(none.status, 0, none.stderr);
  assert.deepEqual(JSON.parse(none.stdout), {
    id: "pre-v1.0.0-1",
    snapshots: [],
    contractStep: 0,
  });
  for (const fleet of ["prod-owner", "prod-shared"]) {
    assert.ok(none.stderr.includes(skipLine(fleet)), none.stderr);
  }

  // (b) A first deploy stopped before `current` was linked, but the owner app runs: it is
  // snapshotted, and only the fleet that fails is skipped.
  const interrupted = snapshotRun({ deployed: [], failing: ["prod-shared"] });
  assert.equal(interrupted.status, 0, interrupted.stderr);
  assert.deepEqual(JSON.parse(interrupted.stdout), {
    id: "pre-v1.0.0-1",
    snapshots: [{ cell: "prod-owner-cell" }],
    contractStep: 3,
  });
  assert.ok(!interrupted.stderr.includes(skipLine("prod-owner")), interrupted.stderr);
  assert.ok(interrupted.stderr.includes(skipLine("prod-shared")), interrupted.stderr);

  // (c) A deployed fleet whose snapshot fails still stops the release.
  const failed = snapshotRun({ deployed: ["prod-shared"], failing: ["prod-shared"] });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /secbot-release: snapshot of prod-shared failed/);
  assert.ok(!failed.stderr.includes(skipLine("prod-shared")), failed.stderr);

  // (d) Both fleets deployed: both are snapshotted.
  const both = snapshotRun({ deployed: ["prod-owner", "prod-shared"] });
  assert.equal(both.status, 0, both.stderr);
  assert.deepEqual(
    JSON.parse(both.stdout).snapshots.map((item) => item.cell),
    ["prod-owner-cell", "prod-shared-cell"],
  );
});
