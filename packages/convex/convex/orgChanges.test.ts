import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { getEntry, listEntries, performUndo, planUndo } from "./orgChanges";
import { performCreateRole, performRetireRole, performSetCaps, performSetProjectLead, performSetTrust, performUpdateRole } from "./orgRoles";
import { applyOrgChange } from "./orgInit";
import { performReparentSession } from "./sessionOwnership";
import { openOrgBatch } from "./lib/orgChangeLog";
import { invertRow, orgLogLine } from "@codecast/shared/contracts/orgChange";

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const P = "projects_p";
const NOW = Date.now();
function fixture() {
  const db = makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: MATE, name: "Mate", email: "mate@x.ai" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin" }, { _id: "m2", user_id: MATE, team_id: TEAM, role: "member" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    projects: [{ _id: P, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", status: "active", project_path: "/repo/growth", created_at: 1, updated_at: NOW }, { _id: "projects_q", user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-2", title: "Billing", status: "active", project_path: "/repo/billing", created_at: 1, updated_at: NOW }],
    plans: [{ _id: "plans_p", user_id: ME, team_id: TEAM, workspace: WS, short_id: "pl-1", title: "Plan", status: "active", created_at: 1, updated_at: NOW }],
    tasks: [{ _id: "tasks_t", user_id: ME, team_id: TEAM, workspace: WS, short_id: "ct-1", title: "Task", status: "open", plan_id: "plans_p", created_at: 1, updated_at: NOW }],
    conversations: [{ _id: "conversations_c", short_id: "jx70001", user_id: ME, team_id: TEAM, is_private: false, status: "active", agent_type: "claude_code", title: "Session", project_path: "/repo/growth", message_count: 3, updated_at: NOW, created_at: 1 }],
    initiatives: [{ _id: "initiatives_i", user_id: ME, team_id: TEAM, workspace: WS, short_id: "in-1", title: "Campaign", project_ids: ["projects_q"], status: "active", health: "none", created_at: 1, updated_at: NOW }],
    counters: [],
  });
  const ctx = () => ({ db, auth: { getUserIdentity: async () => ({ subject: ME }) } });
  const last = () => db._tables.org_change_batches.at(-1)._id;
  const role = () => performCreateRole(ctx(), ME as any, { name: "Growth", handle: "growth", team_id: TEAM, scope: { project_ids: ["projects_q" as any], plan_ids: [] } });
  const apply = (change: any) => applyOrgChange(ctx(), ME as any, { team_id: TEAM }, change, { provision: false, human_decision: "sd-1" });
  const undo = (batch = last(), opts = {}) => performUndo(ctx(), ME as any, { batch, ...opts });
  const redo = (batch: string) => performUndo(ctx(), ME as any, { batch }, true);
  return { db, ctx, last, role, apply, undo, redo };
}

async function roundTrip(f: ReturnType<typeof fixture>, id: string, action: () => Promise<unknown>, fields: string[]) {
  const pick = async () => { const row = await f.db.get(id); return Object.fromEntries(fields.map((k) => [k, row[k] ?? null])); };
  const before = await pick();
  await action();
  const batch = f.last();
  const after = await pick();
  const count = f.db._tables.org_change_batches.length;
  expect(after).not.toEqual(before);
  const preview = await planUndo(f.ctx(), ME as any, batch);
  expect(preview.preview.refused).toBeUndefined();
  expect(preview.preview.will_change.length).toBeGreaterThan(0);
  expect(await pick()).toEqual(after);
  await f.undo(batch);
  expect(await pick()).toEqual(before);
  expect(f.db._tables.org_change_batches).toHaveLength(count + 1);
  await f.redo(batch);
  expect(await pick()).toEqual(after);
  expect(f.db._tables.org_change_batches).toHaveLength(count + 2);
}

