import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFakeDb } from "../testDb";
import {
  workspaceKey,
  parseWorkspaceKey,
  computeWorkspaceKey,
  workspaceGrantsAccess,
  canAccessTask,
  canAccessDoc,
  canAccessPlan,
  canAccessProject,
  recomputeWorkspaceForConversation,
  patchConversationVisibility,
  linkedConversationId,
} from "./access";
import { createDataContext, scopedFetch } from "../data";

// The workspace key is the ACCESS axis, stored on every work item and
// independent of team_id (ROUTING). These tests pin the two invariants the
// human locked as product requirements:
//   1. Access reads `workspace` and NOTHING else. A row with team_id=T and
//      workspace=user:X is invisible to every other member of T.
//   2. `workspace` is not a projection of team_id — the two diverge, and the
//      divergence is exactly "routed to the team, readable by the owner".
// Plus the subtle part: propagation. The stored key must follow a linked
// conversation through every visibility transition, and the reconciler must
// agree with the write-time compute.

const OWNER = "u_owner";
const MATE = "u_mate";
const OUTSIDER = "u_outsider";
const TEAM = "t_team";
const OTHER_TEAM = "t_other";

function fixture(rows: Record<string, any[]> = {}) {
  return makeFakeDb({
    users: [{ _id: OWNER }, { _id: MATE }, { _id: OUTSIDER }],
    // Both teams are LIVE. Access rules read a team row before they treat a
    // team reference as a boundary (a deleted team is dangling data, not a
    // denial), and this fake db answers get() by scanning the seeded tables —
    // so an unseeded `teams` would make every team here look deleted.
    teams: [{ _id: TEAM }, { _id: OTHER_TEAM }],
    team_memberships: [
      { _id: "m1", user_id: OWNER, team_id: TEAM, role: "member", visibility: "full" },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", visibility: "full" },
    ],
    directory_team_mappings: [],
    conversations: [],
    tasks: [],
    plans: [],
    docs: [],
    projects: [],
    ...rows,
  });
}

describe("workspace key — shape", () => {
  test("one constructor, one parser, round-trips both variants", () => {
    expect(workspaceKey({ type: "team", teamId: TEAM as any })).toBe("team:t_team");
    expect(workspaceKey({ type: "personal", userId: OWNER as any })).toBe("user:u_owner");
    expect(parseWorkspaceKey("team:t_team")).toEqual({ type: "team", teamId: TEAM as any });
    expect(parseWorkspaceKey("user:u_owner")).toEqual({ type: "personal", userId: OWNER as any });
  });

  test("unknown variants and absence parse to null — every reader fails closed", () => {
    expect(parseWorkspaceKey(undefined)).toBeNull();
    expect(parseWorkspaceKey("")).toBeNull();
    expect(parseWorkspaceKey("restricted:abc")).toBeNull();
    expect(parseWorkspaceKey("t_team")).toBeNull();
  });

  test("workspaceGrantsAccess: personal matches only that user, team requires membership, unknown grants nothing", async () => {
    const db = fixture();
    const ctx = { db } as any;
    expect(await workspaceGrantsAccess(ctx, OWNER as any, "user:u_owner")).toBe(true);
    expect(await workspaceGrantsAccess(ctx, MATE as any, "user:u_owner")).toBe(false);
    expect(await workspaceGrantsAccess(ctx, MATE as any, "team:t_team")).toBe(true);
    expect(await workspaceGrantsAccess(ctx, OUTSIDER as any, "team:t_team")).toBe(false);
    expect(await workspaceGrantsAccess(ctx, MATE as any, "restricted:x")).toBe(false);
    expect(await workspaceGrantsAccess(ctx, MATE as any, undefined)).toBe(false);
  });
});

