import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkRatchet, codeOnly } from "@codecast/shared/ratchet";
import { UNDO_POLICY } from "../../store/undo/policy";
import { CLIENT_SYNC_REGISTRY, SYNCED_WRITER_MODULES } from "../../store/clientSyncRegistry";

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
/** Files that call a synced module's mutation no store action owns. May only
 *  fall. Pinned at 54 when the rule widened to bespoke-fed keys (`writtenBy`)
 *  and to Convex client calls, with the team, org, PR and palette gestures it
 *  first caught moved onto store actions. */
const PIN_DIRECT_SYNCED_WRITES = 54;
const CONVEX = join(WEB, "..", "convex", "convex");
const DISPATCH = readFileSync(join(CONVEX, "dispatch.ts"), "utf8");

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

// A server helper a handler runs as its write: `await helper(ctx, ...)` or
// `return helper(ctx, ...)`. Auth and read helpers are not the write.
const WRITE_HELPER = /\b(?:await|return)\s+([a-z]\w*)\(\s*ctx\b/g;
const NOT_A_WRITE = /^(require|get|is|assert|load|resolve|find|can|check|ensure|read|lookup|list|fetch|verify|authorize)/;
const writeHelpersOf = (body: string) =>
  [...body.matchAll(WRITE_HELPER)].map((m) => m[1]!).filter((name) => !NOT_A_WRITE.test(name));

/** Each public mutation's handler body in the Convex tree, by its api path. */
function publicMutations(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of new Bun.Glob("**/*.ts").scanSync({ cwd: CONVEX })) {
    // dispatch.ts is the rail every store action rides, not a gesture's write.
    if (/\.test\.ts$|(^|\/)_generated\/|^dispatch\.ts$/.test(f)) continue;
    const mod = f.replace(/\.ts$/, "").split("/").join(".");
    const src = withoutComments(readFileSync(join(CONVEX, f), "utf8"));
    const starts = [...src.matchAll(/^export const (\w+) = mutation\(/gm)];
    for (const m of starts) {
      const end = src.slice(m.index! + 1).search(/^export /m);
      const body = end === -1 ? src.slice(m.index!) : src.slice(m.index!, m.index! + 1 + end);
      out.set(`${mod}.${m[1]}`, body);
    }
  }
  return out;
}

/** mutation path → the classified store actions whose side effect runs it,
 *  by name or by running the same server helper as the action's handler. */
function ownedMutations(): Map<string, string[]> {
  const owned = new Map<string, string[]>();
  const own = (path: string, action: string) => {
    if (!(owned.get(path) ?? []).includes(action)) owned.set(path, [...(owned.get(path) ?? []), action]);
  };
  const helperActions = new Map<string, string[]>();
  for (const [action, body] of dispatchHandlers()) {
    if (!(action in UNDO_POLICY)) continue;
    for (const m of body.matchAll(API_REF)) own(m[1]!, action);
    for (const helper of writeHelpersOf(body)) helperActions.set(helper, [...(helperActions.get(helper) ?? []), action]);
  }
  for (const [path, body] of publicMutations()) {
    for (const helper of writeHelpersOf(body)) for (const action of helperActions.get(helper) ?? []) own(path, action);
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
  "components/org/OrgPage.tsx orgRoles.reset":
    "the reset preview's dry run writes nothing; the real reset goes through resetOrg",
  "hooks/useResourceActions.ts resourceOffload.start":
    "the preflight's dry run writes nothing; the real start goes through startResourceOffload",
};

describe("surfaces write through the store action that owns the write", () => {
  const owned = ownedMutations();

  test("the dispatch handlers name the mutations their actions own", () => {
    expect(owned.get("agentTasks.webUpdate")).toContain("setTriggerInterval");
    expect(owned.get("agentTasks.webReactivate")).toContain("triggerAction");
    // A public mutation running the same server helper as a handler is owned too.
    expect(owned.get("teams.setTeamVisibility")).toContain("setTeamMembershipVisibility");
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

// The wider class: a gesture on a synced collection with no store action at
// all. The test above sees only mutations a classified action already owns,
// so a surface that writes the rows a store feed paints through a mutation no
// action runs (resolving a code review thread did) is invisible to it and to
// the undo policy guard alike. A mutation in the same Convex module as a
// registered feed, or in a module the registry names as a key's writer
// (`writtenBy`), is taken to write that key's rows. The files that still
// call one directly are listed with their count, and the list may only
// shrink: the fix is a store action (a draft write plus a named dispatch side
// effect, classified in store/undo/policy.ts), never a new entry.
const SYNCED_MODULES = new Set(Object.keys(SYNCED_WRITER_MODULES));
// A hook (`useMutation(api.x.y)`) or a Convex client call (`convex.mutation(api.x.y, ...)`).
const MUTATION_REF = /(?:useMutation|\.mutation)\(\s*\(?_?api(?:\s+as\s+any\))?\.((?:\w+\.)*\w+)/g;
const ownedByAction = ownedMutations();

const directSyncedWrites = checkRatchet({
  name: "direct mutation of a synced collection's module, owned by no store action",
  root: WEB,
  dirs: ["app", "components", "hooks", "lib"],
  ignoreDirs: ["__tests__", "__fixtures__"],
  exempt: (rel) => /\.test\.tsx?$/.test(rel),
  count: (src) =>
    [...codeOnly(src).matchAll(MUTATION_REF)].filter((m) => {
      const path = m[1]!;
      return SYNCED_MODULES.has(path.split(".").slice(0, -1).join(".")) && !ownedByAction.has(path);
    }).length,
  allowlist: join(import.meta.dir, "storeActionMutations.allowlist.txt"),
  pin: PIN_DIRECT_SYNCED_WRITES,
  fix: "Add a store action for the gesture (draft write + named dispatch side effect in convex/dispatch.ts), classify it in store/undo/policy.ts, and call it.",
  pruneCommand: "cd packages/web && RATCHET_WRITE=prune bun test lib/__tests__/storeActionMutations.guard.test.ts",
  minScanned: 400,
});

describe("gestures on synced collections go through a store action", () => {
  // A key fed by a bespoke hook registers no feeds, and a module beside a
  // feed's own can write its rows: every server mirror says who writes it.
  test("every localFirst key names the modules that write its rows", () => {
    const silent = Object.entries(CLIENT_SYNC_REGISTRY)
      .filter(([, e]: [string, any]) => e.localFirst && !e.feeds?.length && !e.writtenBy?.length)
      .map(([k]) => k);
    expect(silent).toEqual([]);
  });

  test("the registry names synced modules, and the code review thread verbs are owned", () => {
    expect(SYNCED_MODULES.has("codeComments")).toBe(true);
    for (const m of ["teams", "tasks", "docs", "orgSplit", "orgHandoff", "orgLineMerge", "orgRoles", "orgTemplates", "prShepherd"]) {
      expect(SYNCED_MODULES.has(m)).toBe(true);
    }
    for (const m of ["codeComments.resolve", "codeComments.unresolve", "codeComments.update", "codeComments.remove"]) {
      expect(ownedByAction.has(m)).toBe(true);
    }
  });

  test("no new surface writes a synced collection's rows past the store", () => {
    expect(directSyncedWrites.problems).toEqual([]);
  }, 120_000);
});