describe("org history round trips", () => {
  test("budget, trust and role fields use reversible rows", async () => {
    const f = fixture(); const role = await f.role();
    await roundTrip(f, role._id, () => performSetCaps(f.ctx(), ME as any, { role_id: role._id, hands: 8 }), ["caps"]);
    await roundTrip(f, role._id, () => performSetTrust(f.ctx(), ME as any, { role_id: role._id, on: false }), ["trust"]);
    await roundTrip(f, role._id, () => performUpdateRole(f.ctx(), ME as any, { role_id: role._id, name: "Market" }), ["name"]);
  });
  for (const [kind, target, fields, change] of [
    ["task_status", "tasks_t", ["status", "closed_at", "review_verdict"], { task: "ct-1", status: "done", reason: "finished" }],
    ["plan_status", "plans_p", ["status"], { plan: "pl-1", status: "done", reason: "finished" }],
    ["project_status", P, ["status"], { project: "pr-1", status: "paused", reason: "waiting" }],
    ["project_meta", P, ["goal", "priority"], { project: "pr-1", goal: "Grow", priority: "p1" }],
    ["file", "plans_p", ["project_id"], { plan: "pl-1", project: "pr-1" }],
  ] as const) test(`${kind} round trips through apply, undo and redo`, async () => {
    const f = fixture();
    await roundTrip(f, target, () => f.apply({ kind, ...change }), [...fields]);
  });
  test("closing a plan restores the tasks closed with it", async () => {
    const f = fixture(); await f.apply({ kind: "plan_status", plan: "pl-1", status: "done", reason: "old" });
    const batch = f.last(); expect((await f.db.get("tasks_t")).status).toBe("dropped");
    await f.undo(batch); expect((await f.db.get("tasks_t")).status).toBe("open");
    await f.redo(batch); expect((await f.db.get("tasks_t")).status).toBe("dropped");
  });
  test("lead restores its scope gain and takeover", async () => {
    const f = fixture(); const role = await f.role();
    // Folders decide nothing (S35): the session is the project's because it works the project's task.
    await f.db.patch("plans_p", { project_id: P }); await f.db.patch("conversations_c", { active_task_id: "tasks_t" });
    const before = (await f.db.get(role._id)).scope;
    await performSetProjectLead(f.ctx(), ME as any, { project_id: P as any, role_id: role._id });
    const batch = f.last(); expect((await f.db.get("conversations_c")).org_role_id).toBe(role._id);
    await f.undo(batch);
    expect((await f.db.get(P)).owner_role_id).toBeUndefined();
    expect((await f.db.get(role._id)).scope).toEqual(before);
    expect((await f.db.get("conversations_c")).org_role_id).toBeUndefined();
    await f.redo(batch); expect((await f.db.get("conversations_c")).org_role_id).toBe(role._id);
  });
  test("session ownership uses the same reparent core", async () => {
    const f = fixture();
    await roundTrip(f, "conversations_c", () => performReparentSession(f.ctx(), ME as any, { session_id: "jx70001", target: { kind: "user", user_id: MATE as any } }), ["owner_user_id"]);
  });
  test("undoing an adopt gives the session back the owners the seat replaced", async () => {
    const f = fixture(); await f.role();
    const owners = async () => ({ rows: f.db._tables.session_owners.filter((r: any) => r.conversation_id === "conversations_c").map((r: any) => r.user_id).sort(), primary: (await f.db.get("conversations_c")).owner_user_id ?? null });
    await f.db.insert("session_owners", { conversation_id: "conversations_c", user_id: MATE, added_by: ME, added_at: 1 });
    await f.db.patch("conversations_c", { owner_user_id: MATE });
    await f.apply({ kind: "adopt", handle: "growth", conversation: "jx70001" }); const adopt = f.last();
    // The seat reports to the role's person (S28), so the seat replaced the owner.
    expect(await owners()).toEqual({ rows: [ME], primary: ME });
    await f.undo(adopt);
    expect(await owners()).toEqual({ rows: [MATE], primary: MATE });
    await f.redo(adopt);
    expect(await owners()).toEqual({ rows: [ME], primary: ME });
  });
  test("undoing an adopt puts the replaced owner's row back as it was, not as a new handoff", async () => {
    const f = fixture(); await f.role();
    const mateRow = () => f.db._tables.session_owners.find((r: any) => r.conversation_id === "conversations_c" && r.user_id === MATE);
    await f.db.insert("session_owners", { conversation_id: "conversations_c", user_id: MATE, added_by: MATE, added_at: 1, seen_at: 2, note: "mine" });
    await f.db.patch("conversations_c", { owner_user_id: MATE });
    await f.apply({ kind: "adopt", handle: "growth", conversation: "jx70001" }); const adopt = f.last();
    expect(mateRow()).toBeUndefined();
    await f.undo(adopt);
    // An unseen row added by someone else is an "assigned to you" ping; the
    // owner had acknowledged theirs long before, so the undo must not raise one.
    const { added_by, added_at, seen_at, note } = mateRow();
    expect({ added_by, added_at, seen_at, note }).toEqual({ added_by: MATE, added_at: 1, seen_at: 2, note: "mine" });
  });
  test("an owner change after an adopt leaves the owners alone and still takes the seat back", async () => {
    const f = fixture(); await f.role();
    const seat = async () => { const c = await f.db.get("conversations_c"); return { org_role_id: c.org_role_id ?? null, standing_role_id: c.standing_role_id ?? null }; };
    const before = await seat();
    await f.apply({ kind: "adopt", handle: "growth", conversation: "jx70001" }); const adopt = f.last();
    expect(await seat()).not.toEqual(before);
    // A co-owner joins after the adopt.
    await f.db.insert("session_owners", { conversation_id: "conversations_c", user_id: MATE, added_by: ME, added_at: NOW + 1 });
    const owners = () => f.db._tables.session_owners.filter((r: any) => r.conversation_id === "conversations_c").map((r: any) => r.user_id).sort();
    const ownersNow = owners();
    const p = await planUndo(f.ctx(), ME as any, adopt);
    expect(p.preview.left_alone.map((e: any) => e.row.skipped)).toContain("its owners changed after this");
    await f.undo(adopt);
    expect(await seat()).toEqual(before);
    expect(owners()).toEqual(ownersNow);
  });
  test("retirement restores children and untouched task assignments", async () => {
    const f = fixture(); const role = await f.role();
    await f.db.patch("tasks_t", { assignee: role._id });
    const child = await performCreateRole(f.ctx(), ME as any, { name: "Child", handle: "child", team_id: TEAM, scope: role.scope, reports_to: { kind: "role", role_id: role._id } });
    await performRetireRole(f.ctx(), ME as any, { role_id: role._id }); const batch = f.last();
    await f.undo(batch);
    expect((await f.db.get(role._id)).status).toBe("active");
    expect((await f.db.get(child._id)).reports_to).toEqual({ kind: "role", role_id: role._id });
    expect((await f.db.get("tasks_t")).assignee).toBe(role._id);
  });
});

