import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performBriefEdit, performCreateRole, performProvisionRole, performTuneRoutine } from "./orgRoles";
import { listEntries, performUndo } from "./orgChanges";
import { orgLogLine } from "@codecast/shared/contracts/orgChange";
import { BRIEF_BUDGET_CHARS } from "@codecast/shared/contracts/rolePlaybook";
import { triggerRunFrame } from "@codecast/shared/contracts";

// A role tunes its own check (docs/architecture/org-staffing.md S38): inside
// its bounds without a proposal, logged as one org change a person can take
// back, and scoped to its own routine whatever else is armed on its session.

const ME = "u".repeat(31) + "m";
const PEER = "u".repeat(31) + "p";
const TEAM = "teams_acme" as any;
const NOW = Date.now();
const DAY = 86_400_000, HOUR = 3_600_000;

function world() {
  const tables: Record<string, any[]> = {
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: PEER, name: "Peer", email: "peer@x.ai" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: PEER, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    counters: [], org_roles: [], org_role_history: [], org_changes: [], org_change_batches: [], org_proposals: [], org_proposal_changes: [],
    anchors: [], anchor_channels: [], session_commands: [],
    conversations: [
      { _id: "mine", user_id: ME, session_id: "s-mine", short_id: "jxmine1", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 4, team_id: TEAM, project_path: "/repo" },
      { _id: "peers", user_id: PEER, session_id: "s-peer", short_id: "jxpeer1", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 2, team_id: TEAM, project_path: "/repo" },
    ],
    agent_tasks: [], agent_task_revisions: [], pending_messages: [], managed_sessions: [], session_owners: [], messages: [], user_presence: [], devices: [],
    docs: [], projects: [], plans: [], tasks: [], session_decisions: [], decision_inbox: [], decision_grants: [],
  };
  const db = makeFakeDb(tables);
  // One mutation is one ctx: a history entry is what one ctx wrote, so each
  // gesture below gets its own.
  const fresh = (): any => ({ db, scheduler: { runAfter: async () => {} }, auth: { getUserIdentity: async () => ({ subject: ME }) } });
  return { ctx: fresh(), fresh, tables, db };
}

async function lead(ctx: any, tables: Record<string, any[]>) {
  const role = await performCreateRole(ctx, ME as any, { name: "Infra lead", handle: "infra", team_id: TEAM });
  await performProvisionRole(ctx, ME as any, { role_id: String(role._id), adopt_conversation_id: "mine" });
  // Another trigger the person armed on the same session: never the role's to tune.
  tables.agent_tasks.push({ _id: "digest", user_id: ME, title: "Morning digest", prompt: "digest", originating_conversation_id: "mine", schedule_type: "recurring", interval_ms: DAY, status: "scheduled", run_count: 0, retry_count: 0, created_at: 1 });
  const routine = tables.agent_tasks.find((t) => t.schedule_type === "recurring" && t._id !== "digest")!;
  return { role, routine, own: { role_id: String(role._id), from_session: "s-mine" } };
}

