// The one redactor: secret-named fields at any depth, token-shaped text, named literal values,
// and the size cap that keeps the fields a rule matched.
import { afterEach, describe, expect, it } from "vitest";
import {
  ARGUMENTS_LIMIT,
  addKnownSecretValues,
  clearKnownSecretValues,
  isSecretKey,
  KEPT_TEXT_LIMIT,
  REDACTED,
  redact,
  redactText,
  redactTokens,
  setKnownSecretValues,
} from "../src/redact.ts";

describe("redact", () => {
  it("replaces secret-named fields at any depth, in objects and arrays", () => {
    expect(
      redact({
        query: "trains to Leeds",
        api_key: "abc",
        nested: { Password: "p", list: [{ "access-token": "t", note: "fine" }] },
      }),
    ).toEqual({
      query: "trains to Leeds",
      api_key: REDACTED,
      nested: { Password: REDACTED, list: [{ "access-token": REDACTED, note: "fine" }] },
    });
  });

  it.each([
    "password",
    "passwd",
    "client_secret",
    "token",
    "API_KEY",
    "apiKey",
    "Authorization",
    "cookie",
    "credentials",
    "private-key",
  ])("treats %s as a secret field name", (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  it("keeps ordinary field names", () => {
    for (const key of ["specialist", "brief", "text", "at", "query", "document"]) {
      expect(isSecretKey(key)).toBe(false);
    }
  });

  it.each([
    ["Bearer abc.def-ghi", "use [redacted] now"],
    ["sk-or-v1-0123456789abcdef", "use [redacted] now"],
    [`ghp_${"a1".repeat(12)}`, "use [redacted] now"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", "use [redacted] now"],
    ["0123456789abcdef0123456789abcdef01", "use [redacted] now"],
    ["QWxhZGRpbjpvcGVuIHNlc2FtZQ0123456789==", "use [redacted] now"],
  ])("replaces the token %s inside text", (token, expected) => {
    expect(redactText(`use ${token} now`)).toBe(expected);
  });

  it("leaves ordinary sentences and long plain words alone", () => {
    const text = "Find direct trains to Leeds on Friday, leaving after 07:00.";
    expect(redactText(text)).toBe(text);
    expect(redactText("a".repeat(40))).toBe("a".repeat(40));
  });

  it("replaces a named value inside a sentence", () => {
    expect(redact({ text: "my code is hunter22 ok" }, { values: ["hunter22"] })).toEqual({
      text: "my code is [redacted] ok",
    });
  });

  it("caps an object at the byte limit, dropping the largest unkept fields first", () => {
    const value = {
      specialist: "research",
      brief: "b".repeat(1_500),
      extra: "e".repeat(1_000),
      small: "s",
    };
    const capped = redact(value, { keep: ["brief"], maxBytes: ARGUMENTS_LIMIT }) as Record<
      string,
      unknown
    >;
    expect(capped.brief).toBe(value.brief);
    expect(capped.specialist).toBe("research");
    expect(capped.extra).toBeUndefined();
    expect(capped["…dropped"]).toEqual(["extra"]);
    const unkept = redact(value, { maxBytes: ARGUMENTS_LIMIT }) as Record<string, unknown>;
    expect(unkept.brief).toBeUndefined();
    expect(unkept["…dropped"]).toEqual(["brief"]);
    expect(new TextEncoder().encode(JSON.stringify(unkept)).length).toBeLessThanOrEqual(
      ARGUMENTS_LIMIT,
    );
  });
  it("cuts a kept text when the kept fields alone pass the cap", () => {
    const long = "w ".repeat(5_000);
    const capped = redact(
      { brief: long, extra: "e".repeat(100) },
      { keep: ["brief"], maxBytes: ARGUMENTS_LIMIT },
    ) as Record<string, unknown>;
    expect(capped.extra).toBeUndefined();
    expect(String(capped.brief).startsWith(long.slice(0, KEPT_TEXT_LIMIT))).toBe(true);
    expect(String(capped.brief)).toContain(`[cut from ${long.length} characters]`);
    expect(new TextEncoder().encode(JSON.stringify(capped)).length).toBeLessThanOrEqual(
      ARGUMENTS_LIMIT,
    );
  });

  it("keeps a UUID, alone or in a path, and still hides a token-like run", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(redactText(`item ${id}`)).toBe(`item ${id}`);
    expect(redactText(`/v1/items/${id}/next`)).toBe(`/v1/items/${id}/next`);
    expect(redactText("key Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWpr")).toBe(`key ${REDACTED}`);
  });

  it("redacts only token forms in a service's answer", () => {
    const run = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWpr";
    expect(redactTokens(`id ${run}, token tok-value-1234`, ["tok-value-1234"])).toBe(
      `id ${run}, token ${REDACTED}`,
    );
  });
});

describe("learned secret values", () => {
  // A granted secret's value as the person cell learns it; plain words, so only the learned set
  // (not the token shape) can catch it.
  const LEARNED = "plum orchard lantern";
  afterEach(() => clearKnownSecretValues());

  it("replaces a learned value in a nested argument with no values passed", () => {
    addKnownSecretValues([LEARNED]);
    expect(redact({ to: "sam", body: { lines: [`the code is ${LEARNED}.`] } })).toEqual({
      to: "sam",
      body: { lines: [`the code is ${REDACTED}.`] },
    });
  });

  it("replaces a learned value in a reason, beside the values the caller passes", () => {
    addKnownSecretValues([LEARNED]);
    expect(redactText(`refused: ${LEARNED} and the zebra key`, ["zebra key"])).toBe(
      `refused: ${REDACTED} and the ${REDACTED}`,
    );
  });

  it("replaces a learned value in a capped state, the kept field included", () => {
    addKnownSecretValues([LEARNED]);
    const capped = redact(
      { note: `remember ${LEARNED}`, filler: "x".repeat(4_000) },
      { keep: ["note"], maxBytes: 200 },
    );
    expect(capped).toEqual({ note: `remember ${REDACTED}`, "…dropped": ["filler"] });
    expect(JSON.stringify(capped)).not.toContain(LEARNED);
  });

  it("keeps each cell's values apart, and a reload replaces only that cell's", () => {
    setKnownSecretValues("owner", [LEARNED, "old granted value"]);
    addKnownSecretValues(["second cell value"], "second");
    expect(redactText(`${LEARNED} / second cell value`)).toBe(`${REDACTED} / ${REDACTED}`);
    setKnownSecretValues("owner", [LEARNED]);
    expect(redactText("old granted value")).toBe("old granted value");
    expect(redactText("second cell value")).toBe(REDACTED);
    clearKnownSecretValues("second");
    expect(redactText("second cell value")).toBe("second cell value");
  });

  it("ignores values too short to replace safely, and forgets on clear", () => {
    addKnownSecretValues(["abc", LEARNED]);
    expect(redactText("abc abc")).toBe("abc abc");
    clearKnownSecretValues();
    expect(redactText(LEARNED)).toBe(LEARNED);
  });
});
