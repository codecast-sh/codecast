import { describe, it, expect } from "bun:test";
import { defineFeatures } from "./catalog";
import { createFlagsCommands, parseOnOff, USAGE } from "./commands";
import type { FlagsClient } from "./posthog/types";

const catalog = defineFeatures([
  { key: "chat", name: "Team chat", desc: "" },
  { key: "calls", name: "Calls", desc: "" },
]);

function make(posthog?: (id: string) => FlagsClient) {
  const out: string[] = [];
  const err: string[] = [];
  const rows: Record<string, Record<string, boolean>> = { t1: { chat: true } };
  const cmds = createFlagsCommands({
    catalog,
    gates: {
      load: async (s) => rows[s] ?? null,
      save: async (s, k, v) => {
        rows[s] = { ...(rows[s] ?? {}), [k]: v };
      },
    },
    posthog,
    write: (l) => out.push(l),
    writeError: (l) => err.push(l),
  });
  return { cmds, out, err, rows };
}

describe("flags commands", () => {
  it("parseOnOff", () => {
    expect(parseOnOff("on")).toBe(true);
    expect(parseOnOff("FALSE")).toBe(false);
    expect(parseOnOff("maybe")).toBeNull();
  });
  it("list formats state and default marker", async () => {
    const m = make();
    await m.cmds.list("t1");
    expect(m.out).toEqual(["chat   on  Team chat", "calls  off (default)  Calls"]);
  });
  it("get and set", async () => {
    const m = make();
    await m.cmds.get("t1", "calls");
    expect(m.out).toEqual(["off"]);
    await m.cmds.set("t1", "calls", "on");
    expect(m.rows.t1.calls).toBe(true);
    expect(m.out[1]).toBe("calls on for t1");
    await m.cmds.set("t1", "calls", "meh");
    expect(m.err[0]).toBe("Expected on or off, got: meh");
    await m.cmds.get("t1", "zzz");
    expect(m.err[1]).toBe("Unknown feature: zzz. Known: chat, calls");
  });
  it("posthog verb", async () => {
    const client: FlagsClient & { snapshot: () => { values: Record<string, unknown> } } = {
      getFlag: (k) => k !== "off",
      getVariant: (k) => (k === "exp" ? "b" : undefined),
      getPayload: ((k: string) => (k === "exp" ? { p: 1 } : undefined)) as FlagsClient["getPayload"],
      reload: async () => {},
      snapshot: () => ({ values: { exp: "b", off: false, on: true } }),
    };
    const m = make(() => client);
    await m.cmds.posthog("d1");
    expect(m.out).toEqual(["exp  b  {\"p\":1}", "off  off", "on  on"]);
    const m2 = make(() => client);
    await m2.cmds.posthog("d1", "exp");
    expect(m2.out).toEqual(["exp  b  {\"p\":1}"]);
    const m3 = make();
    await m3.cmds.posthog("d1");
    expect(m3.err).toEqual(["PostHog is not configured."]);
  });
  it("run dispatches and reports usage", async () => {
    const m = make();
    expect(await m.cmds.run(["list", "t1"])).toBe(0);
    expect(await m.cmds.run(["set", "t1"])).toBe(1);
    expect(await m.cmds.run(["bogus"])).toBe(1);
    expect(m.err).toEqual([USAGE, USAGE]);
  });
});