describe("computeWorkspaceKey — write-time rules", () => {
  test("no link: raw team tag → team key, no tag → personal to the ROW OWNER", () => {
    expect(computeWorkspaceKey({ user_id: OWNER as any, team_id: TEAM as any }, null)).toBe("team:t_team");
    expect(computeWorkspaceKey({ user_id: OWNER as any }, null)).toBe("user:u_owner");
  });

  test("linked conversation decides: team-visible → its team, private → personal to the row owner", () => {
    const shared = { team_id: TEAM as any, is_private: false };
    const priv = { team_id: TEAM as any, is_private: true };
    const revealed = { team_id: TEAM as any, is_private: true, team_visibility: "summary" };
    const teamless = { is_private: false };
    const row = { user_id: OWNER as any, team_id: TEAM as any };
    expect(computeWorkspaceKey(row, shared)).toBe("team:t_team");
    expect(computeWorkspaceKey(row, priv)).toBe("user:u_owner");
    expect(computeWorkspaceKey(row, revealed)).toBe("team:t_team");
    expect(computeWorkspaceKey(row, teamless)).toBe("user:u_owner");
  });

  test("plans link via created_from_conversation_id — the spelling the old rule missed", () => {
    expect(linkedConversationId({ created_from_conversation_id: "c1" })).toBe("c1");
    expect(linkedConversationId({ created_from_conversation: "c2" })).toBe("c2");
    expect(linkedConversationId({ conversation_id: "c3" })).toBe("c3");
    expect(linkedConversationId({ conversation_ids: ["c4"] })).toBe("c4");
    expect(linkedConversationId({})).toBeUndefined();
  });
});

describe("INVARIANT 1 — access reads workspace, never team_id", () => {
  const privateInTeam = (extra: any = {}) => ({
    _id: "row1", user_id: OWNER, team_id: TEAM, workspace: "user:u_owner", ...extra,
  });

  test("team_id=T + workspace=user:owner is readable by the owner only — a fellow member of T is refused", async () => {
    const db = fixture();
    const ctx = { db } as any;
    for (const check of [canAccessTask, canAccessDoc, canAccessPlan, canAccessProject]) {
      expect(await check(ctx, OWNER as any, privateInTeam() as any)).toBe(true);
      expect(await check(ctx, MATE as any, privateInTeam() as any)).toBe(false);
      expect(await check(ctx, OUTSIDER as any, privateInTeam() as any)).toBe(false);
    }
  });

  test("workspace=team:T with NO team_id is still readable by members of T (routing absent, access present)", async () => {
    const db = fixture();
    const ctx = { db } as any;
    const row = { _id: "row2", user_id: OWNER, workspace: "team:t_team" };
    expect(await canAccessTask(ctx, MATE as any, row as any)).toBe(true);
    expect(await canAccessDoc(ctx, MATE as any, row as any)).toBe(true);
    expect(await canAccessTask(ctx, OUTSIDER as any, row as any)).toBe(false);
  });

  test("workspace=team:OTHER with team_id=T: members of T are refused, members of OTHER admitted", async () => {
    const db = fixture({
      team_memberships: [
        { _id: "m1", user_id: OWNER, team_id: TEAM, role: "member" },
        { _id: "m2", user_id: MATE, team_id: TEAM, role: "member" },
        { _id: "m3", user_id: OUTSIDER, team_id: OTHER_TEAM, role: "member" },
      ],
    });
    const ctx = { db } as any;
    const row = { _id: "row3", user_id: OWNER, team_id: TEAM, workspace: `team:${OTHER_TEAM}` };
    expect(await canAccessPlan(ctx, MATE as any, row as any)).toBe(false);
    expect(await canAccessPlan(ctx, OUTSIDER as any, row as any)).toBe(true);
  });

  test("assignment stays an explicit grant on tasks regardless of workspace", async () => {
    const db = fixture();
    const ctx = { db } as any;
    expect(await canAccessTask(ctx, MATE as any, privateInTeam({ assignee: MATE }) as any)).toBe(true);
  });

  test("legacy row (no stored key) resolves lazily from the linked conversation — a private link stays owner-only", async () => {
    const db = fixture({
      conversations: [{ _id: "c1", user_id: OWNER, team_id: TEAM, is_private: true }],
    });
    const ctx = { db } as any;
    const legacy = { _id: "row4", user_id: OWNER, team_id: TEAM, created_from_conversation: "c1" };
    expect(await canAccessTask(ctx, MATE as any, legacy as any)).toBe(false);
    const legacyPlan = { _id: "row5", user_id: OWNER, team_id: TEAM, created_from_conversation_id: "c1" };
    expect(await canAccessPlan(ctx, MATE as any, legacyPlan as any)).toBe(false);
  });

  test("source-level: no access helper in lib/access.ts reads team_id (only the key writer may)", () => {
    const src = readFileSync(join(import.meta.dir, "access.ts"), "utf8");
    // Slice out every function that grants access, then assert none mentions
    // team_id. computeWorkspaceKey / workspaceForResource are the WRITER side
    // and are excluded by name — they are the only place the axis is bridged.
    const readers = [
      "canAccessTask", "canAccessProject", "canAccessDoc", "canAccessPlan",
      "workspaceGrantsAccess", "resolveWorkspaceKey", "effectiveTeamForResource",
    ];
    for (const name of readers) {
      const start = src.indexOf(`export async function ${name}(`);
      expect(start).toBeGreaterThan(-1);
      // Body only — the parameter TYPE may still describe a row shape that has
      // a team_id (routing lives on the same row); reading it is what's banned.
      const bodyStart = src.indexOf("{\n", src.indexOf("): Promise<", start));
      const body = src.slice(bodyStart, src.indexOf("\n}\n", bodyStart));
      expect(body.includes("team_id"), `${name} must not read team_id`).toBe(false);
    }
  });
});

