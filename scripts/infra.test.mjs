// The cell log settings in the celld role: celld's own lines are filtered to warn while every
// cell line is kept, the cells log to their own journal namespace with its own retention, and the
// change stays inside Secbot's scope (no VPS-wide journald config, no filter in the file the
// release tool sources), and the secrets cell's key helper role.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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

// The secrets cell's key helper: its unit runs as the celld user on loopback with hardening, the
// first master key is made once on the host and never shown, and no key file is in the repo.
const helperRole = join(root, "infra", "ansible", "roles", "secrets_key_helper");
const helperUnit = read(helperRole, "templates", "secbot-key-helper@.service.j2");
const helperTasks = yaml.load(read(helperRole, "tasks", "main.yml"));

test("the key helper unit runs as celld, hardened, and writes only its own key directory", () => {
  const service = section(helperUnit, "Service");
  for (const line of [
    "User=celld",
    "Group=celld",
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
    "ExecStart=/usr/local/bin/secbot-key-helper --key-dir /etc/secbot/secrets-keys/%i --port ${SECBOT_KEY_HELPER_PORT}",
  );
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
  const owner = helperTasks.find((t) => /first master key to the celld user/.test(t.name));
  assert.equal(owner["ansible.builtin.file"].owner, "celld");
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
  assert.match(releaseTool, /\[\[ "\$calls" =~ \^\[0-9\]\{1,3\}\$ \]\] \|\| die "bad --calls/);
});

test("the guard-bench routes run only on the test cell, as POST with calls and GET for the state", () => {
  const lab = shellFunction("do_lab");
  // test_cell_only comes before any other step, so production never reaches the bench.
  assert.match(lab, /^\s*do_lab\(\) \{\s*test_cell_only\n/);
  assert.match(lab, /guard-bench\) path="\/lab\/guard-bench\?calls=\$\{calls:-100\}" ;;/);
  assert.match(lab, /guard-bench-state\) method=GET ;;/);
  assert.match(shellFunction("test_cell_only"), /\[ "\$env" = "test-cell" \] \|\| die/);
});
