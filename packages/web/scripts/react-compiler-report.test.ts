// scripts/react-compiler-report.ts, run as a person runs it: over fixtures that
// hold each way a read can hide behind a function a hook hands back, and over
// the real allowlist, which must stay clean.
// Run: bun test scripts/react-compiler-report.test.ts
import { describe, expect, test } from "bun:test";
import path from "node:path";

const WEB = path.resolve(import.meta.dir, "..");

function report(...entries: string[]) {
  const run = Bun.spawnSync(["bun", "scripts/react-compiler-report.ts", "--json", ...entries], { cwd: WEB, stdout: "pipe", stderr: "pipe", env: { ...process.env, REACT_COMPILER: undefined, REACT_COMPILER_SOURCES: undefined } as any });
  const out = run.stdout.toString();
  return { exitCode: run.exitCode, ...(JSON.parse(out) as { compiled: Array<{ name: string }>; hazards: Array<{ fn: string; kind: string; what: string; via: string[] }>; unread: unknown[] }) };
}

describe("a read behind a function a hook hands back", () => {
  const r = report("scripts/__fixtures__/react-compiler-report/components.tsx");
  const found = Object.fromEntries(r.hazards.map((h) => [h.fn, `${h.kind}: ${h.what}`]));

  test("every fixture component compiles, so each verdict is about compiled code", () => {
    expect(r.compiled.map((c) => c.name).sort()).toEqual(["Forwarded", "FromArray", "FromMember", "FromObject", "Frozen", "InHandler", "LocalCallback", "Moving", "StoreRow"]);
  });

  test("a stable callback that reads the clock when called is named, however the hook hands it back", () => {
    expect(found.Frozen).toBe("clock: Date.now()"); // returned through useCallback
    expect(found.FromObject).toBe("clock: Date.now()"); // a property of a memoized object, destructured
    expect(found.FromMember).toBe("clock: Date.now()"); // the same, called as a member
    expect(found.FromArray).toBe("clock: Date.now()"); // an item of a returned tuple
    expect(found.Forwarded).toBe("clock: Date.now()"); // handed on from another hook
    expect(found.LocalCallback).toBe("clock: Date.now()"); // made by useCallback in the component itself
  });

  test("a stable callback that reads a store when called is named", () => {
    expect(found.StoreRow).toBe("store: useThingStore.getState()");
  });

  test("the report says which hook handed the function back", () => {
    expect(r.hazards.find((h) => h.fn === "Frozen")!.via).toEqual(["age (handed back by useFrozenAge())"]);
  });

  test("a callback made from an instant read per render is clean, and so is one called only from a handler", () => {
    expect(found.Moving).toBeUndefined();
    expect(found.InHandler).toBeUndefined();
    expect(r.hazards).toHaveLength(7);
    expect(r.exitCode).toBe(1);
  });
});

test("the allowlist the build compiles has no read the compiler cannot see", () => {
  const r = report();
  expect({ hazards: r.hazards, unread: r.unread, exitCode: r.exitCode }).toEqual({ hazards: [], unread: [], exitCode: 0 });
}, 120_000);