describe("org history refuses unsafe undo", () => {
  test("later field edits are left alone, and the preview makes no writes", async () => {
    const f = fixture(); const role = await f.role();
    await performSetCaps(f.ctx(), ME as any, { role_id: role._id, hands: 8 }); const batch = f.last();
    await performSetCaps(f.ctx(), ME as any, { role_id: role._id, hands: 9 });
    const snapshot = JSON.stringify(f.db._tables);
    const p = await planUndo(f.ctx(), ME as any, batch);
    expect(p.preview.left_alone).toHaveLength(1); expect(p.preview.will_change).toHaveLength(0);
    expect(JSON.stringify(f.db._tables)).toBe(snapshot);
    await expect(f.undo(batch)).rejects.toThrow("Nothing can be restored");
  });
  test("a non-admin and a session token cannot undo a role change", async () => {
    const f = fixture(); await f.role(); const batch = f.last();
    await expect(performUndo(f.ctx(), MATE as any, { batch })).rejects.toThrow("only undo changes");
    await expect(f.undo(batch, { api_token: "token" })).rejects.toThrow("human only");
    await expect(f.undo(batch, { from_session: "jx70001" })).rejects.toThrow("human only");
  });
  test("private history is absent from team and outsider reads", async () => {
    const f = fixture(); await performCreateRole(f.ctx(), ME as any, { name: "Private", handle: "private" }); const batch = f.last();
    expect((await listEntries(f.ctx(), MATE as any, { team_id: TEAM }))?.entries).toHaveLength(0);
    await expect(getEntry(f.ctx(), MATE as any, batch)).rejects.toThrow("not found");
  });
  test("hire dependencies are explicit and undo is idempotent", async () => {
    const f = fixture(); const role = await f.role(); const hire = f.last();
    await performSetCaps(f.ctx(), ME as any, { role_id: role._id, hands: 8 }); const budget = f.last();
    expect((await planUndo(f.ctx(), ME as any, hire)).preview.depends.map((d) => d._id)).toEqual([budget]);
    await expect(f.undo(hire)).rejects.toThrow("dependent entries");
    await f.undo(hire, { with: [budget] });
    expect((await f.db.get(role._id)).status).toBe("retired");
    const count = f.db._tables.org_changes.length;
    expect(await f.undo(hire)).toMatchObject({ already_applied: true });
    expect(f.db._tables.org_changes).toHaveLength(count);
  });
  test("restoring a retired role cannot steal its reused handle", async () => {
    const f = fixture(); const role = await f.role();
    await performRetireRole(f.ctx(), ME as any, { role_id: role._id }); const retired = f.last();
    await f.role();
    await expect(f.undo(retired)).rejects.toThrow("handle is now taken");
  });
});

describe("org history lifecycle and partial changes", () => {
  test("a named standing session stays running when its hire is undone and can be reseated by redo", async () => {
    const f = fixture();
    await f.apply({ kind: "role", name: "Growth", handle: "growth", seat: { existing: "jx70001" } }); const hire = f.last();
    const role = f.db._tables.org_roles[0];
    expect((await f.db.get("conversations_c")).standing_role_id).toBe(role._id);
    await f.undo(hire);
    expect((await f.db.get("conversations_c")).status).toBe("active");
    expect((await f.db.get("conversations_c")).standing_role_id).toBeUndefined();
    expect((await f.db.get("conversations_c")).title).toBe("Session");
    expect((await f.db.get(role._id)).status).toBe("retired");
    await f.redo(hire);
    expect((await f.db.get("conversations_c")).standing_role_id).toBe(role._id);
    expect((await f.db.get(role._id)).status).toBe("active");
  });
  test("a routine cancels and rearms the same trigger without duplicating it", async () => {
    const f = fixture(); await f.apply({ kind: "role", name: "Growth", handle: "growth", seat: { existing: "jx70001" } });
    await f.apply({ kind: "routine", handle: "growth", title: "Review", prompt: "Review progress", every: "1d" }); const batch = f.last();
    // The seat carries its own check (S25) and its needs-input trigger (S28) beside the routine the change armed.
    const trigger = f.db._tables.agent_tasks.find((t: any) => t.title === "Review");
    await f.undo(batch); expect((await f.db.get(trigger._id)).status).toBe("cancelled");
    await f.redo(batch); expect((await f.db.get(trigger._id)).status).toBe("scheduled");
    expect(f.db._tables.agent_tasks.map((t: any) => t.title).sort()).toEqual(["A session under you needs input", "Check Growth's area", "Review"]);
  });
  test("an untouched task reopens while a later change to its sibling stays", async () => {
    const f = fixture();
    const { _id, ...task } = await f.db.get("tasks_t");
    const sibling = await f.db.insert("tasks", { ...task, short_id: "ct-2" });
    await f.apply({ kind: "plan_status", plan: "pl-1", status: "done", reason: "old" }); const batch = f.last();
    await f.db.patch("tasks_t", { status: "done" });
    const p = await planUndo(f.ctx(), ME as any, batch);
    expect(p.preview.left_alone).toHaveLength(1);
    expect(p.preview.will_change[0].effects.tasks_closed?.map((t) => t.task_id)).not.toContain("tasks_t");
    await f.undo(batch);
    expect((await f.db.get("tasks_t")).status).toBe("done");
    expect((await f.db.get("plans_p")).status).toBe("active");
    expect((await f.db.get(sibling)).status).toBe("open");
  });
  test("unlogged later assignments cannot be orphaned by undoing a hire", async () => {
    const f = fixture(); const role = await f.role(); const hire = f.last();
    await f.db.patch("tasks_t", { assignee: role._id });
    expect((await planUndo(f.ctx(), ME as any, hire)).preview.refused).toContain("later work still reports");
    await expect(f.undo(hire)).rejects.toThrow("later work still reports");
    expect((await f.db.get(role._id)).status).toBe("active");
  });
  test("undo and redo can be repeated", async () => {
    const f = fixture(); const role = await f.role();
    await performSetCaps(f.ctx(), ME as any, { role_id: role._id, hands: 8 }); const batch = f.last();
    await f.undo(batch); await f.redo(batch); await f.undo(batch); await f.redo(batch);
    expect((await f.db.get(role._id)).caps.hands_per_day).toBe(8);
  });
});