describe("INVARIANT 2 — routing and access are independent state", () => {
  test("data context insert stamps BOTH axes and an explicit workspace overrides the access axis only", async () => {
    const db = fixture();
    const ctx = { db } as any;
    const dc = await createDataContext(ctx, { userId: OWNER as any, workspace: "team", team_id: TEAM as any });
    await dc.insert("tasks", { title: "team-routed, team-readable", short_id: "ct-1" });
    await dc.insert("tasks", { title: "team-routed, owner-only", short_id: "ct-2", workspace: "user:u_owner" });
    const [a, b] = db._inserted.map((i: any) => i.doc);
    expect(a.team_id).toBe(TEAM);
    expect(a.workspace).toBe("team:t_team");
    expect(b.team_id).toBe(TEAM); // routing unchanged
    expect(b.workspace).toBe("user:u_owner"); // access diverges
  });

  test("a team-routed owner-only row is in T's routing index but absent from T's access-scoped list", async () => {
    const db = fixture({
      tasks: [
        { _id: "t1", user_id: OWNER, team_id: TEAM, workspace: "team:t_team", title: "shared", updated_at: 2 },
        { _id: "t2", user_id: OWNER, team_id: TEAM, workspace: "user:u_owner", title: "private", updated_at: 1 },
      ],
    });
    const ctx = { db } as any;
    // ROUTING: the raw team index still carries both rows.
    const routed = await db.query("tasks").withIndex("by_team_id", (q: any) => q.eq("team_id", TEAM)).collect();
    expect(routed.map((r: any) => r._id).sort()).toEqual(["t1", "t2"]);
    // ACCESS: the mate's team-scoped list sees only the shared one; the owner's
    // team-scoped list ALSO sees only the shared one (private lives in personal).
    const mateList = await scopedFetch(ctx, "tasks", { userId: MATE as any, teamId: TEAM as any, workspace: "team" });
    expect(mateList.records.map((r: any) => r._id)).toEqual(["t1"]);
    const ownerTeam = await scopedFetch(ctx, "tasks", { userId: OWNER as any, teamId: TEAM as any, workspace: "team" });
    expect(ownerTeam.records.map((r: any) => r._id)).toEqual(["t1"]);
    const ownerPersonal = await scopedFetch(ctx, "tasks", { userId: OWNER as any, workspace: "personal" });
    expect(ownerPersonal.records.map((r: any) => r._id)).toEqual(["t2"]);
    // The chokepoint query path agrees with scopedFetch.
    const dcMate = await createDataContext(ctx, { userId: MATE as any, workspace: "team", team_id: TEAM as any });
    expect((await dcMate.query("tasks").collect()).map((r: any) => r._id)).toEqual(["t1"]);
    expect(await dcMate.get("t2")).toBeNull();
    expect(await dcMate.get("t1")).not.toBeNull();
  });

  test("shipped rows carry the resolved key and a team_id that names ONLY the access team", async () => {
    const db = fixture({
      conversations: [{ _id: "c1", user_id: OWNER, team_id: TEAM, is_private: true }],
      docs: [{ _id: "d1", user_id: OWNER, team_id: TEAM, conversation_id: "c1", title: "legacy private" }],
    });
    const { records } = await scopedFetch({ db } as any, "docs", { userId: OWNER as any, workspace: "personal" });
    expect(records.map((r: any) => r._id)).toEqual(["d1"]);
    expect(records[0].workspace).toBe("user:u_owner");
    expect(records[0].team_id).toBeUndefined();
  });
});

