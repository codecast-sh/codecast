import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateRole, performReparentRole, performSetRoleScope, performUpdateRole } from "./orgRoles";
import { computeScopeFeed, computeScopeSummary, resolveScope, decodeFeedCursor } from "./org";

// Scopes and the scope feed (docs/architecture/scopes-and-feed.md F1, F2): the
// containment and overlap rules on a role's scope, and one feed over every
// source inside it, merged newest first with a cursor per source.

const ME = "u".repeat(31) + "m"; // team admin, caller
const MATE = "u".repeat(31) + "t";
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000;

const P = "projects_p";
const Q = "projects_q";
const PLAN = "plans_pl1";
const T1 = "tasks_t1";
const T2 = "tasks_t2";
const S1 = "conversations_s1";
const S2 = "conversations_s2";

function fixtures(extra: Record<string, any[]> = {}) {
  return makeFakeDb({
    users: [
      { _id: ME, name: "Me", email: "me@x.ai" },
      { _id: MATE, name: "Mate", email: "mate@x.ai" },
    ],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [],
    org_roles: [],
    org_role_history: [],
    projects: [
      { _id: P, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-1", title: "Growth", status: "active", project_path: "/repo/growth", created_at: 1, updated_at: NOW - 10 * H },
      { _id: Q, user_id: ME, team_id: TEAM, workspace: WS, short_id: "pr-2", title: "Billing", status: "active", project_path: "/repo/billing", created_at: 1, updated_at: NOW - 10 * H },
    ],
    plans: [
      // The plan belongs to project P but is not listed in any scope itself.
      { _id: PLAN, user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: "pl-1", title: "Launch", status: "active", goal: "Ship it", created_at: 1, updated_at: NOW - 3 * H },
    ],
    tasks: [
      { _id: T1, user_id: ME, team_id: TEAM, workspace: WS, project_id: P, short_id: "ct-1", title: "Write the landing page", task_type: "task", status: "in_progress", priority: "high", description: "copy and hero", created_at: 1, updated_at: NOW - 1 * H },
      // In scope only through its plan, whose project is in scope.
      { _id: T2, user_id: ME, team_id: TEAM, workspace: WS, plan_id: PLAN, short_id: "ct-2", title: "Wire analytics", task_type: "task", status: "open", priority: "medium", created_at: 1, updated_at: NOW - 5 * H },
      { _id: "tasks_t3", user_id: ME, team_id: TEAM, workspace: WS, project_id: Q, short_id: "ct-3", title: "Billing task", task_type: "task", status: "open", priority: "low", created_at: 1, updated_at: NOW - 2 * H },
    ],
    docs: [
      { _id: "docs_d1", user_id: ME, team_id: TEAM, workspace: WS, project_id: P, title: "Launch notes", content: "# Launch notes\nthe body", doc_type: "note", created_at: 1, updated_at: NOW - 4 * H },
    ],
    conversations: [
      // In scope by project_path.
      { _id: S1, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude", title: "Growth session", short_id: "jx1", project_path: "/repo/growth", git_remote_url: "git@github.com:acme/growth.git", updated_at: NOW - 2 * H, created_at: 1, message_count: 3 },
      // Out of scope: another project's path, no binding.
      { _id: S2, user_id: ME, team_id: TEAM, status: "active", agent_type: "claude", title: "Billing session", short_id: "jx2", project_path: "/repo/billing", updated_at: NOW - 1 * H, created_at: 1, message_count: 3 },
    ],
    session_decisions: [
      { _id: "sd1", conversation_id: S1, session_id: "s1", user_id: ME, short_id: "sd-1", question: "Blue or green?", options: [{ label: "Blue" }, { label: "Green" }], blocking: true, status: "pending", task_id: T1, created_at: NOW - 6 * H },
    ],
    project_updates: [
      { _id: "pu1", project_id: P, short_id: "pu-1", user_id: ME, author: "Me", author_user_id: ME, author_kind: "user", kind: "update", body: "Landing page is up", created_at: NOW - 7 * H, updated_at: NOW - 7 * H },
    ],
    commits: [
      { _id: "cm1", sha: "abcdef1234567", message: "feat: hero\n\nbody", author_name: "Me", author_email: "me@x.ai", timestamp: NOW - 8 * H, files_changed: 2, insertions: 10, deletions: 1, repository: "acme/growth", branch: "main" },
      { _id: "cm2", sha: "0123456789abc", message: "old commit", author_name: "Me", author_email: "me@x.ai", timestamp: NOW - 20 * 24 * H, files_changed: 1, insertions: 1, deletions: 1, repository: "acme/growth", branch: "main" },
    ],
    artifacts: [
      { _id: "art1", slug: "x1", user_id: ME, title: "Launch report", storage_id: "st1", size: 1, version: 2, kind: "html", session_short_id: "jx1", session_conversation_id: S1, created_at: 1, updated_at: NOW - 9 * H },
    ],
    conversation_images: [],
    session_owners: [],
    managed_sessions: [],
    messages: [],
    user_presence: [],
    ...extra,
  });
}

// A signed in human: scope edits refuse anonymous callers (refuseUnlessHuman).
const ctxOf = (db: any) => ({ db, auth: { getUserIdentity: async () => ({ subject: String(ME) }) } }) as any;

async function roleWithScope(db: any, handle: string, scope: { project_ids: any[]; plan_ids: any[] }, reports_to?: any) {
  return performCreateRole(ctxOf(db), ME as any, { name: handle, handle, team_id: TEAM, scope, reports_to });
}

describe("F1 scope rules", () => {
  test("a child's scope must sit inside its parent's, unless the parent owns the whole workspace", async () => {
    const db = fixtures();
    const parent = await roleWithScope(db, "growth", { project_ids: [P], plan_ids: [] });
    const child = await roleWithScope(db, "landing", { project_ids: [], plan_ids: [] }, { kind: "role", role_id: parent._id });
    // The plan of P is inside P.
    const ok = await performUpdateRole(ctxOf(db), ME as any, { role_id: child.short_id, scope: { project_ids: [], plan_ids: [PLAN as any] } });
    expect(ok.scope.plan_ids).toEqual([PLAN]);
    await expect(
      performUpdateRole(ctxOf(db), ME as any, { role_id: child.short_id, scope: { project_ids: [Q as any], plan_ids: [] } }),
    ).rejects.toThrow(/Outside the scope of @growth.*project Billing/);
    // A root role (whole workspace) contains anything.
    const root = await roleWithScope(db, "root", { project_ids: [], plan_ids: [] });
    const under = await roleWithScope(db, "billing", { project_ids: [Q], plan_ids: [] }, { kind: "role", role_id: root._id });
    expect(under.scope.project_ids).toEqual([Q]);
  });

  test("narrowing a parent below a child's scope is refused, and a move must fit the new parent", async () => {
    const db = fixtures();
    const parent = await roleWithScope(db, "growth", { project_ids: [P, Q], plan_ids: [] });
    await roleWithScope(db, "billing", { project_ids: [Q], plan_ids: [] }, { kind: "role", role_id: parent._id });
    await expect(
      performUpdateRole(ctxOf(db), ME as any, { role_id: parent.short_id, scope: { project_ids: [P as any], plan_ids: [] } }),
    ).rejects.toThrow(/Narrow @billing first/);
    const other = await roleWithScope(db, "other", { project_ids: [P], plan_ids: [] });
    const billing = (await db.query("org_roles").withIndex("by_team_handle", (q: any) => q.eq("team_id", TEAM).eq("handle", "billing")).first())!;
    await expect(
      performReparentRole(ctxOf(db), ME as any, { role_id: billing.short_id, reports_to: { kind: "role", role_id: other._id } }),
    ).rejects.toThrow(/Outside the scope of @other/);
  });

  test("sibling overlap is allowed and reported; the edit is logged; a plan under a listed project folds into it", async () => {
    const db = fixtures();
    const a = await roleWithScope(db, "aa", { project_ids: [P], plan_ids: [] });
    const b = await roleWithScope(db, "bb", { project_ids: [], plan_ids: [] });
    const updated = await performUpdateRole(ctxOf(db), ME as any, { role_id: b.short_id, scope: { project_ids: [P as any], plan_ids: [PLAN as any] } });
    // PLAN belongs to P, so listing both is the scope "P".
    expect(updated.scope).toEqual({ project_ids: [P], plan_ids: [] });
    expect(updated.overlaps).toEqual([{ role_id: a._id, short_id: a.short_id, handle: "aa", name: "aa", project_ids: [P], plan_ids: [] }]);
    const log = await db.query("org_role_history").withIndex("by_role", (q: any) => q.eq("role_id", b._id)).collect();
    expect(log).toHaveLength(1);
    expect(log[0].actor_type).toBe("user");
    expect(JSON.parse(log[0].old_value)).toEqual({ project_ids: [], plan_ids: [] });
    expect(JSON.parse(log[0].new_value)).toEqual({ project_ids: [P], plan_ids: [] });
  });

  test("scope edits are human only, and `cast role scope` resolves refs by short id and title", async () => {
    const db = fixtures();
    const role = await roleWithScope(db, "growth", { project_ids: [], plan_ids: [] });
    await expect(
      performUpdateRole(ctxOf(db), ME as any, { role_id: role.short_id, scope: { project_ids: [P as any], plan_ids: [] }, from_session: "jx9" }),
    ).rejects.toThrow(/human only/);
    const added = await performSetRoleScope(ctxOf(db), ME as any, { role_id: "@growth" === "@growth" ? role.short_id : "", add: ["project:pr-1", "plan:pl-1", "project:Billing"] });
    expect(added.scope).toEqual({ project_ids: [P, Q], plan_ids: [] });
    const removed = await performSetRoleScope(ctxOf(db), ME as any, { role_id: role.short_id, remove: ["project:pr-2"] });
    expect(removed.scope).toEqual({ project_ids: [P], plan_ids: [] });
    await expect(performSetRoleScope(ctxOf(db), ME as any, { role_id: role.short_id, add: ["project:nope"] })).rejects.toThrow(/No project "nope"/);
    await expect(performSetRoleScope(ctxOf(db), ME as any, { role_id: role.short_id, add: ["pr-1"] })).rejects.toThrow(/project:<ref> or plan:<ref>/);
  });
});

describe("F2 org.scopeFeed", () => {
  async function scoped(db: any) {
    const role = await roleWithScope(db, "growth", { project_ids: [P], plan_ids: [] });
    const resolved = (await resolveScope(ctxOf(db), ME as any, { role_id: role.short_id }))!;
    return { role, resolved };
  }

  test("a role scoped to one project sees rows from every source, merged newest first", async () => {
    const db = fixtures();
    const { resolved } = await scoped(db);
    const { rows, next_cursor } = await computeScopeFeed(ctxOf(db), resolved, { now: NOW });
    expect(next_cursor).toBeUndefined();
    expect(rows.map((r) => `${r.kind}:${r.short_id ?? r.id}`)).toEqual([
      "task:ct-1", // -1h
      "session:jx1", // -2h by project_path
      "plan:pl-1", // -3h by project
      "doc:docs_d1", // -4h
      "task:ct-2", // -5h through the plan
      "decision:sd-1", // -6h on ct-1
      "update:pu-1", // -7h
      "commit:abcdef1", // -8h, repo of the session in scope; the 20 day old one is outside the window
      "artifact:x1", // -9h, page published by the session in scope
    ]);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].updated_at).toBeGreaterThanOrEqual(rows[i].updated_at);
    // The out-of-scope session and task never appear.
    expect(rows.some((r) => r.id === S2 || r.short_id === "ct-3")).toBe(false);
    // Shapes.
    const task = rows.find((r) => r.kind === "task")!;
    expect(task).toMatchObject({ href: "/tasks/ct-1", state: "in_progress", preview: "copy and hero" });
    expect(rows.find((r) => r.kind === "session")).toMatchObject({ href: "/conversation/jx1", actor: { name: "Me" } });
    expect(rows.find((r) => r.kind === "plan")).toMatchObject({ href: "/plans/pl-1", state: "active", preview: "Ship it" });
    expect(rows.find((r) => r.kind === "doc")).toMatchObject({ href: "/docs/docs_d1", title: "Launch notes", state: "note" });
    expect(rows.find((r) => r.kind === "decision")).toMatchObject({ href: `/questions?s=${S1}`, state: "pending", title: "Blue or green?" });
    expect(rows.find((r) => r.kind === "update")).toMatchObject({ href: `/projects/${P}?tab=updates`, actor: { name: "Me" } });
    expect(rows.find((r) => r.kind === "commit")).toMatchObject({ href: "/commit/acme/growth/abcdef1234567", title: "feat: hero", state: "main" });
    expect(rows.find((r) => r.kind === "artifact")).toMatchObject({ href: "/a/x1", state: "html" });
  });

  test("the cursor continues each source from where the last page left it, with no gaps or repeats", async () => {
    const db = fixtures();
    const { resolved } = await scoped(db);
    const all = (await computeScopeFeed(ctxOf(db), resolved, { now: NOW })).rows.map((r) => r.id);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const page = await computeScopeFeed(ctxOf(db), resolved, { now: NOW, limit: 4, cursor });
      seen.push(...page.rows.map((r) => r.id));
      if (!page.next_cursor) break;
      // The cursor names a position per source that has emitted rows.
      const decoded = decodeFeedCursor(page.next_cursor);
      expect(Object.keys(decoded).length).toBeGreaterThan(0);
      cursor = page.next_cursor;
    }
    expect(seen).toEqual(all);
  });

  test("kinds narrow the sources read", async () => {
    const db = fixtures();
    const { resolved } = await scoped(db);
    const { rows } = await computeScopeFeed(ctxOf(db), resolved, { now: NOW, kinds: ["task", "session"] });
    expect(rows.map((r) => r.kind)).toEqual(["task", "session", "task"]);
  });

  test("an explicit scope works without a role, and a session bound to a task in scope is in scope", async () => {
    const db = fixtures({
      conversations: [
        { _id: "conversations_s3", user_id: ME, team_id: TEAM, status: "active", agent_type: "claude", title: "Bound", short_id: "jx3", project_path: "/elsewhere", active_task_id: T2, updated_at: NOW - H / 2, created_at: 1, message_count: 1 },
      ],
    });
    const resolved = (await resolveScope(ctxOf(db), ME as any, { scope: { project_ids: [], plan_ids: [PLAN as any] }, team_id: TEAM }))!;
    expect(resolved.tasks.map((t) => t.short_id)).toEqual(["ct-2"]);
    const { rows } = await computeScopeFeed(ctxOf(db), resolved, { now: NOW, kinds: ["session"] });
    expect(rows.map((r) => r.short_id)).toEqual(["jx3"]);
  });

  test("a session image gives the row a thumbnail", async () => {
    const db = fixtures({
      conversation_images: [{ _id: "ci1", conversation_id: S1, image_key: "k", src: "https://img/1.png", message_id: "msg1", seq: 0, timestamp: NOW - H }],
    });
    const { resolved } = await scoped(db);
    const { rows } = await computeScopeFeed(ctxOf(db), resolved, { now: NOW, kinds: ["session"] });
    expect(rows[0].image_url).toBe("https://img/1.png");
  });
});