describe("org history remaining change kinds", () => {
  test("scope and reporting-line edits round trip", async () => {
    const f = fixture(); const role = await f.role();
    await roundTrip(f, role._id, () => f.apply({ kind: "scope", handle: "growth", add: ["pr-1"], leave_sessions: true }), ["scope"]);
    await roundTrip(f, role._id, () => f.apply({ kind: "move", handle: "growth", reports_to: MATE }), ["reports_to"]);
  });
  test("project merge restores the source and records without moving later additions", async () => {
    const f = fixture(); await f.db.patch("plans_p", { project_id: P });
    const before = await f.db.get(P);
    await f.apply({ kind: "projects", changes: [{ op: "merge", from: "pr-1", into: "pr-2" }] }); const batch = f.last();
    expect((await f.db.get("plans_p")).project_id).toBe("projects_q");
    await f.undo(batch);
    expect((await f.db.get("plans_p")).project_id).toBe(P);
    expect((await f.db.get(P)).description).toEqual(before.description);
    expect((await f.db.get(P)).status).toBe(before.status);
    await f.redo(batch); expect((await f.db.get("plans_p")).project_id).toBe("projects_q");
  });
  test("project creation undo keeps a tombstone and redo reuses it", async () => {
    const f = fixture(); await f.apply({ kind: "projects", changes: [{ op: "create", title: "New project" }] }); const batch = f.last();
    const project = f.db._tables.projects.find((p: any) => p.title === "New project");
    await f.undo(batch); expect((await f.db.get(project._id)).status).toBe("done");
    await f.redo(batch); expect((await f.db.get(project._id)).status).toBe("active");
    expect(f.db._tables.projects.filter((p: any) => p.title === "New project")).toHaveLength(1);
  });
  test("a separate adoption and routine form an explicit dependency", async () => {
    const f = fixture(); await f.role();
    await f.apply({ kind: "adopt", handle: "growth", conversation: "jx70001" }); const adopt = f.last();
    await f.apply({ kind: "routine", handle: "growth", title: "Review", prompt: "Review progress", every: "1d" }); const routine = f.last();
    expect((await planUndo(f.ctx(), ME as any, adopt)).preview.depends.map((e) => e._id)).toContain(routine);
    await f.undo(adopt, { with: [routine] });
    expect((await f.db.get("conversations_c")).standing_role_id).toBeUndefined();
    expect(f.db._tables.agent_tasks[0].status).toBe("cancelled");
  });
  // The intent record (initiatives-projects-role-page.md I5): one entry at a
  // time through performRecordEntry, each write the goal's shape, so each undoes.
  test("a record entry round trips: a milestone added, reached and removed, a question asked and answered", async () => {
    const { performRecordEntry } = await import("./initiatives");
    const f = fixture();
    const goal = () => f.db.get("initiatives_i");
    const record = async (op: any) => performRecordEntry(f.ctx(), ME as any, await goal(), op);
    await roundTrip(f, "initiatives_i", () => record({ list: "milestones", action: "add", entry: { title: "Private beta open", date: 1_800_000_000_000 } }), ["milestones"]);
    const key = (await goal()).milestones[0].key;
    await roundTrip(f, "initiatives_i", () => record({ list: "milestones", action: "close", key, at: 1_800_000_500_000 }), ["milestones"]);
    expect((await goal()).milestones).toEqual([{ key, title: "Private beta open", date: 1_800_000_000_000, done_at: 1_800_000_500_000 }]);
    await roundTrip(f, "initiatives_i", () => record({ list: "questions", action: "add", entry: { text: "Do we price per seat?", by: "@me" } }), ["questions"]);
    await roundTrip(f, "initiatives_i", async () => record({ list: "questions", action: "close", key: (await goal()).questions[0].key, answer: "Per seat." }), ["questions"]);
    await roundTrip(f, "initiatives_i", () => record({ list: "decisions", action: "add", entry: { text: "Ship to brokers first", by: "@me" } }), ["decisions"]);
    await roundTrip(f, "initiatives_i", () => record({ list: "sources", action: "add", entry: { text: "call:cl-42#14 our goal is a thousand teams" } }), ["sources"]);
    await roundTrip(f, "initiatives_i", () => record({ list: "milestones", action: "remove", key }), ["milestones"]);
    expect((await goal()).milestones).toBeUndefined();
    // Every write read as a sentence in the log, and so did its way back.
    for (const r of f.db._tables.org_changes) expect(orgLogLine({ ...r, at: r.created_at })).toMatch(/^(Record on|Change the) /);
  });
  // Accepting a goal change persists its evidence (I5 "Proposals"): the lines
  // the change carries and the accepted row's links join the goal's sources,
  // in a log row of their own beside the change's.
  test("a goal change's evidence becomes the goal's sources, once, and goes back with its undo", async () => {
    const f = fixture(); await f.role();
    const accept = (change: any, evidence: any[]) => applyOrgChange(f.ctx(), ME as any, { team_id: TEAM }, change, { provision: false, human_decision: "sd-1", evidence });
    const sources = async (id = "initiatives_i") => (await f.db.get(id)).sources ?? [];
    const link = { label: "the ads session", href: "https://codecast.sh/conversation/jx7abcd" };
    // A link keeps its label as the words said, and a codecast address reads as the object it opens.
    const said = { kind: "session", ref: "jx7abcd", quote: "the ads session" };
    const owner = { kind: "initiative_owner", initiative: "in-1", owner: "@growth" };
    expect((await accept(owner, [link, { label: "Ashot said so in chat" }])).note).toContain("its record names 2 sources for it");
    expect(await sources()).toEqual([said, { kind: "note", quote: "Ashot said so in chat" }]);
    // One entry, two rows: the owner and the sources are each judged on their own fields when undone.
    const ownerBatch = f.last();
    const goalFields = (r: any) => Object.keys(r.writes.find((w: any) => w.id === "initiatives_i").after);
    expect(f.db._tables.org_changes.filter((r: any) => r.batch === ownerBatch).map((r: any) => [r.kind, goalFields(r)])).toEqual([["initiative_owner", ["owner"]], ["initiative_shape", ["sources"]]]);
    // A change that moves nothing else still says where the review read it, and a second run adds nothing.
    expect((await accept(owner, [{ label: "another line" }])).note).toBe('@growth already owns in-1 "Campaign"; its record names 1 source for it');
    expect((await sources()).at(-1)).toEqual({ kind: "note", quote: "another line" });
    const writes = writeCount(f.db);
    expect((await accept(owner, [{ label: "another line" }])).note).toBe('@growth already owns in-1 "Campaign"');
    expect(writeCount(f.db)).toBe(writes);
    // A source the goal already holds is skipped. A path reads as the object it opens, with no words when the label only repeats it, and a path that opens no object leaves the label as a note.
    await accept({ kind: "initiative_projects", initiative: "in-1", projects: ["pr-1"] }, [link, { label: "ct-1", href: "/tasks/ct-1" }, { label: "the pricing page", href: "/settings/billing" }]);
    expect((await sources()).slice(3)).toEqual([{ kind: "task", ref: "ct-1" }, { kind: "note", quote: "the pricing page" }]);
    // A shape change adds its own sources and its evidence, and a second run adds nothing.
    const shape = { kind: "initiative_shape", initiative: "in-1", why: "It pays for the rest.", sources: ["jx7c6zk:142"], questions: ["Who signs?"] };
    await accept(shape, [link, { label: "pl-1" }]); const shapeBatch = f.last();
    expect((await sources()).slice(5).map((s: any) => s.ref)).toEqual(["jx7c6zk:142", "pl-1"]);
    const again = writeCount(f.db);
    expect((await accept(shape, [link, { label: "pl-1" }])).note).toContain("already reads that way");
    expect(writeCount(f.db)).toBe(again);
    expect((await f.db.get("initiatives_i")).questions).toHaveLength(1);
    // The sources a change brought go back with it, and the ones earlier changes brought stay.
    await f.undo(shapeBatch);
    expect(await sources()).toHaveLength(5);
    expect([(await f.db.get("initiatives_i")).why, (await f.db.get("initiatives_i")).questions]).toEqual([undefined, undefined]);
    // A shape change that moves nothing says only what its evidence added.
    expect((await accept({ kind: "initiative_shape", initiative: "in-1", parent: null }, [{ label: "said at standup" }])).note).toBe('the goal "Campaign" (in-1) gained 1 source');
    // A new goal carries its record from the start: the named sources, then the change's own lines, then the row's links, and the questions and decisions the card showed.
    const create = { kind: "initiative", title: "Reach 1k teams", description: "d", projects: ["pr-1"], sources: ["ct-1"], evidence: ["said on the Monday call"], questions: ["Who pays?"], decisions: ["Ship to brokers first"] };
    await accept(create, [link]);
    const made = f.db._tables.initiatives.at(-1);
    expect(made.sources).toEqual([{ kind: "task", ref: "ct-1" }, { kind: "note", quote: "said on the Monday call" }, said]);
    expect([made.questions.map((q: any) => q.text), made.decisions.map((d: any) => d.text)]).toEqual([["Who pays?"], ["Ship to brokers first"]]);
    // A goal of that title already exists: nothing is set twice, and evidence it does not hold still joins.
    expect((await accept(create, [{ label: "pl-1" }])).note).toBe(`the goal "Reach 1k teams" already exists (${made.short_id}); its record names 1 source for it`);
    expect(f.db._tables.initiatives.at(-1)._id).toBe(made._id);
  });
  // The sources are a row of their own, so a source the goal gains later
  // leaves the owner change free to go back; the sources that moved stay.
  test("a source the goal gains later does not block the undo of the change that brought the first", async () => {
    const { performRecordEntry } = await import("./initiatives");
    const f = fixture(); await f.role();
    await applyOrgChange(f.ctx(), ME as any, { team_id: TEAM }, { kind: "initiative_owner", initiative: "in-1", owner: "@growth" } as any, { provision: false, human_decision: "sd-1", evidence: [{ label: "Growth owns this", href: "https://codecast.sh/calls/cl-42?turns=14" }] });
    const batch = f.last();
    await performRecordEntry(f.ctx(), ME as any, await f.db.get("initiatives_i"), { list: "sources", action: "add", entry: { text: "ct-1" } });
    const { preview } = await planUndo(f.ctx(), ME as any, batch);
    expect(preview.will_change.map((r) => orgLogLine(r))).toEqual(["The goal Campaign has no owner"]);
    expect(preview.left_alone).toHaveLength(1);
    await f.undo(batch);
    const goal = await f.db.get("initiatives_i");
    expect(goal.owner).toBeUndefined();
    expect(goal.sources).toEqual([{ kind: "call", ref: "cl-42:14", quote: "Growth owns this" }, { kind: "task", ref: "ct-1" }]);
  });
  // Each list of a shape change adds what the goal does not hold, compared by
  // its words whatever their case and spacing, up to the room the list has.
  test("a shape change adds only what the goal does not hold and has room for", async () => {
    const f = fixture();
    await f.db.patch("initiatives_i", { milestones: Array.from({ length: 11 }, (_, i) => ({ key: `m${i}`, title: `Step ${i}` })), decisions: [{ key: "brokers", text: "Ship to brokers first", at: 1 }] });
    const result = await f.apply({ kind: "initiative_shape", initiative: "in-1", why: "It pays.", milestones: [{ title: "step  3" }, { title: "Private beta open" }, { title: "General availability" }], decisions: [" ship to  Brokers first"] });
    expect((result as any).note).toBe('the goal "Campaign" (in-1) says why it matters and gained 1 milestone; it has no room for 1 milestone');
    const goal = await f.db.get("initiatives_i");
    expect([goal.milestones.length, goal.milestones.at(-1).title, goal.decisions.length]).toEqual([12, "Private beta open", 1]);
  });
  test("an initiative owner undo removes only the scope it gained", async () => {
    const { performUpdateInitiative } = await import("./initiatives");
    const f = fixture(); const role = await f.role();
    const id = await f.db.insert("initiatives", { user_id: ME, team_id: TEAM, workspace: WS, short_id: "in-2", title: "Campaign 2", project_ids: [P], status: "active" });
    const scope = role.scope;
    await performUpdateInitiative(f.ctx(), ME as any, await f.db.get(id), { owner: { kind: "role", role_id: role._id } }); const batch = f.last();
    await f.undo(batch);
    expect((await f.db.get(id)).owner).toBeUndefined();
    expect((await f.db.get(role._id)).scope).toEqual(scope);
  });
});


