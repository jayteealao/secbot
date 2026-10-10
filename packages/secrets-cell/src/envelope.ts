/**
 * Envelope encryption for one secret: AES-GCM-256 under a fresh data key, and the data key
 * AES-GCM-256 under a key-encryption key that the key custody derives for this record alone.
 *
 * Per seal: a 32-byte data key, a 12-byte data IV, a 12-byte wrap IV, and a 16-byte record salt,
 * all from `crypto.getRandomValues` (an IV is never reused). The value's additional data binds
 * the person and the name; the data key's binds the person, the name, and the key id; the derived
 * key's info binds the person, the name, and the salt. A ciphertext or wrapped key copied into
 * another person's or another name's record fails its tag check.
 *
 * The data key is wrapped by a plain AES-GCM encrypt of its raw bytes: celld refuses `jwk` for a
 * secret key in `wrapKey` (celld v0.6.1 docs/cloudflare-compat.md:130); AES-GCM with a raw key is
 * served (crates/celld/js/crypto.js:170-231).
 */
import type { KeyCustody } from "./key-custody.ts";

/** A stored record: only ciphertext, the wrapped data key, the key id, and non-secret salt and IVs. */
export interface SealedSecret {
  readonly person: string;
  readonly name: string;
  readonly keyId: string;
  /** Base64 of the 16-byte record salt. */
  readonly salt: string;
  /** Base64 of the value's 12-byte IV. */
  readonly iv: string;
  /** Base64 of the data key's 12-byte IV. */
  readonly wrapIv: string;
  /** Base64 of the wrapped data key (32 bytes plus the 16-byte tag). */
  readonly wrappedKey: string;
  /** Base64 of the value's ciphertext plus its tag. */
  readonly ciphertext: string;
}

const encoder = new TextEncoder();

export const toBase64 = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

export const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));

const valueData = (person: string, name: string) =>
  encoder.encode(`secbot-secret/v1|${person}|${name}`);
const keyData = (person: string, name: string, keyId: string) =>
  encoder.encode(`secbot-dek/v1|${person}|${name}|${keyId}`);

/** The derivation info of a record's key-encryption key. */
export const kekInfo = (person: string, name: string, salt: string) =>
  `secbot-kek/v1|${person}|${name}|${salt}`;

const aesKey = (raw: Uint8Array, usage: "encrypt" | "decrypt") =>
  crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [usage]);

async function encrypt(raw: Uint8Array, iv: Uint8Array, data: Uint8Array, plain: Uint8Array) {
  const key = await aesKey(raw, "encrypt");
  return new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: data as BufferSource },
      key,
      plain as BufferSource,
    ),
  );
}

async function decrypt(raw: Uint8Array, iv: Uint8Array, data: Uint8Array, sealed: Uint8Array) {
  const key = await aesKey(raw, "decrypt");
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource, additionalData: data as BufferSource },
      key,
      sealed as BufferSource,
    ),
  );
}

/** The data key wrapped under a fresh salt and the key-encryption key of `keyId`. */
async function wrap(
  person: string,
  name: string,
  keyId: string,
  dataKey: Uint8Array,
  custody: KeyCustody,
) {
  const salt = toBase64(random(16));
  const wrapIv = random(12);
  const kek = await custody.deriveKey(keyId, kekInfo(person, name, salt));
  const wrappedKey = await encrypt(kek, wrapIv, keyData(person, name, keyId), dataKey);
  kek.fill(0);
  return { keyId, salt, wrapIv: toBase64(wrapIv), wrappedKey: toBase64(wrappedKey) };
}

/** The record's data key; throws when the record was moved or changed. */
async function unwrap(record: SealedSecret, custody: KeyCustody): Promise<Uint8Array> {
  const kek = await custody.deriveKey(
    record.keyId,
    kekInfo(record.person, record.name, record.salt),
  );
  try {
    return await decrypt(
      kek,
      fromBase64(record.wrapIv),
      keyData(record.person, record.name, record.keyId),
      fromBase64(record.wrappedKey),
    );
  } finally {
    kek.fill(0);
  }
}

/** Seals `plaintext` for `person`'s secret `name` under the custody's current key. */
export async function seal(
  person: string,
  name: string,
  plaintext: string,
  custody: KeyCustody,
): Promise<SealedSecret> {
  const keyId = await custody.currentKeyId();
  const dataKey = random(32);
  const iv = random(12);
  try {
    const ciphertext = await encrypt(
      dataKey,
      iv,
      valueData(person, name),
      encoder.encode(plaintext),
    );
    const wrapped = await wrap(person, name, keyId, dataKey, custody);
    return { person, name, ...wrapped, iv: toBase64(iv), ciphertext: toBase64(ciphertext) };
  } finally {
    dataKey.fill(0);
  }
}

/** The plaintext of a record; throws when any part of the record was moved or changed. */
export async function openSealed(record: SealedSecret, custody: KeyCustody): Promise<string> {
  const dataKey = await unwrap(record, custody);
  try {
    const plain = await decrypt(
      dataKey,
      fromBase64(record.iv),
      valueData(record.person, record.name),
      fromBase64(record.ciphertext),
    );
    return new TextDecoder().decode(plain);
  } finally {
    dataKey.fill(0);
  }
}

/** The record re-wrapped under `keyId` with a fresh salt; the ciphertext does not change. */
export async function rewrap(
  record: SealedSecret,
  keyId: string,
  custody: KeyCustody,
): Promise<SealedSecret> {
  const dataKey = await unwrap(record, custody);
  try {
    return { ...record, ...(await wrap(record.person, record.name, keyId, dataKey, custody)) };
  } finally {
    dataKey.fill(0);
  }
}
