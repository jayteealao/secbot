// The real key helper (a python3 process) with real key files and modes: the secrets cell refuses
// to start, logs the reason, and answers 503 for a missing key file or one another user can read,
// and starts with a correct one (AC-37); the helper's derivation equals the stand-in custody's;
// a repeated rotate makes one new key (AC-41 on the real helper); no key bytes reach its output;
// and a peer socket of another user is refused.
//
// Linux with python3 only: the modes are real there (WSL2 or CI). Key directories go under the
// system temp folder, never under /mnt/c, where WSL2 shows no real modes. Elsewhere the file
// prints one line and skips; a skip is not a pass.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeCelldStorage } from "../../cell-storage/test/fake-celld-storage.ts";
import { toBase64 } from "../src/envelope.ts";
import { helperCustody, hkdfSha256 } from "../src/key-custody.ts";
import { SecretsCell } from "../src/secrets-cell.ts";

const HELPER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../infra/ansible/roles/secrets_key_helper/files/secbot-key-helper",
);

function hasPython(): boolean {
  try {
    execFileSync("python3", ["-I", "-c", "import sys; assert sys.version_info >= (3, 8)"]);
    return true;
  } catch {
    return false;
  }
}

const runnable = process.platform === "linux" && hasPython();
if (!runnable) console.log("key helper tests need Linux and python3");

const VALUE = "test-secret-value-1234"; // gitleaks:allow (fake test value)

interface Running {
  readonly url: string;
  readonly port: number;
  readonly output: () => string;
  readonly child: ChildProcess;
}

const running: Running[] = [];
const dirs: string[] = [];
const cells: SecretsCell[] = [];

afterEach(async () => {
  for (const cell of cells.splice(0)) await cell.close();
  for (const helper of running.splice(0)) helper.child.kill();
  for (const dir of dirs.splice(0)) {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

/** A key directory with `k1.key` (mode `keyMode`) and `current`, or none when `keyMode` is null. */
async function keyDir(
  keyMode: number | null,
  dirMode = 0o700,
): Promise<{ dir: string; k1: Uint8Array }> {
  const root = await mkdtemp(join(tmpdir(), "secbot-keys-"));
  dirs.push(root);
  const dir = join(root, "test-cell");
  await mkdir(dir, { mode: 0o700 });
  const k1 = crypto.getRandomValues(new Uint8Array(32));
  if (keyMode !== null) {
    await writeFile(join(dir, "k1.key"), k1, { mode: 0o600 });
    await chmod(join(dir, "k1.key"), keyMode);
    await writeFile(join(dir, "current"), "k1\n", { mode: 0o600 });
    await chmod(join(dir, "current"), 0o400);
  }
  await chmod(dir, dirMode);
  return { dir, k1 };
}

async function startHelper(dir: string, proc?: string): Promise<Running> {
  const child = spawn("python3", [
    HELPER,
    "--key-dir",
    dir,
    "--port",
    "0",
    ...(proc ? ["--proc", proc] : []),
  ]);
  let output = "";
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const port = await new Promise<number>((done, fail) => {
    let line = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      line += chunk.toString("utf8");
      const found = /listening (\d+)/.exec(line);
      if (found !== null) done(Number(found[1]));
    });
    child.on("exit", (code) => fail(new Error(`the helper exited ${code}: ${output}`)));
  });
  const helper = { url: `http://127.0.0.1:${port}`, port, output: () => output, child };
  running.push(helper);
  return helper;
}

function cellWith(url: string) {
  const cell = new SecretsCell(
    { storage: new FakeCelldStorage() },
    { SECBOT_KEY_HELPER_URL: url },
    {
      version: "v0.0.0-test",
    },
  );
  cells.push(cell);
  return cell;
}

const events = (calls: readonly unknown[][]) =>
  calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);