describe("a role tunes its own check", () => {
  test("inside the bounds the change applies at once, to its own check alone, with the reason", async () => {
    const { ctx, tables } = world();
    const { routine, own } = await lead(ctx, tables);
    expect(routine.interval_ms).toBe(DAY);

    const result = await performTuneRoutine(ctx, ME as any, { ...own, every: "12h", focus: "the launch queue", why: "sessions land results twice a day until the launch" });
    expect(result.changed.sort()).toEqual(["interval_ms", "role_focus"]);
    expect(result.wake).toMatchObject({ every_ms: 12 * HOUR, focus: "the launch queue", precheck: null, why: "sessions land results twice a day until the launch" });
    expect(routine).toMatchObject({ interval_ms: 12 * HOUR, role_focus: "the launch queue", tune_why: "sessions land results twice a day until the launch", status: "scheduled" });
    expect(routine.tuned_at).toBeGreaterThanOrEqual(NOW);
    expect(Math.abs(routine.run_at - (Date.now() + 12 * HOUR))).toBeLessThan(5_000);
    // The routine's prompt is the product's and did not move; the person's own trigger did not move.
    const digest = tables.agent_tasks.find((t) => t._id === "digest")!;
    expect([digest.interval_ms, digest.role_focus ?? null, digest.tune_why ?? null]).toEqual([DAY, null, null]);
    // One revision of the trigger, so `cast trigger history` shows it.
    expect(tables.agent_task_revisions).toHaveLength(1);
    expect(tables.agent_task_revisions[0].changed_fields).toEqual(expect.arrayContaining(["interval_ms", "role_focus", "tune_why"]));
  });

  test("it is one row in the org log, which reads as what the role did and why", async () => {
    const { ctx, fresh, tables } = world();
    const { own } = await lead(ctx, tables);
    await performTuneRoutine(fresh(), ME as any, { ...own, every: "3d", precheck: "git diff --quiet origin/main -- docs", why: "the area is frozen until the launch" });
    const row = tables.org_changes.at(-1);
    expect(row.kind).toBe("routine_tune");
    expect(row.subject).toMatchObject({ type: "role" });
    expect(row.before.routine).toMatchObject({ every: "1d", precheck: null });
    expect(row.after.routine).toMatchObject({ every: "3d", precheck: "git diff --quiet origin/main -- docs", why: "the area is frozen until the launch" });
    const line = orgLogLine({ ...row, _id: String(row._id), at: row.created_at });
    expect(line).toBe("@infra now runs its check every 3 days instead of every day and runs it only when `git diff --quiet origin/main -- docs` passes. The reason: the area is frozen until the launch");
    const entries = await listEntries(ctx, ME as any, { team_id: TEAM });
    expect(JSON.stringify(entries)).toContain("routine_tune");
  });

  test("outside the bounds it refuses and says to propose it; nothing is written", async () => {
    const { ctx, tables } = world();
    const { routine, own } = await lead(ctx, tables);
    const rows = tables.org_changes.length;
    await expect(performTuneRoutine(ctx, ME as any, { ...own, every: "30m", why: "busy" })).rejects.toThrow(/cast org propose/);
    await expect(performTuneRoutine(ctx, ME as any, { ...own, every: "2w", why: "quiet" })).rejects.toThrow(/outside that/);
    await expect(performTuneRoutine(ctx, ME as any, { ...own, every: "soon", why: "x" })).rejects.toThrow(/not a cadence/);
    expect(routine.interval_ms).toBe(DAY);
    expect(tables.org_changes).toHaveLength(rows);
    expect(tables.agent_task_revisions).toHaveLength(0);
  });

  test("it needs a reason and a change", async () => {
    const { ctx, tables } = world();
    const { own } = await lead(ctx, tables);
    await expect(performTuneRoutine(ctx, ME as any, { ...own, every: "12h", why: "  " })).rejects.toThrow(/Say why/);
    await expect(performTuneRoutine(ctx, ME as any, { ...own, every: "1d", why: "no change" })).rejects.toThrow(/already runs that way/);
    await expect(performTuneRoutine(ctx, ME as any, { ...own, focus: "x".repeat(601), why: "long" })).rejects.toThrow(/keep it under 600/);
  });

  test("a tune from inside the check's own run is taken, and the run's slot is left alone", async () => {
    const { ctx, tables } = world();
    const { routine, own } = await lead(ctx, tables);
    const slot = routine.run_at;
    routine.status = "running";
    await performTuneRoutine(ctx, ME as any, { ...own, every: "2d", why: "nothing has moved on the last ten checks" });
    expect(routine).toMatchObject({ status: "running", interval_ms: 2 * DAY, run_at: slot });
  });

  test("a member who does not run the role's session and cannot admin it may not tune it", async () => {
    const { ctx, tables } = world();
    const { role, routine } = await lead(ctx, tables);
    await expect(performTuneRoutine(ctx, PEER as any, { role_id: String(role._id), from_session: "s-peer", every: "12h", why: "mine now" })).rejects.toThrow(/Only the role's own session or an admin/);
    expect(routine.interval_ms).toBe(DAY);
  });

  test("a person takes it back from history, and brings it back again", async () => {
    const { ctx, fresh, tables } = world();
    const { routine, own } = await lead(ctx, tables);
    await performTuneRoutine(fresh(), ME as any, { ...own, every: "12h", focus: "the launch queue", why: "launch week" });
    const batch = String(tables.org_change_batches.at(-1)._id);
    expect(tables.org_change_batches.at(-1)).toMatchObject({ door: "cli", gesture: "command", row_count: 1 });

    await performUndo(fresh(), ME as any, { batch });
    expect(routine.interval_ms).toBe(DAY);
    expect(routine.role_focus ?? null).toBeNull();
    expect(routine.tune_why ?? null).toBeNull();
    expect(routine.tuned_at ?? null).toBeNull();
    expect(Math.abs(routine.run_at - (Date.now() + DAY))).toBeLessThan(5_000);
    const back = tables.org_changes.at(-1);
    expect(back.kind).toBe("routine_tune");
    expect(orgLogLine({ ...back, _id: String(back._id), at: back.created_at, inverse: true })).toBe("@infra goes back to running its check every day and drops its focus");

    await performUndo(fresh(), ME as any, { batch }, true);
    expect(routine).toMatchObject({ interval_ms: 12 * HOUR, role_focus: "the launch queue", tune_why: "launch week" });
  });
});

describe("outside the bounds, through a proposal", () => {
  test("an accepted routine change that names the role's own check changes that check, and arms no second one", async () => {
    const { applyOrgChange } = await import("./orgInit");
    const { ctx, fresh, tables } = world();
    const { routine } = await lead(ctx, tables);
    const recurring = () => tables.agent_tasks.filter((t) => t.schedule_type === "recurring").length;
    const had = recurring();
    const result = await applyOrgChange(fresh(), ME as any, { team_id: TEAM }, { kind: "routine", handle: "infra", title: routine.title, prompt: "unused: the check keeps its prompt", every: "14d" } as any, { provision: false, human_decision: "sd-1" } as any);
    expect(result.status).toBe("applied");
    expect(recurring()).toBe(had);
    expect(routine).toMatchObject({ interval_ms: 14 * DAY, tune_why: "a person accepted this as a routine change" });
    expect(routine.prompt).not.toContain("unused");
    // The proposal's row keeps the proposal's kind; it reads as the retune it was.
    const row = tables.org_changes.at(-1);
    expect(orgLogLine({ ...row, _id: String(row._id), at: row.created_at })).toBe("@infra now runs its check every 14 days instead of every day. The reason: a person accepted this as a routine change");
    // Any other title is a new routine, as before.
    await applyOrgChange(fresh(), ME as any, { team_id: TEAM }, { kind: "routine", handle: "infra", title: "Weekly link check", prompt: "Check every link.", every: "7d" } as any, { provision: false, human_decision: "sd-2" } as any);
    expect(recurring()).toBe(had + 1);
  });
});

describe("the wake frame carries the role's focus", () => {
  const role = { handle: "infra", name: "Infra lead", reports_to: "Me", scope: [], charter: "", goals: [] } as any;
  const task = { _id: "t1", short_id: "tr-1", title: "Check Infra lead's area", prompt: "Check your area.", role_id: "r1" };
  test("after the routine's prompt, and only when the role set one", () => {
    const plain = triggerRunFrame(task, { role, stashed: false });
    expect(plain).not.toContain("Your focus for this check");
    const focused = triggerRunFrame({ ...task, role_focus: "the launch queue" }, { role, stashed: false });
    expect(focused.indexOf("Check your area.")).toBeLessThan(focused.indexOf("Your focus for this check"));
    expect(focused).toContain(": the launch queue");
    expect(triggerRunFrame({ ...task, role_focus: null }, { role, stashed: false })).toBe(plain);
  });
});

describe("the brief's budget", () => {
  test("the role's own save over the budget is refused with the reason; a person's edit is not capped", async () => {
    const { ctx, tables } = world();
    const { own, role } = await lead(ctx, tables);
    const over = `Infra: steady\n\n## Rules learned\n${"- A rule. Learned from: a mistake. (2026-10-01)\n".repeat(Math.ceil(BRIEF_BUDGET_CHARS / 40))}`;
    await expect(performBriefEdit(ctx, ME as any, { ...own, content: over })).rejects.toThrow(/over its budget, so it was not saved/);
    const saved = await performBriefEdit(ctx, ME as any, { ...own, content: "Infra: steady\n\n## Rules learned\n- A rule. Learned from: a mistake. (2026-10-01)" });
    expect(saved.brief_doc_id).toBeTruthy();
    await expect(performBriefEdit(ctx, ME as any, { role_id: String(role._id), content: over })).resolves.toBeTruthy();
  });
});
