import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { codeLines, walkSources, MOBILE_ROOT } from "./sourceWalk";
import { join } from "node:path";
import { COLLECTION_STORE_KEYS, DATA_SCOPE, SCOPED_READ_KEYS, WORKSPACE_SCOPED_KEYS } from "../../store/clientSyncRegistry";

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
  ["lib/universalSearch.ts", "builds the search index; matchEntities passes every row through inActiveWorkspace before anything renders"],
  ["lib/taskRef.ts", "id/short_id LOOKUP of the one task a ref names"],
  ["lib/recentVisits.ts", "id LOOKUP to render a title for an already-visited row"],
  ["components/CommandPalette.tsx", "id LOOKUP + parent picker scoped to the target's own workspace"],
  ["app/tasks/[id]/page.tsx", "short_id LOOKUP of the one task the address names"],
  ["components/tasks/SubtasksSection.tsx", "subtree of one already-authorized task (its subtasks share its workspace)"],
  ["store/undo/writers.ts", "id/short_id LOOKUP to name a task in an undo write the server re-authorizes"],
  ["store/opsSlice.ts", "the slice that owns opsGroups, dropping a removed source's rows"],
  ["store/taskGraphDraft.ts", "short_id LOOKUP: a graph write patches every copy of the one task it names; renders nothing"],
  ["store/initiativeSlice.ts", "the slice that owns goals, moving a stub project id to its real id in every goal that lists it; renders nothing"],
  ["app/projects/[id]/page.tsx", "short id LOOKUP of the one project the address names (pj-…)"],
  ["hooks/useLineWorkspace.ts", "short id / slug LOOKUP of the one project a /line address names, settling a shared slug on the active workspace"],
  ["hooks/useLineSpace.ts", "counts problems per workspace the viewer belongs to (the /line workspace switcher's choices and numbers) and a short_id LOOKUP of the one problem a /line link names; renders no row"],
  ["store/lineWorkflowSlice.ts", "slug LOOKUP of the viewer's own workflow for a write the server re-authorizes; renders nothing"],
  ["store/lineSlice.ts", "the slice that owns lineLabels, finding the viewer's own label by its natural key for a write the server re-authorizes; renders nothing"],
  ["store/orgLens.ts", "project id to goal LOOKUP, read only for the projects of sessions already on screen; renders no goal row"],
  ["store/trialSlice.ts", "the slice that owns trialCards, marking the cards of the one problem a write names; renders nothing"],
  ["components/consequential/lineStart.tsx", "the problems of one project (they share its workspace), with a short_id LOOKUP of their goals' priority"],
  ["components/org/orgSessionDetail.ts", "a role's own area: projects it leads (owner_role_id) and tasks under its scope's projects and plans, which share its workspace"],
  ["hooks/useFixCommitChecks.ts", "the findings filed under one already-authorized problem (they share its workspace)"],
  ["components/org/OrgPanel.tsx", "short_id LOOKUP of the one proposal an address names"],
  ["components/org/ProposalAuthorPill.tsx", "short_id LOOKUP of the one proposal a pill names"],
  ["components/org/OrgChart.tsx", "short_id LOOKUP of the one proposal an address names"],
  ["hooks/useSessionShipState.ts", "runs indexed by the session they ship, read per session already on screen (deploys go through workspaceRows)"],
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

// SCOPED SLOTS AND TEAM COLLECTIONS (clientSyncRegistry.scope.ts DATA_SCOPE).
//
// A key classed "workspace" or "team" holds one workspace's or one team's
// data in a cache that spans them all. Three shapes of read bypass the check
// that makes that safe, and each is caught here:
//   1. a singleton/list slot read raw (`s.orgTree`, `s.teamMembers`): read it
//      through its named selector (windowOrgTree, windowOrgHealth,
//      teamMembersOf, teamInboxIdsOf), which returns nothing for another
//      workspace's copy;
//   2. a workspace or team collection enumerated through useCollectionRows,
//      which applies no workspace rule: use useWorkspaceCollection, or a
//      `where` that names the team or the one entity on the same line;
//   3. a TEAM collection enumerated with Object.values: filter by team_id on
//      the same line, or go through the slice that owns it.
// An id LOOKUP (`s.tasks[id]`) is not enumeration and stays legal: the row a
// caller already holds an id for was admitted by its own surface.

