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
    const trigger = f.db._tables.agent_tasks[0];
    await f.undo(batch); expect((await f.db.get(trigger._id)).status).toBe("cancelled");
    await f.redo(batch); expect((await f.db.get(trigger._id)).status).toBe("scheduled");
    expect(f.db._tables.agent_tasks).toHaveLength(1);
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
  test("an initiative owner undo removes only the scope it gained", async () => {
    const { update } = await import("./initiatives");
    const f = fixture(); const role = await f.role();
    const id = await f.db.insert("initiatives", { user_id: ME, team_id: TEAM, workspace: WS, short_id: "in-1", title: "Campaign", project_ids: [P], status: "active" });
    const scope = role.scope;
    await (update as any)._handler(f.ctx(), { id, owner: { kind: "role", role_id: role._id } }); const batch = f.last();
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
  initiatives: ["owner"],
  session_owners: ["conversation_id", "user_id"],
  org_template_instances: ["phase", "role_id", "version", "pending_upgrade"],
};
const TOMBSTONE: Record<string, string> = { org_roles: "retired", projects: "done", agent_tasks: "cancelled", anchors: "decommissioned" };
function orgState(db: any): Map<string, { table: string; fields: Record<string, unknown> }> {
  const out = new Map();
  for (const [table, fields] of Object.entries(ORG_STATE)) for (const row of db._tables[table] ?? []) out.set(String(row._id), { table, fields: Object.fromEntries(fields.map((k) => [k, row[k] ?? null])) });
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