describe("propagation — the stored key follows the linked conversation", () => {
  const seed = () => fixture({
    conversations: [{ _id: "c1", user_id: OWNER, team_id: TEAM, is_private: true }],
    tasks: [{ _id: "t1", user_id: OWNER, team_id: TEAM, created_from_conversation: "c1", workspace: "user:u_owner", title: "task" }],
    plans: [{ _id: "p1", user_id: OWNER, team_id: TEAM, created_from_conversation_id: "c1", workspace: "user:u_owner", title: "plan" }],
    docs: [
      { _id: "d1", user_id: OWNER, team_id: TEAM, conversation_id: "c1", workspace: "user:u_owner", title: "doc" },
      // Array-only link, owner's row: reached by the owner scan.
      { _id: "d2", user_id: OWNER, team_id: TEAM, related_conversation_ids: ["c1"], workspace: "user:u_owner", title: "related" },
      // Unrelated row: must not be touched.
      { _id: "d3", user_id: OWNER, team_id: TEAM, workspace: "team:t_team", title: "unrelated" },
    ],
  });

  const keys = (db: any) => ({
    t1: db._tables.tasks[0].workspace,
    p1: db._tables.plans[0].workspace,
    d1: db._tables.docs[0].workspace,
    d2: db._tables.docs[1].workspace,
    d3: db._tables.docs[2].workspace,
  });

  test("SHARE: locking off private flips every linked row to the team key", async () => {
    const db = seed();
    const n = await patchConversationVisibility({ db } as any, db._tables.conversations[0], { is_private: false });
    expect(n).toBe(4);
    expect(keys(db)).toEqual({ t1: "team:t_team", p1: "team:t_team", d1: "team:t_team", d2: "team:t_team", d3: "team:t_team" });
    // And access follows immediately.
    expect(await canAccessTask({ db } as any, MATE as any, db._tables.tasks[0])).toBe(true);
  });

  test("UNSHARE / LOCK PRIVATE: revokes already-derived access — the bug this field exists to close", async () => {
    const db = seed();
    await patchConversationVisibility({ db } as any, db._tables.conversations[0], { is_private: false });
    const n = await patchConversationVisibility({ db } as any, db._tables.conversations[0], { is_private: true, team_visibility: "private" });
    expect(n).toBe(4);
    expect(keys(db)).toEqual({ t1: "user:u_owner", p1: "user:u_owner", d1: "user:u_owner", d2: "user:u_owner", d3: "team:t_team" });
    expect(await canAccessTask({ db } as any, MATE as any, db._tables.tasks[0])).toBe(false);
    expect(await canAccessPlan({ db } as any, MATE as any, db._tables.plans[0])).toBe(false);
  });

  test("REVEAL via team_visibility on a private session shares linked rows", async () => {
    const db = seed();
    await patchConversationVisibility({ db } as any, db._tables.conversations[0], { team_visibility: "summary" });
    expect(keys(db).t1).toBe("team:t_team");
    expect(keys(db).p1).toBe("team:t_team");
  });

  test("LATE PATH STAMP: a born-blank (teamless, shared) session gaining a team shares linked rows", async () => {
    const db = fixture({
      conversations: [{ _id: "c1", user_id: OWNER, is_private: false }],
      tasks: [{ _id: "t1", user_id: OWNER, created_from_conversation: "c1", workspace: "user:u_owner", title: "task" }],
    });
    // Teamless + shared computes personal (shared with nobody).
    expect(computeWorkspaceKey(db._tables.tasks[0], db._tables.conversations[0])).toBe("user:u_owner");
    await patchConversationVisibility({ db } as any, db._tables.conversations[0], { team_id: TEAM, auto_shared: true });
    expect(db._tables.tasks[0].workspace).toBe("team:t_team");
  });

  test("REPARENT / MOVE to another team re-keys linked rows to the new team", async () => {
    const db = seed();
    await patchConversationVisibility({ db } as any, db._tables.conversations[0], { is_private: false });
    await patchConversationVisibility({ db } as any, db._tables.conversations[0], { team_id: OTHER_TEAM });
    expect(keys(db).t1).toBe("team:t_other");
    expect(keys(db).d2).toBe("team:t_other");
    expect(keys(db).d3).toBe("team:t_team"); // unlinked, untouched
  });

  test("a no-op visibility patch rewrites nothing", async () => {
    const db = seed();
    const before = db._patched.length;
    const n = await recomputeWorkspaceForConversation({ db } as any, db._tables.conversations[0]);
    expect(n).toBe(0);
    expect(db._patched.length).toBe(before);
  });
});
