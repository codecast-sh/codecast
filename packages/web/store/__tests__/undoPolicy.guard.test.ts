import { describe, expect, test } from "bun:test";
import { actionKind } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { UNDO_POLICY, UNDO_POLICY_FILES, UNDO_SPECS } from "../undo/policy";

// Every creator a gesture can call has an undo decision, written down once:
// a spec, or the reason it is never undoable. A new action that nobody
// classified fails here, which is how the same verb stays undoable from every
// surface that calls it. sync() creators are local bookkeeping and never
// record, so they need no entry.
const creators = Object.entries(useInboxStore.getState() as unknown as Record<string, unknown>)
  .filter(([, fn]) => {
    const kind = actionKind(fn);
    return kind !== null && kind !== "sync";
  })
  .map(([name]) => name)
  .sort();

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

  test("no policy entry names a creator that does not exist", () => {
    const known = new Set(creators);
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