test("a gesture continued after a later edit still finds that edit as a dependency", async () => {
  const f = fixture();
  const head = { door: "proposal" as const, gesture: "accept_all" as const, key: "continued-proposal" };
  const first = f.ctx();
  openOrgBatch(first, head);
  const role = await performCreateRole(first, ME as any, { name: "First", handle: "first", team_id: TEAM });
  const batch = f.last();
  await performSetCaps(f.ctx(), ME as any, { role_id: role._id, hands: 8 });
  const dependent = f.last();
  const continuation = f.ctx();
  openOrgBatch(continuation, head);
  await performCreateRole(continuation, ME as any, { name: "Second", handle: "second", team_id: TEAM });
  const preview = await planUndo(f.ctx(), ME as any, batch);
  expect(preview.preview.depends.map((e) => e._id)).toEqual([dependent]);
  await f.undo(batch, { with: [dependent] });
  expect((await f.db.get(role._id)).status).toBe("retired");
});

// ── S21 "For us": the round trip for every change kind ─────────────────────
// "The undo's own correctness is tested by the round trip: apply, undo, and
// the workspace's org state compares equal to the snapshot taken before,
// field by field, with the log two entries longer." Every kind of
// `OrgChangeKind` goes through `applyOrgChange`, the function the proposal
// apply path calls. Org state is every field the log tracks on every table it
// tracks, plus a session's owner; audit tables (events, wakes, history) are
// not org state. A thing the change brought into being is not erased by its
// undo ("Undo is a new change, never an erasure"): it stays as a tombstone in
// its ended status, and that is the one way the restored state may differ. A
// kind whose way back is not the log's says so here, with the contract's words.
const ORG_STATE: Record<string, string[]> = {
  org_roles: ["status", "name", "handle", "avatar", "charter", "tenure", "review_backend", "reports_to", "scope", "caps", "trust", "anchor_id", "authority"],
  conversations: ["org_role_id", "standing_role_id", "anchor_id", "acting_user_id", "title", "title_is_custom", "seat_previous", "persistent", "status", "inbox_pinned_at", "owner_user_id"],
  anchors: ["org_role_id", "status"],
  agent_tasks: ["status"],
  tasks: ["status", "status_id", "assignee", "project_id", "closed_at", "review_verdict", "execution_status"],
  plans: ["status", "project_id", "owner_role_id"],
  projects: ["status", "description", "owner_role_id", "goal", "success_metrics", "priority", "non_goals", "risks", "budget"],
  docs: ["project_id"],
  initiatives: ["status", "owner", "project_ids", "parent_initiative_id", "metrics", "why", "done_when", "milestones", "questions", "decisions", "sources"],
  session_owners: ["conversation_id", "user_id"],
  org_template_instances: ["phase", "role_id", "version", "pending_upgrade"],
};
const TOMBSTONE: Record<string, string> = { org_roles: "retired", projects: "done", agent_tasks: "cancelled", anchors: "decommissioned", initiatives: "cancelled" };
// An owner row is the membership it records, so a redo that adds the owner back matches by conversation and person, not row id.
const stateKey = (table: string, row: any) => table === "session_owners" ? `session_owners:${row.conversation_id}:${row.user_id}` : String(row._id);
function orgState(db: any): Map<string, { table: string; fields: Record<string, unknown> }> {
  const out = new Map();
  for (const [table, fields] of Object.entries(ORG_STATE)) for (const row of db._tables[table] ?? []) out.set(stateKey(table, row), { table, fields: Object.fromEntries(fields.map((k) => [k, row[k] ?? null])) });
  return out;
}
const writeCount = (db: any) => db._patched.length + db._inserted.length + db._deleted.length;
const DIGEST = "a".repeat(64);
const TEMPLATE = { _id: "org_templates_1", template_id: "seo", workspace: WS, name: "SEO", description: "", latest: { version: "1.1.0", digest: DIGEST }, releases: [{ version: "1.0.0", digest: DIGEST, status: "stable", manifest: { inputs: [] }, published_at: 1, published_by: ME }, { version: "1.1.0", digest: DIGEST, status: "stable", manifest: { inputs: [] }, published_at: 2, published_by: ME }], manifest: { inputs: [] }, created_by: ME, created_at: 1, updated_at: 1 };
const HIRE = { kind: "hire", handle: "growth", template: "seo", version: "1.0.0", digest: DIGEST, instance: "seo-1", project: "pr-2" };
const HOST_STEP = "a hire and an upgrade are recorded, and their way back is the host step";

