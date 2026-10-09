/**
 * Key custody: the only place the secrets cell touches key material.
 *
 * A celld cell cannot read a host file (celld v0.6.1 docs/cloudflare-compat.md:157-159: `node:fs`
 * sees only a request-local /tmp and a read-only /bundle), and a value given to it at deploy is
 * stored in the deploy manifest at the bucket provider (crates/celld/deploy.rs:1864-1895). So the
 * master keys stay with the key helper, a small host process run as the celld user that reads
 * /etc/secbot/secrets-keys/<env>/ (infra/ansible/roles/secrets_key_helper). A cell reaches it on a
 * loopback port: celld's outbound fetch has no address filter (crates/celld/js.rs:711-723,
 * 2423-2428, 8702-8760).
 *
 * The helper never returns a master key. It returns a key derived for one record:
 * HKDF-SHA256(ikm = the master key file's 32 bytes, salt = empty, info, 32 bytes) (RFC 5869),
 * where `info` names the person, the secret, and the record's random salt. `testCustody` derives
 * the same way through Web Crypto, so the stand-in tests and the real helper agree byte for byte.
 */

/** The helper's own answer: usable, or why not (for example "key file missing"). */
export type CustodyHealth =
  | { readonly ok: true; readonly current: string; readonly keyIds: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export interface KeyCustody {
  health(): Promise<CustodyHealth>;
  /** The key id new records are sealed under. */
  currentKeyId(): Promise<string>;
  /** 32 bytes derived from master key `keyId` for `info`. */
  deriveKey(keyId: string, info: string): Promise<Uint8Array>;
  /** Makes the next master key current when `from` is still current; answers the current id. */
  rotate(from: string): Promise<string>;
}

/** The key helper did not answer, or answered that its key files are not usable. */
export class KeyCustodyUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`key helper unavailable: ${reason}`);
    this.name = "KeyCustodyUnavailable";
  }
}

/** One helper call's limit; the helper answers on loopback in milliseconds. */
export const CUSTODY_TIMEOUT_MS = 5_000;

const KEY_ID = /^k[1-9][0-9]{0,5}$/;

const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Custody through the host key helper at `url` (http://127.0.0.1:<port>). */
export function helperCustody(
  url: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): KeyCustody {
  const base = url.replace(/\/+$/, "");
  const call = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    if (base === "") throw new KeyCustodyUnavailable("no key helper address");
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(CUSTODY_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new KeyCustodyUnavailable(
        timedOut ? "the key helper did not answer in time" : "the key helper did not answer",
      );
    }
    const answer = (await response.json().catch(() => ({}))) as {
      reason?: string;
      error?: string;
    } & T;
    if (!response.ok) {
      throw new KeyCustodyUnavailable(
        answer.reason ?? answer.error ?? `the key helper answered ${response.status}`,
      );
    }
    return answer;
  };
  return {
    health: async () => {
      try {
        const answer = await call<{
          ok?: boolean;
          current?: string;
          keyIds?: string[];
          reason?: string;
        }>("GET", "/health");
        if (
          answer.ok === true &&
          typeof answer.current === "string" &&
          KEY_ID.test(answer.current)
        ) {
          return { ok: true, current: answer.current, keyIds: answer.keyIds ?? [answer.current] };
        }
        return { ok: false, reason: answer.reason ?? "the key helper's answer was not usable" };
      } catch (error) {
        return {
          ok: false,
          reason:
            error instanceof KeyCustodyUnavailable ? error.reason : "the key helper did not answer",
        };
      }
    },
    currentKeyId: async () => {
      const answer = await call<{ ok?: boolean; current?: string; reason?: string }>(
        "GET",
        "/health",
      );
      if (
        answer.ok !== true ||
        typeof answer.current !== "string" ||
        !KEY_ID.test(answer.current)
      ) {
        throw new KeyCustodyUnavailable(answer.reason ?? "no current key");
      }
      return answer.current;
    },
    deriveKey: async (keyId, info) => {
      const answer = await call<{ key?: string }>("POST", "/derive", { keyId, info });
      const key = typeof answer.key === "string" ? fromBase64(answer.key) : new Uint8Array();
      if (key.length !== 32)
        throw new KeyCustodyUnavailable("the key helper's key was not 32 bytes");
      return key;
    },
    rotate: async (from) => {
      const answer = await call<{ current?: string }>("POST", "/rotate", { from });
      if (typeof answer.current !== "string" || !KEY_ID.test(answer.current)) {
        throw new KeyCustodyUnavailable("the key helper's rotate answer was not usable");
      }
      return answer.current;
    },
  };
}

/** HKDF-SHA256 with an empty salt (RFC 5869), as the key helper derives. */
export async function hkdfSha256(ikm: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Tests: master keys in memory, with the helper's derivation and rotation. Never used in a cell.
 */
export function testCustody(
  options: { readonly keys?: Record<string, Uint8Array>; readonly current?: string } = {},
): KeyCustody & { readonly keys: Map<string, Uint8Array> } {
  const keys = new Map<string, Uint8Array>(
    Object.entries(options.keys ?? { k1: crypto.getRandomValues(new Uint8Array(32)) }),
  );
  let current = options.current ?? [...keys.keys()].sort().at(-1) ?? "k1";
  return {
    keys,
    health: async () => ({ ok: true, current, keyIds: [...keys.keys()] }),
    currentKeyId: async () => current,
    deriveKey: async (keyId, info) => {
      const master = keys.get(keyId);
      if (master === undefined) throw new KeyCustodyUnavailable("unknown key id");
      return hkdfSha256(master, info);
    },
    rotate: async (from) => {
      if (from !== current) return current;
      const next = `k${Number(current.slice(1)) + 1}`;
      keys.set(next, crypto.getRandomValues(new Uint8Array(32)));
      current = next;
      return current;
    },
  };
}
