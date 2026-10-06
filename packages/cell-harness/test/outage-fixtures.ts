import { expect } from "vitest";

/** Terminal error texts the installed pi-ai produced for OpenRouter failures (see gateway.test.ts). */
export const FAILURES = [
  '429 {"error":{"code":429,"message":"Rate limit exceeded"}}',
  '503 {"error":{"code":503,"message":"No available provider"}}',
  "Request timed out.",
  '502: {"code":502,"message":"Provider returned error"}',
];

export const ALERT_ENV = {
  BETTERSTACK_INCIDENTS_TOKEN: "test-token",
  BETTERSTACK_REQUESTER_EMAIL: "owner@example.com",
  BETTERSTACK_BASE_URL: "http://incidents.test",
};

/** A stand-in for the Better Stack incidents endpoint that records each incident and its time. */
export function incidentStub() {
  const incidents: { at: number; body: Record<string, unknown>; auth: string | null }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    expect(String(input)).toBe("http://incidents.test/api/v3/incidents");
    incidents.push({
      at: Date.now(),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      auth: new Headers(init?.headers).get("authorization"),
    });
    return new Response("{}", { status: 201 });
  };
  return { incidents, fetcher };
}
