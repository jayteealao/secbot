// A role's model changes with no release and the role's next request uses it; an id the
// gateway cannot resolve is refused and the map is unchanged.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RefusedChange } from "../src/cell-parts.ts";
import { ALTERNATE_MODEL, openTestCell, type TestCell } from "./fixtures.ts";

let test: TestCell | undefined;
afterEach(async () => {
  await test?.cell.close();
  test = undefined;
  vi.restoreAllMocks();
});

const lines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

describe("role-to-model map", () => {
  it("starts from the release defaults", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const map = await test.cell.listRoleModels();
    expect(map[0]).toEqual({
      role: "lead",
      model: "anthropic/claude-opus-5.5",
      source: "release default",
    });
    expect(map.slice(1).map((entry) => entry.model)).toEqual(
      Array(4).fill("anthropic/claude-haiku-4.5"),
    );
  });

  it("uses a changed model on the lead's next turn, and keeps it across a restart", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const t = test;
    await (await t.cell.submit("first", "a")).wait(BACKGROUND_CONTEXT);
    expect(t.gateway.requests.at(-1)?.modelId).toBe("anthropic/claude-opus-5.5");
    await t.cell.setRoleModel("lead", ALTERNATE_MODEL);
    await (await t.cell.submit("second", "b")).wait(BACKGROUND_CONTEXT);
    expect(t.gateway.requests.at(-1)?.modelId).toBe(ALTERNATE_MODEL);
    expect(lines(log).find((line) => line.event === "role_model.changed")).toMatchObject({
      role: "lead",
      from: "anthropic/claude-opus-5.5",
      to: ALTERNATE_MODEL,
      outcome: "changed",
    });
    await t.reopen();
    await (await t.cell.submit("third", "c")).wait(BACKGROUND_CONTEXT);
    expect(t.gateway.requests.at(-1)?.modelId).toBe(ALTERNATE_MODEL);
    expect((await t.cell.listRoleModels())[0]?.source).toBe("changed");
  });

  it("changes a specialist's model", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    await test.cell.setRoleModel("research", ALTERNATE_MODEL);
    const map = await test.cell.listRoleModels();
    expect(map.find((entry) => entry.role === "research")).toEqual({
      role: "research",
      model: ALTERNATE_MODEL,
      source: "changed",
    });
  });

  it("refuses an unresolvable id or an unknown role and leaves the map unchanged", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    test = await openTestCell();
    const before = await test.cell.listRoleModels();
    await expect(test.cell.setRoleModel("lead", "openai/not-a-model")).rejects.toThrow(
      RefusedChange,
    );
    await expect(test.cell.setRoleModel("astrology", ALTERNATE_MODEL)).rejects.toThrow(
      /unknown role/,
    );
    expect(await test.cell.listRoleModels()).toEqual(before);
    expect(lines(log).filter((line) => line.event === "role_model.changed")).toEqual([
      expect.objectContaining({ outcome: "refused", to: "openai/not-a-model" }),
      expect.objectContaining({ outcome: "refused", role: "astrology" }),
    ]);
  });
});