describe("org.scopeSummary", () => {
  test("counts what the board line needs", async () => {
    const db = fixtures();
    const a = await roleWithScope(db, "growth", { project_ids: [P], plan_ids: [] });
    await roleWithScope(db, "twin", { project_ids: [P], plan_ids: [] });
    const resolved = (await resolveScope(ctxOf(db), ME as any, { role_id: a.short_id }))!;
    const s = await computeScopeSummary(ctxOf(db), resolved, NOW);
    expect(s.tasks).toEqual({
      total: 2,
      open: 2,
      by_status: { backlog: 0, open: 1, in_progress: 1, in_review: 0, done: 0, dropped: 0 },
      by_priority: { urgent: 0, high: 1, medium: 1, low: 0, none: 0 },
    });
    expect(s.plans).toEqual([{ id: PLAN, short_id: "pl-1", title: "Launch", status: "active", updated_at: NOW - 3 * H, progress: { total: 1, done: 0, in_progress: 0, open: 1 } }]);
    expect(s.sessions.total).toBe(1);
    expect(s.decisions).toEqual({ open: 1, answered: 0 });
    expect(s.overlaps.map((o) => o.handle)).toEqual(["twin"]);
    expect(s.projects).toEqual([{ id: P, title: "Growth", short_id: "pr-1", project_path: "/repo/growth" }]);
  });
});
