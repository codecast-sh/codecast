import { describe, expect, test } from "bun:test";
import { DATA_SCOPE, SCOPED_READ_KEYS, WORKSPACE_SCOPED_KEYS, COLLECTION_STORE_KEYS } from "../clientSyncRegistry";
import { membershipSig, workspaceRows } from "../../hooks/useWorkspaceCollection";
import { activeWorkspaceKeyOf } from "../../lib/workspaceScope";
import { windowOrgTree } from "../orgSlice";
import { windowOrgHealth } from "../../hooks/useSyncOrgHealth";
import { teamMembersOf } from "../../lib/activeTeam";
import { teamInboxIdsOf } from "../inboxStore";

// TWO WORKSPACES, ONE CACHE. The store holds rows of every workspace the
// viewer has opened. Seed each workspace- or team-scoped key with rows of
// team A and team B, make B active, and fail when a registered reader hands
// back any of A's.

const ME = "user_me";
const A = "team_a";
const B = "team_b";
const stateIn = (team: string | null, extra: Record<string, unknown> = {}) => ({
  clientState: { ui: { active_team_id: team } },
  currentUser: { _id: ME },
  orgScope: null,
  ...extra,
});

const row = (id: string, team: string) => ({ _id: id, workspace: `team:${team}`, team_id: team, updated_at: 1, timestamp: 1, created_at: 1 });

describe("workspace collections read through the chokepoint", () => {
  for (const key of WORKSPACE_SCOPED_KEYS) {
    test(`${key}: only the active workspace's rows`, () => {
      const coll = { a1: row("a1", A), a2: row("a2", A), b1: row("b1", B) };
      const active = activeWorkspaceKeyOf(stateIn(B));
      expect(workspaceRows(key, coll, active).map((r: any) => r._id)).toEqual(["b1"]);
      expect(workspaceRows(key, coll, activeWorkspaceKeyOf(stateIn(null)))).toEqual([]);
      // The wake signature changes when A's rows change, never counts them for B.
      expect(membershipSig(coll, active, null, key).startsWith("1.")).toBe(true);
    });
  }
});

describe("workspace and team slots read through their selectors", () => {
  test("orgTree: another workspace's tree reads as none", () => {
    const tree = { workspace: { kind: "team", id: A }, roles: [{ _id: "r1" }], people: [], anchors: [] };
    expect(windowOrgTree(stateIn(B, { orgTree: tree }) as any)).toBeNull();
    expect(windowOrgTree(stateIn(null, { orgTree: tree }) as any)).toBeNull();
    expect(windowOrgTree(stateIn(A, { orgTree: tree }) as any)).toBe(tree);
  });

  test("orgHealth: a snapshot held for another workspace reads as none", () => {
    const health = { held_for: `ws:${A}`, flags: [] } as any;
    expect(windowOrgHealth({ orgHealth: health }, `ws:${B}`)).toBeNull();
    expect(windowOrgHealth({ orgHealth: health }, "ws:personal")).toBeNull();
    expect(windowOrgHealth({ orgHealth: health }, `ws:${A}`)).toBe(health);
  });

  test("teamMembers: another team's roster reads empty", () => {
    const roster = [{ _id: "u1", roster_team: A }, { _id: "u2", roster_team: A }];
    expect(teamMembersOf(stateIn(B, { teamMembers: roster }))).toEqual([]);
    expect(teamMembersOf(stateIn(null, { teamMembers: roster }))).toEqual([]);
    expect(teamMembersOf(stateIn(A, { teamMembers: roster }))).toBe(roster);
  });

  test("teamInboxIds: another team's board reads empty", () => {
    const ids = new Set(["c1"]);
    const snap = { team_id: A, ids: ["c1"] };
    expect(teamInboxIdsOf(stateIn(B, { teamInboxIds: ids, teamInboxIdSnapshot: snap }) as any).size).toBe(0);
    expect(teamInboxIdsOf(stateIn(null, { teamInboxIds: ids, teamInboxIdSnapshot: snap }) as any).size).toBe(0);
    expect(teamInboxIdsOf(stateIn(A, { teamInboxIds: ids, teamInboxIdSnapshot: snap }) as any)).toBe(ids);
  });

  // A new workspace/team slot must get a selector and a case above.
  test("every scoped slot has a case here", () => {
    const slots = SCOPED_READ_KEYS.filter((k) => !(COLLECTION_STORE_KEYS as readonly string[]).includes(k)).sort();
    expect(slots).toEqual(["orgHealth", "orgTree", "teamInboxIdSnapshot", "teamInboxIds", "teamMembers"]);
  });

  test("every workspace collection is in the chokepoint's set", () => {
    const ws = (COLLECTION_STORE_KEYS as readonly string[]).filter((k) => (DATA_SCOPE as Record<string, string>)[k] === "workspace").sort();
    expect([...WORKSPACE_SCOPED_KEYS].sort()).toEqual(ws);
    expect(WORKSPACE_SCOPED_KEYS).toContain("workflowRuns");
  });
});