/** `kept`: what the undo leaves standing on purpose, by table, with the contract sentence that says so. */
type Case = { kind: string; setup?: (f: ReturnType<typeof fixture>) => Promise<unknown>; change: any; kept?: Record<string, { fields: Record<string, unknown>; because: string }> };
const CASES: Case[] = [
  { kind: "role", change: { kind: "role", name: "Growth", handle: "growth", scope: { projects: ["pr-2"] } } },
  { kind: "projects", change: { kind: "projects", changes: [{ op: "create", title: "New project" }] } },
  { kind: "move", setup: (f) => f.role(), change: { kind: "move", handle: "growth", reports_to: MATE } },
  { kind: "retire", setup: (f) => f.role(), change: { kind: "retire", handle: "growth" } },
  { kind: "scope", setup: (f) => f.role(), change: { kind: "scope", handle: "growth", add: ["pr-1"], leave_sessions: true } },
  { kind: "budget", setup: (f) => f.role(), change: { kind: "budget", handle: "growth", caps: { hands_per_day: 8 } } },
  { kind: "trust", setup: (f) => f.role(), change: { kind: "trust", handle: "growth", trust: "understand" } },
  { kind: "authority", setup: (f) => f.role(), change: { kind: "authority", handle: "growth", authority: [{ id: "ads", kind: "spend", label: "Google Ads", limit: { usd_per_day: 20 } }] } },
  // The instance row the hire wrote stays, awaiting the host; the lead the hire named goes back.
  { kind: "hire", setup: async (f) => { await f.role(); f.db._tables.org_templates = [TEMPLATE]; }, change: HIRE, kept: { org_template_instances: { fields: { phase: "awaiting_host", version: "1.0.0" }, because: HOST_STEP } } },
  // Until the host runs it, an accepted upgrade is only the acceptance on the row, and that is what the undo withdraws.
  { kind: "upgrade", setup: async (f) => { await f.role(); f.db._tables.org_templates = [TEMPLATE]; await f.apply(HIRE); }, change: { kind: "upgrade", instance: "seo-1", template: "seo", to: "1.1.0", digest: DIGEST } },
  { kind: "routine", setup: (f) => f.apply({ kind: "role", name: "Growth", handle: "growth", seat: { existing: "jx70001" } }), change: { kind: "routine", handle: "growth", title: "Review", prompt: "Review progress", every: "1d" } },
  { kind: "project_meta", change: { kind: "project_meta", project: "pr-1", goal: "Grow", priority: "p1" } },
  { kind: "adopt", setup: (f) => f.role(), change: { kind: "adopt", handle: "growth", conversation: "jx70001" } },
  { kind: "file", change: { kind: "file", plan: "pl-1", project: "pr-1" } },
  { kind: "plan_status", change: { kind: "plan_status", plan: "pl-1", status: "done", reason: "finished" } },
  { kind: "task_status", change: { kind: "task_status", task: "ct-1", status: "done", reason: "finished" } },
  { kind: "project_status", change: { kind: "project_status", project: "pr-1", status: "paused", reason: "waiting" } },
  // The goals (initiatives-projects-role-page.md "I1, revised"): a set goal is cancelled by its undo, never erased; the owner role's scope gain goes back with it.
  { kind: "initiative", setup: (f) => f.role(), change: { kind: "initiative", title: "Reach 1k teams", description: "A thousand teams run an agent every week.", projects: ["pr-1"], owner: "@growth", why: "Teams that run an agent weekly stay.", done_when: "A thousand teams ran an agent in one week.", milestones: [{ title: "Private beta open", date: 1_800_000_000_000 }, { title: "First hundred teams" }], sources: ["call:cl-42#14 our goal is a thousand teams", "jx7c6zk:142"] } },
  { kind: "initiative_projects", change: { kind: "initiative_projects", initiative: "in-1", projects: ["pr-1"] } },
  { kind: "initiative_owner", setup: (f) => f.role(), change: { kind: "initiative_owner", initiative: "Campaign", owner: "@growth" } },
  // Where a goal sits, how it is read and what its record says (I5): the parent, the metrics, the words and each list restore as fields.
  { kind: "initiative_shape", setup: (f) => f.apply({ kind: "initiative", title: "Reach 1k teams", description: "A thousand teams run an agent every week.", projects: ["pr-1"] }), change: { kind: "initiative_shape", initiative: "in-1", parent: "Reach 1k teams", metrics: [{ name: "Campaign signups", target: "500" }], why: "Signups are the first proof.", done_when: "Five hundred people signed up.", milestones: [{ title: "Landing page live" }], sources: ["ct-12"], questions: ["Do we price per seat?"], decisions: ["Ship to brokers first"] } },
];

