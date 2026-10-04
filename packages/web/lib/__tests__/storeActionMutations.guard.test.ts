import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UNDO_POLICY } from "../../store/undo/policy";

// A gesture that writes synced data through a Convex mutation of its own, past
// the store action that owns the same write, is invisible to undo (nothing is
// recorded, so Cmd+Z takes back an older entry instead) and to local-first
// (nothing paints until the server echoes). The undo policy guard cannot see
// it, because no store creator runs.
//
// The store action's server half is its named side effect in
// convex/dispatch.ts, which runs the real mutation. So the mutations a
// classified action owns are read from its handler there, and no surface may
// call one of them itself: it calls the store action instead.

const WEB = join(import.meta.dir, "..", "..");
const DISPATCH = readFileSync(join(WEB, "..", "convex", "convex", "dispatch.ts"), "utf8");

// `api.mod.fn`, `api.dir.mod.fn`, `(api as any).mod.fn`, and an `_api` alias.
const API_REF = /(?:^|[^\w$.])_?api(?:\s+as\s+any\))?\.((?:\w+\.)*\w+)/g;

const withoutComments = (src: string) =>
  src
    .split("\n")
    .map((line) => (/^\s*(\*|\/\*)/.test(line) ? "" : line.replace(/\s\/\/.*$/, "").replace(/^\s*\/\/.*$/, "")))
    .join("\n");

/** Each dispatch handler's body, by the action name it serves. */
function dispatchHandlers(): Map<string, string> {
  const handlers = new Map<string, string>();
  let name: string | null = null;
  let body: string[] = [];
  for (const line of withoutComments(DISPATCH).split("\n")) {
    const start = /^ {2}(\w+): async\b/.exec(line);
    if (start || /^\};?\s*$/.test(line)) {
      if (name) handlers.set(name, body.join("\n"));
      name = start ? start[1]! : null;
      body = [];
    }
    if (name) body.push(line);
  }
  return handlers;
}

/** mutation path → the classified store actions whose side effect runs it. */
function ownedMutations(): Map<string, string[]> {
  const owned = new Map<string, string[]>();
  for (const [action, body] of dispatchHandlers()) {
    if (!(action in UNDO_POLICY)) continue;
    for (const m of body.matchAll(API_REF)) {
      const path = m[1]!;
      if (!(owned.get(path) ?? []).includes(action)) owned.set(path, [...(owned.get(path) ?? []), action]);
    }
  }
  return owned;
}

// A surface that calls an owned mutation for a write the store action does
// not make. Keyed by file and mutation, so a new caller still fails.
const NOT_THE_ACTIONS_WRITE: Record<string, string> = {
  "app/settings/sync/page.tsx users.updateSyncSettings":
    "writes sync_mode and the project lists; setCloudSessionSync writes only the cloud session fields through the same mutation",
  "app/settings/migrate/page.tsx sessionMigrations.cancelBatch":
    "cancels a cast migrate batch; a resource offload batch cancels through cancelResourceOffload in the same handler",
  "hooks/useResourceActions.ts resourceOffload.start":
    "the preflight's dry run writes nothing; the real start goes through startResourceOffload",
};

describe("surfaces write through the store action that owns the write", () => {
  const owned = ownedMutations();

  test("the dispatch handlers name the mutations their actions own", () => {
    expect(owned.get("agentTasks.webUpdate")).toContain("setTriggerInterval");
    expect(owned.get("agentTasks.webReactivate")).toContain("triggerAction");
    expect(owned.size).toBeGreaterThan(30);
  });

  test("no component, page, hook or lib calls a mutation a classified store action owns", () => {
    const hits: string[] = [];
    const seenAllowed = new Set<string>();
    for (const dir of ["app", "components", "hooks", "lib"]) {
      for (const f of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: join(WEB, dir) })) {
        if (/(^|\/)__tests__\/|\.test\.tsx?$|(^|\/)__fixtures__\//.test(f)) continue;
        const rel = `${dir}/${f}`;
        withoutComments(readFileSync(join(WEB, rel), "utf8")).split("\n").forEach((line, i) => {
          for (const m of line.matchAll(API_REF)) {
            const actions = owned.get(m[1]!);
            if (!actions) continue;
            const key = `${rel} ${m[1]}`;
            if (key in NOT_THE_ACTIONS_WRITE) { seenAllowed.add(key); continue; }
            hits.push(`${rel}:${i + 1} calls ${m[1]}; use the store action ${actions.join(" or ")}`);
          }
        });
      }
    }
    expect(hits).toEqual([]);
    // An exception whose call is gone is stale.
    expect(Object.keys(NOT_THE_ACTIONS_WRITE).filter((k) => !seenAllowed.has(k))).toEqual([]);
  }, 60_000);
});