describe.skipIf(!runnable)("the key helper on Linux", () => {
  it("refuses to start the cell without a key file and logs why (AC-37)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dir } = await keyDir(null);
    const helper = await startHelper(dir);
    const cell = cellWith(helper.url);
    expect(await cell.list({ person: "owner" })).toEqual({
      ok: false,
      status: 503,
      error: "secrets cell unavailable",
    });
    const refused = events(error.mock.calls).filter(
      (event) => event.event === "secrets.refused_start",
    );
    expect(refused[0]).toMatchObject({ reason: "key file missing" });
  });

  it.each([0o440, 0o644, 0o404])(
    "refuses to start the cell with a key file of mode %o (AC-37)",
    async (mode) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { dir } = await keyDir(mode);
      const helper = await startHelper(dir);
      const cell = cellWith(helper.url);
      expect(await cell.add({ person: "owner", name: "test-secret", value: VALUE })).toEqual({
        ok: false,
        status: 503,
        error: "secrets cell unavailable",
      });
      const refused = events(error.mock.calls).filter((e) => e.event === "secrets.refused_start");
      expect(refused[0]).toMatchObject({ reason: "key file readable by other users" });
    },
  );

  it("refuses a key directory other users can read, also after start", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { dir } = await keyDir(0o400);
    const helper = await startHelper(dir);
    const custody = helperCustody(helper.url);
    expect((await custody.health()).ok).toBe(true);
    await chmod(dir, 0o755);
    expect(await custody.health()).toEqual({
      ok: false,
      reason: "key directory readable by other users",
    });
    await chmod(dir, 0o700);
  });

  it("starts with a correct key file, seals, and opens (AC-37)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dir } = await keyDir(0o400);
    const helper = await startHelper(dir);
    const cell = cellWith(helper.url);
    expect(await cell.status()).toMatchObject({ status: "up" });
    expect(await cell.add({ person: "owner", name: "test-secret", value: VALUE })).toEqual({
      ok: true,
      value: { keyId: "k1", replaced: false },
    });
    await cell.allowlist({
      person: "owner",
      secret: "test-secret",
      agent: "research",
      action: "add",
    });
    await cell.grant({ person: "owner", secret: "test-secret", agent: "research" });
    expect(await cell.get({ person: "owner", agent: "research", name: "test-secret" })).toEqual({
      ok: true,
      value: { value: VALUE },
    });
  });

  it("derives what the stand-in custody derives, and never prints a key", async () => {
    const { dir, k1 } = await keyDir(0o400);
    const helper = await startHelper(dir);
    const info = "secbot-kek/v1|owner|test-secret|c2FsdA==";
    const answer = (await (
      await fetch(`${helper.url}/derive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keyId: "k1", info }),
      })
    ).json()) as { key: string };
    expect(answer.key).toBe(toBase64(await hkdfSha256(k1, info)));
    const unknown = await fetch(`${helper.url}/derive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyId: "k9", info }),
    });
    expect(unknown.status).toBe(400);
    const output = helper.output();
    expect(output).toContain('"route": "/derive"');
    expect(output).not.toContain(Buffer.from(k1).toString("hex"));
    expect(output).not.toContain(toBase64(k1));
    expect(output).not.toContain(answer.key);
  });

  it("makes one new key for a repeated rotate, and the cell re-wraps under it (AC-41)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { dir } = await keyDir(0o400);
    const helper = await startHelper(dir);
    const cell = cellWith(helper.url);
    for (const name of ["alpha", "beta"]) {
      await cell.add({ person: "owner", name, value: `${name}-value-0001` });
      await cell.allowlist({ person: "owner", secret: name, agent: "research", action: "add" });
      await cell.grant({ person: "owner", secret: name, agent: "research" });
    }
    expect(await cell.rotate()).toEqual({
      ok: true,
      value: { from: "k1", keyId: "k2", rewrapped: 2, remaining: 0 },
    });
    // A repeated rotate from k1 (a retry) makes no third key.
    const again = (await (
      await fetch(`${helper.url}/rotate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "k1" }),
      })
    ).json()) as { current: string };
    expect(again.current).toBe("k2");
    expect((await readFile(join(dir, "current"), "utf8")).trim()).toBe("k2");
    expect((await stat(join(dir, "k2.key"))).mode & 0o777).toBe(0o400);
    await expect(stat(join(dir, "k3.key"))).rejects.toThrow();
    for (const name of ["alpha", "beta"]) {
      expect(await cell.get({ person: "owner", agent: "research", name })).toEqual({
        ok: true,
        value: { value: `${name}-value-0001` },
      });
    }
  });

  it("refuses a peer whose socket another user owns", async () => {
    const { dir } = await keyDir(0o400);
    // A /proc with no sockets: the peer's owner is unknown, so it is refused.
    const empty = await mkdtemp(join(tmpdir(), "secbot-proc-"));
    dirs.push(empty);
    await mkdir(join(empty, "net"));
    await writeFile(join(empty, "net", "tcp"), "  sl  local_address rem_address\n");
    const unknown = await startHelper(dir, empty);
    expect((await fetch(`${unknown.url}/health`)).status).toBe(403);

    // A /proc whose table names our client socket under another user.
    const other = await mkdtemp(join(tmpdir(), "secbot-proc-"));
    dirs.push(other);
    await mkdir(join(other, "net"));
    const helper = await startHelper(dir, other);
    const localPort = 20_000 + Math.floor(Math.random() * 20_000);
    const hex = (port: number) => port.toString(16).toUpperCase().padStart(4, "0");
    const uid = (process.getuid?.() ?? 0) + 1;
    await writeFile(
      join(other, "net", "tcp"),
      [
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
        `   0: 0100007F:${hex(localPort)} 0100007F:${hex(helper.port)} 01 00000000:00000000 00:00000000 00000000  ${uid}        0 1 1 0 20 4 30 10 -1`,
      ].join("\n"),
    );
    const status = await new Promise<string>((done, fail) => {
      const socket = connect({ host: "127.0.0.1", port: helper.port, localPort }, () => {
        socket.write("GET /health HTTP/1.1\r\nHost: helper\r\nConnection: close\r\n\r\n");
      });
      let reply = "";
      socket.on("data", (chunk: Buffer) => {
        reply += chunk.toString("utf8");
      });
      socket.on("end", () => done(reply.split("\r\n")[0] ?? ""));
      socket.on("error", fail);
    });
    expect(status).toContain("403");
    expect(helper.output()).toContain("peer is not the celld user");
  });
});