const SLOT_KEYS = SCOPED_READ_KEYS.filter((k) => !(COLLECTION_STORE_KEYS as readonly string[]).includes(k));
const TEAM_COLLECTIONS = (COLLECTION_STORE_KEYS as readonly string[]).filter((k) => (DATA_SCOPE as Record<string, string>)[k] === "team");
const SCOPED_COLLECTIONS = [...WORKSPACE_SCOPED_KEYS, ...TEAM_COLLECTIONS];

// Where a raw slot read is the selector, the slot's owner, or a write.
const SLOT_ALLOWED = new Map<string, string>([
  ["store/orgSlice.ts", "owns orgTree: windowOrgTree itself, the feed's normalize and the optimistic intents"],
  ["store/inboxStore.ts", "the store: slot types, initial values, sync opts, teamInboxIdsOf itself, and writes"],
  ["store/initiativeSlice.ts", "paints an owner's scope gain as an intent on the held tree; renders nothing"],
  ["store/undo/policies/work.ts", "names a role by id in an undo label and snapshots the org slots it restores; renders no list"],
  ["store/syncReplication.ts", "replicates the slots between windows; renders nothing"],
  ["lib/activeTeam.ts", "teamMembersOf itself"],
  ["lib/roleRows.ts", "a role's face by id: viewerRoles spans every workspace by design, the tree is its cold-cache fallback"],
  ["lib/liveEntities.ts", "a role pill by id LOOKUP"],
  ["lib/roleRecipients.ts", "the standing conversation of one role by id LOOKUP, for a send the server re-authorizes"],
  ["lib/tabTitle.ts", "a tab's title for an id it already holds (id LOOKUP)"],
  ["hooks/useSyncOrgHealth.ts", "windowOrgHealth itself and the feeder's write"],
  ["hooks/useSyncTeamInboxSessions.ts", "the feeder: writes the set and clears it on a team switch"],
  ["hooks/inboxWarm.ts", "change detection on the slot's identity; the roles it warms are read through windowOrgTree"],
  ["components/org/RoleFace.tsx", "checks the held tree's own workspace stamp against the face's before reading a role"],
  ["store/orgLens.ts", "lensTreeOf hands the slot to windowOrgTree"],
]);

const SLOT_READ = new RegExp(
  String.raw`(?:\b(?:s|st|state|draft|this|store\(\)|getState\(\)|\(s as any\)|\(st as any\))|\))\??\.(` + SLOT_KEYS.join("|") + String.raw`)\b(?!\s*=[^=])`,
);
// A line that reads the held tree's own workspace stamp is itself the check.
const STAMP_CHECK = /orgTree\?\.workspace/;

const ROWS_READ = new RegExp(String.raw`useCollectionRows(?:<[^(]*>)?\(\s*"(` + SCOPED_COLLECTIONS.join("|") + String.raw`)"`);
// Enumerations through useCollectionRows whose `where` is anchored on one
// entity or team (read in the file), so they never list a workspace.
const ROWS_ALLOWED = new Map<string, string>([
  ["hooks/useSyncWorkflows.ts", "the viewer's own workflows, one workflow's runs, one run by id, one conversation's flow runs"],
  ["components/line/widgets/LineFence.tsx", "the runs on one already-resolved task"],
  ["components/line/workspace/views/problem/AskBlock.tsx", "the signals of one problem"],
  ["components/line/workspace/views/problem/ProblemPage.tsx", "the signals of one problem"],
  ["components/line/widgets/WaitingItem.tsx", "the signals and deploys of one problem"],
  ["components/line/widgets/OriginTrail.tsx", "the signals of one problem"],
  ["components/line/widgets/TrialFactOpen.tsx", "the signals of one trial fact"],
  ["components/line/workspace/views/finder/FindTable.tsx", "marks LOOKUP by run:node:user key for findings already on screen"],
  ["hooks/useFixCommitChecks.ts", "the findings filed under one already-authorized problem (they share its workspace)"],
  ["components/ops/opsShellHooks.ts", "short_id LOOKUP of the one issue, replay, watch or source an address names"],
  ["components/org/scope/RoleOffer.tsx", "where: inWorkspace"],
  ["components/repo/RepositoryLinks.tsx", "the events of one repository"],
  ["hooks/useSyncPrompts.ts", "where names the team"],
  ["hooks/useSyncChanges.ts", "every where names the team"],
  ["hooks/useSyncExternalEvents.ts", "useExternalEvents: the reader; each caller's where names its entity or the active team"],
]);

