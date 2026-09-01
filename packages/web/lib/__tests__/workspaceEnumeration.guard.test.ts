import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { walkSources } from "./sourceWalk";
import { join } from "node:path";
import { WORKSPACE_SCOPED_KEYS } from "../../store/clientSyncRegistry";

// THE CLIENT CHOKEPOINT.
//
// A convention nobody can violate by accident beats one that is merely
// documented. `store.tasks` / `.plans` / `.docs` / `.projects` cache rows from
// EVERY workspace the user has viewed (sync never prunes on team switch, IDB
// persists them across reloads), so a raw `Object.values(s.tasks)` in a view
// renders another team's rows the moment the active team changes. Ten surfaces
// had exactly that bug.
//
// So: enumerate a scoped collection through `useWorkspaceCollection` (or the
// shared predicate in lib/workspaceScope) and nowhere else. This test walks the
// app/component/hook sources and fails on any other enumeration.
//
// If this test fails on new code, the fix is to use the hook — not to widen the
// allowlist. The allowlist below is for the two legitimate non-enumeration
// shapes only: an id/short_id LOOKUP (resolving a row you already have an id
// for, which the server re-checks on write) and the scope machinery itself.

const ROOT = join(import.meta.dir, "..", "..");
const DIRS = ["app", "components", "hooks", "lib", "store"];
// Derived from the registry: a collection declares `workspaceScoped: true`
// and this guard covers it — no second list to keep in step.
const SCOPED = WORKSPACE_SCOPED_KEYS;

// Files that legitimately touch the raw collections. Each needs a REASON, and
// none of them renders a workspace-scoped LIST.
const ALLOWED = new Map<string, string>([
  ["hooks/useWorkspaceCollection.ts", "the sanctioned reader itself"],
  ["lib/workspaceScope.ts", "the predicate itself"],
  ["store/inboxStore.ts", "the store defines the collections"],
  ["store/chatSlice.ts", "chat rows, scoped by its own channel rules"],
  ["lib/liveEntities.ts", "merges a server snapshot with live rows, no enumeration by workspace"],
  ["lib/taskActions.ts", "short_id LOOKUP for a write the server re-authorizes"],
  ["lib/recentVisits.ts", "id LOOKUP to render a title for an already-visited row"],
  ["components/CommandPalette.tsx", "id LOOKUP + parent picker scoped to the target's own workspace"],
  ["app/tasks/[id]/page.tsx", "id LOOKUP + subtree of one already-authorized task"],
]);

const walk = (dir: string) => walkSources(dir);

// `Object.values(<something>tasks)` / .keys / .entries, however the collection
// is spelled at the call site (s.tasks, state.docs, allTasks, plans).
const ENUM = new RegExp(
  String.raw`Object\.(values|keys|entries)\(\s*[A-Za-z_.()\[\]"']*\b(` +
    SCOPED.join("|") +
    String.raw`|all(?:Tasks|Docs|Plans|Projects))\b`,
  "g",
);

describe("workspace enumeration chokepoint", () => {
  test("no view enumerates a workspace-scoped store collection directly", () => {
    const offenders: string[] = [];
    for (const dir of DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = file.slice(ROOT.length + 1);
        if (ALLOWED.has(rel)) continue;
        const src = readFileSync(file, "utf8");
        for (const line of src.split("\n")) {
          ENUM.lastIndex = 0;
          if (!ENUM.test(line)) continue;
          // Wrapped in the shared predicate on the same line is still correct.
          if (/filterToWorkspace|filterByWorkspace|inActiveWorkspace|inWorkspace/.test(line)) continue;
          offenders.push(`${rel}: ${line.trim().slice(0, 100)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every allowlist entry still exists — a stale exemption is a silent hole", () => {
    for (const rel of ALLOWED.keys()) {
      expect(() => statSync(join(ROOT, rel)), `${rel} is allowlisted but missing`).not.toThrow();
    }
  }, 120_000); // IO-bound source walk; the box is often under heavy test load
});
