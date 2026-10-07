// One Ship control (docs/architecture/ship.md): the facts each target
// gathers, against the fake db. The plan itself is tested on the resolver
// (shared/contracts/shipPlan.test.ts); this pins what feeds it.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { gatherShipFacts, shipParent } from "./ship";
import { resolveShipPlan } from "@codecast/shared/contracts/shipPlan";

const OWNER = "users_owner" as any;
const TEAM = "teams_acme" as any;
const WS = `team:${TEAM}`;
const NOW = 1_800_000_000_000;
const profile = {
  finders: [], default: true, root: "/src/app", changed_at: 1,
  commands: { check: "bun test", prove: null, eval: null, ship: null },
  merge: { auto: false, method: "rebase" },
};

function world(extra: Record<string, any[]> = {}) {
  const db = makeFakeDb({
    users: [{ _id: OWNER, name: "Owner" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    team_memberships: [{ _id: "m1", user_id: OWNER, team_id: TEAM, role: "admin", joined_at: 1 }],
    projects: [{ _id: "projects_p1", user_id: OWNER, team_id: TEAM, workspace: WS, title: "App", short_id: "pr-1", line_profile: profile, created_at: 1, updated_at: 1 }],
    tasks: [{ _id: "tasks_t1", user_id: OWNER, team_id: TEAM, workspace: WS, project_id: "projects_p1", short_id: "ct-7", title: "Fix login", status: "in_review", conversation_ids: ["conversations_old", "conversations_work"], created_at: 1, updated_at: NOW }],
    conversations: [
      { _id: "conversations_old", user_id: OWNER, team_id: TEAM, is_private: false, status: "completed", short_id: "jxold00", title: "Plan", project_path: "/src/app", updated_at: 1, created_at: 1, message_count: 1 },
      { _id: "conversations_work", user_id: OWNER, team_id: TEAM, is_private: false, status: "active", short_id: "jxwork0", title: "Work", git_root: "/src/app", git_branch: "fix-login", git_remote_url: "git@github.com:acme/app.git", active_task_id: "tasks_t1", updated_at: NOW, created_at: 1, message_count: 4 },
    ],
    pull_requests: [],
    pull_request_sessions: [],
    session_decisions: [],
    ...extra,
  });
  return { db } as any;
}

describe("gatherShipFacts", () => {
  test("a task ships from its working session's branch, under its project's profile", async () => {
    const got: any = await gatherShipFacts(world(), OWNER, { kind: "task", id: "ct-7" });
    expect(got.facts).toMatchObject({
      target: { kind: "task", id: "tasks_t1" }, label: "ct-7 Fix login", branch: "fix-login", repository: "acme/app",
      projectPath: "/src/app", taskShortId: "ct-7", sessionShortId: "jxwork0", pr: null, lineGate: null,
      profile: { check: "bun test", ship: null, merge: { auto: false, method: "rebase" } },
    });
    expect(got.work._id).toBe("conversations_work");
  });

  test("a session reaches the PR it already opened, and a PR press merges", async () => {
    const pr = { _id: "pull_requests_p9", team_id: TEAM, repository: "acme/app", number: 9, title: "Fix login", state: "open", head_ref: "fix-login", base_ref: "main", linked_session_ids: ["conversations_work"], updated_at: NOW };
    const ctx = world({ pull_requests: [pr], pull_request_sessions: [{ _id: "prs1", pull_request_id: pr._id, conversation_id: "conversations_work" }] });
    const fromSession: any = await gatherShipFacts(ctx, OWNER, { kind: "conversation", id: "conversations_work" });
    expect(fromSession.facts.pr).toMatchObject({ number: 9, state: "open" });
    expect(resolveShipPlan(fromSession.facts)).toMatchObject({ pr: { action: "shepherd", number: 9 }, merge: { will: false } });
    const fromPr: any = await gatherShipFacts(ctx, OWNER, { kind: "pull_request", id: pr._id });
    expect(fromPr.facts).toMatchObject({ label: "acme/app#9 Fix login", taskShortId: "ct-7", sessionShortId: "jxwork0" });
    expect(resolveShipPlan(fromPr.facts).merge).toMatchObject({ will: true, method: "rebase" });
  });

  test("a line run parked at its change card makes Ship answer the card", async () => {
    const card = { _id: "session_decisions_d1", task_id: "tasks_t1", status: "pending", workflow_run_id: "workflow_runs_r1", card: { recommend: { verdict: "ship" } }, options: [{ label: "[S] Ship" }, { label: "[R] Revise" }, { label: "[D] Drop" }] };
    const got: any = await gatherShipFacts(world({ session_decisions: [card] }), OWNER, { kind: "task", id: "tasks_t1" });
    expect(got.facts.lineGate).toEqual({ decisionId: "session_decisions_d1" });
    expect(resolveShipPlan(got.facts).procedure).toBe("line_gate");
    // Already answered on the web's rail: named, it is still the gate.
    const answered: any = await gatherShipFacts(world({ session_decisions: [{ ...card, status: "answered" }] }), OWNER, { kind: "task", id: "tasks_t1" }, "session_decisions_d1");
    expect(answered.facts.lineGate).toEqual({ decisionId: "session_decisions_d1" });
  });

  test("a task on a role's line carries the role's merge grant, read as the merge step reads it", async () => {
    const role = { _id: "org_roles_rel", handle: "release", status: "active", line_merge: true, authority: [{ id: "merge", kind: "write", label: "Merge", limit: { per_day: 3 }, expires_at: NOW * 2 }] };
    const lineCtx = (r: any) => world({
      org_roles: [r],
      conversations: [
        { _id: "conversations_work", user_id: OWNER, team_id: TEAM, is_private: false, status: "active", short_id: "jxwork0", git_branch: "fix-login", git_root: "/src/app", active_task_id: "tasks_t1", updated_at: NOW, created_at: 1, message_count: 4 },
        { _id: "conversations_seat", user_id: OWNER, team_id: TEAM, is_private: false, status: "active", short_id: "jxseat0", standing_role_id: "org_roles_rel", updated_at: NOW, created_at: 1, message_count: 1 },
      ],
      workflow_runs: [{ _id: "workflow_runs_r1", task_id: "tasks_t1", spawner_conversation_id: "conversations_seat", status: "running", created_at: 1, updated_at: 1, node_statuses: [] }],
    });
    const got: any = await gatherShipFacts(lineCtx(role), OWNER, { kind: "task", id: "ct-7" });
    expect(got.facts.line).toEqual({ runId: "workflow_runs_r1", role: { handle: "release", on: true, allowed: true, reason: null, used: 0, limit: 3 } });
    expect(resolveShipPlan(got.facts).merge).toMatchObject({ will: true, via: "role" });
    const off: any = await gatherShipFacts(lineCtx({ ...role, line_merge: undefined }), OWNER, { kind: "task", id: "ct-7" });
    expect(off.facts.line.role.on).toBe(false);
    expect(resolveShipPlan(off.facts).merge.will).toBe(false);
  });

  test("someone else's task is not found", async () => {
    const got: any = await gatherShipFacts(world(), "users_stranger" as any, { kind: "task", id: "ct-7" });
    expect(got.error).toBe("Task not found");
  });
});

describe("shipParent", () => {
  const ctx = world({
    conversations: [
      { _id: "conversations_top", user_id: OWNER, status: "active", short_id: "jxtop00" },
      { _id: "conversations_worker", user_id: OWNER, status: "active", short_id: "jxwrk00", parent_conversation_id: "conversations_top", is_subagent: true },
      { _id: "conversations_hidden", user_id: OWNER, status: "active", short_id: "jxhid00", parent_conversation_id: "conversations_worker", is_subagent: true, inbox_stashed_at: 1 },
      { _id: "conversations_orphan", user_id: OWNER, status: "active", short_id: "jxorp00", inbox_killed_at: 1 },
    ],
  });
  const get = (id: string) => ctx.db.get(id);
  test("a subagent requester is a parent: a ship run inside a worker tree stays in it", async () => {
    expect((await shipParent(ctx, OWNER, await get("conversations_worker")))?._id).toBe("conversations_worker");
  });
  test("a hidden session hands the run up to its nearest live ancestor", async () => {
    expect((await shipParent(ctx, OWNER, await get("conversations_hidden")))?._id).toBe("conversations_worker");
  });
  test("no live session left: top level", async () => {
    expect(await shipParent(ctx, OWNER, await get("conversations_orphan"))).toBeNull();
    expect(await shipParent(ctx, "users_other" as any, await get("conversations_top"))).toBeNull();
  });
});