describe("S21: every change kind round trips through apply, undo and redo", () => {
  test("the table covers every kind the proposal contract names", async () => {
    const { ORG_CHANGE_KINDS } = await import("@codecast/shared/contracts/orgProposal");
    expect([...CASES.map((c) => c.kind)].sort()).toEqual([...ORG_CHANGE_KINDS].sort());
  });
  for (const c of CASES) test(c.kind, async () => {
    const f = fixture();
    await c.setup?.(f);
    const before = orgState(f.db);
    const batches = f.db._tables.org_change_batches?.length ?? 0;
    const rows = f.db._tables.org_changes?.length ?? 0;
    expect((await f.apply(c.change)).status).toBe("applied");
    const applied = orgState(f.db);
    expect(applied).not.toEqual(before);
    expect(f.db._tables.org_change_batches).toHaveLength(batches + 1);
    const batch = f.last();
    const applyRows = f.db._tables.org_changes.slice(rows);
    expect(applyRows.length).toBeGreaterThan(0);
    for (const r of applyRows) expect(orgLogLine({ ...r, at: r.created_at })).toMatch(/\S/);
    // The preview is a dry run: it says what will change and writes nothing.
    const writes = writeCount(f.db);
    const preview = await planUndo(f.ctx(), ME as any, batch);
    expect(preview.preview.refused).toBeUndefined();
    expect(preview.preview.will_change.length).toBeGreaterThan(0);
    for (const r of preview.preview.will_change) expect(orgLogLine(r)).toMatch(/\S/);
    expect(writeCount(f.db)).toBe(writes);
    expect(orgState(f.db)).toEqual(applied);
    // Undo: the state is the snapshot, save the tombstones of what the change made.
    await f.undo(batch);
    const restored = orgState(f.db);
    for (const [id, was] of before) expect({ id, ...restored.get(id) }).toEqual({ id, ...was });
    // An owner row has no tombstone to stand as: the undo takes back every owner the change added.
    expect([...restored].filter(([id, now]) => now.table === "session_owners" && !before.has(id)).map(([id]) => id)).toEqual([]);
    for (const [id, now] of restored) {
      if (before.has(id)) continue;
      const kept = c.kept?.[now.table];
      if (kept) expect({ id, because: kept.because, ...Object.fromEntries(Object.keys(kept.fields).map((k) => [k, now.fields[k]])) }).toEqual({ id, because: kept.because, ...kept.fields });
      else expect({ id, table: now.table, status: now.fields.status }).toEqual({ id, table: now.table, status: TOMBSTONE[now.table] });
    }
    expect(f.db._tables.org_change_batches).toHaveLength(batches + 2);
    const undoBatch = f.last();
    expect((await f.db.get(undoBatch))).toMatchObject({ gesture: "undo", undoes: batch });
    expect((await f.db.get(batch)).undone_by.batch).toBe(undoBatch);
    const undoRows = f.db._tables.org_changes.slice(rows + applyRows.length);
    expect(undoRows.map((r: any) => r.undoes).sort()).toEqual(applyRows.map((r: any) => r._id).sort());
    for (const r of applyRows) expect(undoRows.some((u: any) => u._id === r.undone_by)).toBe(true);
    // Redo: the applied state again, and the log one entry longer still.
    await f.redo(batch);
    expect(orgState(f.db)).toEqual(applied);
    expect(f.db._tables.org_change_batches).toHaveLength(batches + 3);
    expect((await f.db.get(f.last()))).toMatchObject({ gesture: "redo", undoes: undoBatch });
    expect((await f.db.get(batch)).undone_by).toBeUndefined();
    for (const r of applyRows) expect((await f.db.get(r._id)).undone_by).toBeUndefined();
  });
});

