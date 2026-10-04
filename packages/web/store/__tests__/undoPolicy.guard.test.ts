import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { actionKind } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { UNDO_POLICY, UNDO_POLICY_FILES, UNDO_SPECS } from "../undo/policy";

// Every creator a gesture can call has an undo decision, written down once:
// a spec, or the reason it is never undoable. A new action that nobody
// classified fails here, which is how the same verb stays undoable from every
// surface that calls it. sync() creators never record, so most are plumbing
// that needs no entry; one a component calls may be a gesture, so it must say
// why it is never undoable.
const kinds = Object.entries(useInboxStore.getState() as unknown as Record<string, unknown>)
  .map(([name, fn]) => [name, actionKind(fn)] as const)
  .filter(([, kind]) => kind !== null);
const creators = kinds.filter(([, kind]) => kind !== "sync").map(([name]) => name).sort();
const syncCreators = kinds.filter(([, kind]) => kind === "sync").map(([name]) => name).sort();

// Every name called in the gesture surfaces: the sources under components/ and app/.
const WEB = join(import.meta.dir, "..", "..");
const calledInSurfaces = new Set<string>();
for (const dir of ["components", "app"]) {
  for (const f of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: join(WEB, dir) })) {
    if (/(^|\/)__tests__\/|\.test\.tsx?$/.test(f)) continue;
    for (const m of readFileSync(join(WEB, dir, f), "utf8").matchAll(/([\w$]+)\(/g)) calledInSurfaces.add(m[1]!);
  }
}

describe("undo policy covers every creator exactly once", () => {
  test("the store has creators to classify", () => {
    expect(creators.length).toBeGreaterThan(100);
  });

  test("every non-sync creator is classified", () => {
    const missing = creators.filter((name) => !(name in UNDO_POLICY));
    expect(missing).toEqual([]);
  });

  test("no creator is classified in two policy files", () => {
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const [file, policy] of Object.entries(UNDO_POLICY_FILES)) {
      for (const name of Object.keys(policy)) {
        if (seen.has(name)) twice.push(`${name} (${seen.get(name)} and ${file})`);
        seen.set(name, file);
      }
    }
    expect(twice).toEqual([]);
  });

  test("every sync creator a component calls says why it is never undoable", () => {
    const called = syncCreators.filter((name) => calledInSurfaces.has(name));
    expect(called.length).toBeGreaterThan(0);
    const missing = called.filter((name) => !(name in UNDO_POLICY));
    expect(missing).toEqual([]);
  });

  // The engine records only action() creators, so a spec on a sync() one
  // would never fire.
  test("a sync creator is only ever classified never", () => {
    const specced = syncCreators.filter((name) => UNDO_POLICY[name] && "spec" in UNDO_POLICY[name]!);
    expect(specced).toEqual([]);
  });

  test("no policy entry names a creator that does not exist", () => {
    const known = new Set([...creators, ...syncCreators]);
    const stale = Object.keys(UNDO_POLICY).filter((name) => !known.has(name));
    expect(stale).toEqual([]);
  });

  test("every never entry gives a reason", () => {
    const bare = Object.entries(UNDO_POLICY)
      .filter(([, entry]) => "never" in entry && !entry.never.trim())
      .map(([name]) => name);
    expect(bare).toEqual([]);
  });

  test("the engine receives exactly the spec entries", () => {
    const withSpecs = Object.entries(UNDO_POLICY)
      .filter(([, entry]) => "spec" in entry)
      .map(([name]) => name)
      .sort();
    expect(Object.keys(UNDO_SPECS).sort()).toEqual(withSpecs);
  });
});