// Object.values over a TEAM collection: the files that filter by team or
// look one row up, each read here.
const TEAM_ENUM_ALLOWED = new Map<string, string>([
  ["store/chatSlice.ts", "owns the chat collections and scopes by channel"],
  ["components/chat/SlackChannelBrowser.tsx", "keys links by Slack id for lookup, and filters channels by team_id"],
  ["components/integrations/SlackMirrorsSummary.tsx", "filters links by the active team; channels only counted"],
  ["components/changes/ChangesPage.tsx", "story_key LOOKUP of the one story a link names"],
  ["lib/mentionContext.ts", "the lines of the one channel the draft key names"],
  ["hooks/useMentionQuery.ts", "filters channels and Slack people by the scope's team on the next line"],
]);
const TEAM_ENUM = new RegExp(
  String.raw`Object\.(values|keys|entries)\(\s*[A-Za-z_.()\[\]"']*\b(` + TEAM_COLLECTIONS.join("|") + String.raw`)\b`,
);

function offenders(roots: Array<[string, string[]]>, token: RegExp, allowed: Map<string, string>, lineOk: (line: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const [root, dirs] of roots) {
    for (const dir of dirs) {
      for (const file of walk(join(root, dir))) {
        const rel = file.slice(root.length + 1);
        if ((root === ROOT && allowed.has(rel)) || rel.includes("__fixtures__")) continue;
        for (const { line, n } of codeLines(readFileSync(file, "utf8"))) {
          if (token.test(line) && !lineOk(line)) out.push(`${root === ROOT ? "" : "mobile/"}${rel}:${n}: ${line.trim().slice(0, 120)}`);
        }
      }
    }
  }
  return out;
}

const ROOTS: Array<[string, string[]]> = [[ROOT, DIRS], [MOBILE_ROOT, ["app", "components", "hooks", "lib"]]];

describe("scoped slots read only through their selectors", () => {
  test("every workspace/team slot that is not a collection is listed", () => {
    expect(SLOT_KEYS.sort()).toEqual(["orgHealth", "orgTree", "teamInboxIdSnapshot", "teamInboxIds", "teamMembers"]);
  });

  test("no raw read of a workspace/team slot outside its selector", () => {
    expect(offenders(ROOTS, SLOT_READ, SLOT_ALLOWED, (l) => STAMP_CHECK.test(l))).toEqual([]);
  }, 120_000);

  test("no useCollectionRows enumeration of a workspace/team collection outside an anchored reader", () => {
    expect(offenders(ROOTS, ROWS_READ, ROWS_ALLOWED)).toEqual([]);
  }, 120_000);

  test("no Object.values over a team collection without its team on the line", () => {
    expect(offenders(ROOTS, TEAM_ENUM, TEAM_ENUM_ALLOWED, (l) => /team_id|teamId/.test(l))).toEqual([]);
  }, 120_000);

  test("every scoped allowlist entry still exists", () => {
    for (const rel of [...SLOT_ALLOWED.keys(), ...ROWS_ALLOWED.keys(), ...TEAM_ENUM_ALLOWED.keys()]) {
      expect(() => statSync(join(ROOT, rel)), `${rel} is allowlisted but missing`).not.toThrow();
    }
  });
});