describe("S21: the record stays one chain under attack", () => {
  test("a hire is recorded even when its project already has a lead, and its sentence renders both ways", async () => {
    const f = fixture(); const role = await f.role(); f.db._tables.org_templates = [TEMPLATE];
    await f.db.patch("projects_q", { owner_role_id: role._id });
    const batches = f.db._tables.org_change_batches.length;
    await f.apply(HIRE);
    expect(f.db._tables.org_change_batches).toHaveLength(batches + 1);
    const row = f.db._tables.org_changes.at(-1);
    expect(orgLogLine({ ...row, at: 0 })).toBe("Hire @growth from the template seo (1.0.0) to lead Billing");
    expect(orgLogLine(invertRow({ ...row, at: 0 }))).toContain("the instance waits for the host step");
  });
  test("a verb on an undo or redo entry acts on the entry it names, so the chain never forks", async () => {
    const f = fixture(); const role = await f.role();
    await performSetCaps(f.ctx(), ME as any, { role_id: role._id, hands: 8 }); const original = f.last();
    await f.undo(original); const undone = f.last();
    // Undoing the undo is the redo: the original comes off the strike, the undo goes on it.
    expect(await f.undo(undone)).toMatchObject({ changed: 1 });
    expect((await f.db.get(role._id)).caps.hands_per_day).toBe(8);
    expect((await f.db.get(original)).undone_by).toBeUndefined();
    expect((await f.db.get(undone)).undone_by).toBeDefined();
    expect(await f.undo(undone)).toMatchObject({ already_applied: true });
    // The original still answers both verbs from here.
    expect(await f.undo(original)).toMatchObject({ changed: 1 });
    expect((await f.db.get(role._id)).caps.hands_per_day).not.toBe(8);
    expect(await f.redo(original)).toMatchObject({ changed: 1 });
    expect((await f.db.get(role._id)).caps.hands_per_day).toBe(8);
  });
  test("an entry's own undo and redo are its history, never dependents of it", async () => {
    const f = fixture(); const role = await f.role(); const hire = f.last();
    await f.undo(hire); await f.redo(hire);
    expect((await planUndo(f.ctx(), ME as any, hire)).preview.depends).toEqual([]);
    await f.undo(hire);
    expect((await f.db.get(role._id)).status).toBe("retired");
  });
  test("redo after a conflicting later change is refused and the preview names the record", async () => {
    const f = fixture(); const role = await f.role();
    await performSetCaps(f.ctx(), ME as any, { role_id: role._id, hands: 8 }); const batch = f.last();
    await f.undo(batch);
    await performSetCaps(f.ctx(), ME as any, { role_id: role._id, hands: 9 });
    const p = await planUndo(f.ctx(), ME as any, batch);
    expect(p.preview.will_change).toHaveLength(0);
    expect(p.preview.left_alone.map((l) => l.row.skipped)).toEqual(["it changed after this, or is no longer editable by you"]);
    await expect(f.redo(batch)).rejects.toThrow("Nothing can be restored");
    expect((await f.db.get(role._id)).caps.hands_per_day).toBe(9);
  });
  test("a with list may only name the displayed dependents", async () => {
    const f = fixture(); const role = await f.role(); const hire = f.last();
    await f.apply({ kind: "task_status", task: "ct-1", status: "done", reason: "x" }); const other = f.last();
    await expect(f.undo(hire, { with: [other] })).rejects.toThrow("Only the displayed dependent entries");
    expect((await f.db.get("tasks_t")).status).toBe("done");
    expect((await f.db.get(role._id)).status).toBe("active");
  });
  test("an accepted upgrade the host already ran is left alone", async () => {
    const f = fixture(); await f.role(); f.db._tables.org_templates = [TEMPLATE]; await f.apply(HIRE);
    await f.apply({ kind: "upgrade", instance: "seo-1", template: "seo", to: "1.1.0", digest: DIGEST }); const batch = f.last();
    const instance = f.db._tables.org_template_instances[0];
    await f.db.patch(instance._id, { pending_upgrade: undefined, version: "1.1.0", phase: "ready" });
    expect((await planUndo(f.ctx(), ME as any, batch)).preview.left_alone).toHaveLength(1);
    await expect(f.undo(batch)).rejects.toThrow("Nothing can be restored");
    expect((await f.db.get(instance._id)).version).toBe("1.1.0");
  });
});
