import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { applyCancel, applyPause } from "./agentTasks";
import { briefingFor, performRebriefRoles } from "./anchors";
import { charterTemplate, ensureRoleRoutine, performCreateRole, performPauseRole, performProvisionRole, performResetOrg, performReparentRole, performResumeRole, performRetireRole, performStaff, resetOrgPreview, seatingNote, standingConversationOf } from "./orgRoles";
import { ROLE_CHECK_PROMPT } from "./lib/orgRoutine";
import { performReparentSession } from "./sessionOwnership";
import { killConversation } from "./conversations";
import { applyHideTransition } from "./cleanup";
import { isBootstrapPrompt, isSessionMessage } from "@codecast/shared/contracts";

// A role's lifecycle a person can trust (docs/architecture/org-staffing.md
// S25 to S28): pause and resume touch only the triggers the role paused, a
// cancelled routine stays cancelled, a reset clears the org, a retire takes
// its sessions' open decisions with them, and what lands in a thread reads as
// plain words.

const ME = "u".repeat(31) + "m";
const PEER = "u".repeat(31) + "p";
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;

function world(extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: PEER, name: "Peer", email: "peer@x.ai" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: PEER, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    counters: [],
    org_roles: [],
    org_role_history: [],
    org_changes: [],
    org_proposals: [],
    org_proposal_changes: [],
    anchors: [],
    anchor_channels: [],
    session_commands: [],
    conversations: [
      { _id: "mine", user_id: ME, session_id: "s-mine", short_id: "jxmine1", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 4, team_id: TEAM, project_path: "/repo" },
      { _id: "work1", user_id: ME, session_id: "s-work", short_id: "jxwork1", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 2, team_id: TEAM, project_path: "/repo" },
    ],
    agent_tasks: [],
    pending_messages: [],
    managed_sessions: [],
    session_owners: [],
    messages: [],
    user_presence: [],
    devices: [],
    docs: [],
    projects: [],
    plans: [],
    tasks: [],
    session_decisions: [],
    decision_inbox: [],
    decision_grants: [],
    ...extra,
  };
  const db = makeFakeDb(tables);
  const scheduled: any[] = [];
  const ctx: any = { db, scheduler: { runAfter: async (delay: number, _fn: any, args: any) => { scheduled.push({ delay, args }); } } };
  return { ctx, tables, scheduled };
}

async function lead(ctx: any, over: Record<string, any> = {}) {
  const role = await performCreateRole(ctx, ME as any, { name: "Infra lead", handle: "infra", team_id: TEAM, ...over });
  await performProvisionRole(ctx, ME as any, { role_id: String(role._id), adopt_conversation_id: "mine" });
  return role;
}

describe("pause and resume", () => {
  test("resume brings back only the triggers the role's pause paused, never one the person paused by hand", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    tables.agent_tasks.push({ _id: "digest", user_id: ME, title: "Morning digest", prompt: "digest", originating_conversation_id: "mine", schedule_type: "recurring", interval_ms: 86_400_000, status: "scheduled", run_count: 0, retry_count: 0, created_at: 1 });
    const task = (id: string) => tables.agent_tasks.find((t) => t._id === id)!;
    const routine = tables.agent_tasks.find((t) => t.schedule_type === "recurring" && t._id !== "digest")!;
    const needsInput = tables.agent_tasks.find((t) => t.schedule_type === "event")!;
    // The person pauses the route up by hand, before the role is paused.
    await applyPause(ctx, needsInput);

    await performPauseRole(ctx, ME as any, { role_id: String(role._id) });
    expect([routine.status, task("digest").status, needsInput.status]).toEqual(["paused", "paused", "paused"]);
    expect(String(routine.paused_by_role_id)).toBe(String(role._id));
    expect(needsInput.paused_by_role_id).toBeUndefined();

    await performResumeRole(ctx, ME as any, { role_id: String(role._id) });
    expect([routine.status, task("digest").status]).toEqual(["scheduled", "scheduled"]);
    expect(needsInput.status).toBe("paused");
    expect(routine.paused_by_role_id).toBeUndefined();
  });
});

describe("the role's routine", () => {
  test("a routine the person cancelled never comes back, whatever arms the role again", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    const routine = tables.agent_tasks.find((t) => t.schedule_type === "recurring")!;
    await applyCancel(ctx, routine);
    expect(routine.status).not.toBe("scheduled");
    const fresh = tables.org_roles.find((r) => String(r._id) === String(role._id))!;
    const again = await ensureRoleRoutine(ctx, fresh, await standingConversationOf(ctx, fresh));
    expect(again.created).toBe(false);
    expect(String(again.id)).toBe(String(routine._id));
    expect(tables.agent_tasks.filter((t) => t.schedule_type === "recurring")).toHaveLength(1);
    expect(routine.status).not.toBe("scheduled");
  });

  test("a new role in a session an earlier role used still gets its own routine", async () => {
    const { ctx, tables } = world();
    const first = await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "jxmine1" });
    await performRetireRole(ctx, ME as any, { role_id: String(first.role._id), standing_session: "keep" });
    const second = await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "jxmine1" });
    const live = tables.agent_tasks.filter((t) => t.schedule_type === "recurring" && t.status === "scheduled");
    expect(live).toHaveLength(1);
    expect(String(live[0].role_id)).toBe(String(second.role._id));
  });

  test("the routine prompt names no switch and no grants", () => {
    expect(ROLE_CHECK_PROMPT).not.toMatch(/switch|grants/);
  });
});

describe("org reset (S27)", () => {
  test("retires every role with its session and triggers, returns the sessions under them, archives every proposal", async () => {
    const { ctx, tables } = world({
      org_proposals: [
        { _id: "op_open", short_id: "op-1", team_id: TEAM, author: { kind: "user", id: ME }, created_by: ME, title: "Open", summary_md: "x", mode: "review", status: "open", created_at: 1, updated_at: 1 },
        { _id: "op_done", short_id: "op-2", team_id: TEAM, author: { kind: "user", id: ME }, created_by: ME, title: "Done", summary_md: "x", mode: "review", status: "accepted", created_at: 1, updated_at: 1 },
      ],
    });
    const head = await performStaff(ctx, ME as any, { team_id: TEAM });
    const role = await lead(ctx, { reports_to: { kind: "role", role_id: head.role._id } });
    tables.conversations.find((c) => c._id === "work1")!.org_role_id = role._id;

    const preview = await resetOrgPreview(ctx, ME as any, { team_id: TEAM });
    expect(preview.roles.map((r) => r.handle).sort()).toEqual(["head-of-people", "infra"]);
    expect(preview.roles.find((r) => r.handle === "infra")!.sessions).toBe(1);
    expect(preview.proposals).toBe(2);
    expect(tables.org_roles.every((r) => r.status === "active")).toBe(true);

    const out = await performResetOrg(ctx, ME as any, { team_id: TEAM });
    expect(out.roles).toHaveLength(2);
    expect(out.sessions_returned).toBe(1);
    expect(out.proposals_archived).toBe(2);
    expect(tables.org_roles.every((r) => r.status === "retired")).toBe(true);
    expect(tables.anchors.every((a) => a.status === "decommissioned")).toBe(true);
    expect(tables.agent_tasks.every((t) => t.status === "cancelled")).toBe(true);
    // The session under the lead goes back to its owner, not up to the Head of People.
    expect(tables.conversations.find((c) => c._id === "work1")!.org_role_id).toBeUndefined();
    expect(tables.conversations.some((c) => c.standing_role_id)).toBe(false);
    expect(tables.org_proposals.every((p) => p.archived_at)).toBe(true);
    expect(tables.org_proposals.find((p) => p._id === "op_open")!.status).toBe("withdrawn");
  });

  test("only a team admin may reset the team's org", async () => {
    const { ctx, tables } = world();
    await lead(ctx);
    await expect(performResetOrg(ctx, PEER as any, { team_id: TEAM })).rejects.toThrow("Only a team admin");
    expect(tables.org_roles[0].status).toBe("active");
  });
});

describe("retire", () => {
  test("an open decision of a session under the role leaves the retired role's route", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    tables.conversations.find((c) => c._id === "work1")!.org_role_id = role._id;
    tables.session_decisions.push({ _id: "sd1", short_id: "sd-1", conversation_id: "work1", status: "pending", question: "Ship?", options: [], asked_user_ids: [], ladder: [{ kind: "role", role_id: role._id }], holder: { kind: "role", role_id: role._id }, created_at: NOW });
    await performRetireRole(ctx, ME as any, { role_id: String(role._id) });
    const decision = tables.session_decisions[0];
    expect(decision.asked_user_ids.map(String)).toEqual([ME]);
    expect(tables.decision_inbox.map((r) => String(r.user_id))).toEqual([ME]);
    expect(JSON.stringify(decision.holder ?? null)).not.toContain(String(role._id));
  });
});

describe("what a person and a role read", () => {
  test("a role with no scope is never told the workspace is its own; the Head of People is", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    const opening = tables.pending_messages.map((p) => String(p.content)).find((c) => isBootstrapPrompt(c))!;
    expect(opening).toContain("You look after no area of your own");
    expect(opening).not.toMatch(/whole workspace|You own/);
    expect(charterTemplate(role, [], "Me")).toContain("- no area of its own");
    expect(charterTemplate(role, [], "Me")).not.toContain("whole workspace");
    expect(charterTemplate({ name: "Head of People", handle: "head-of-people" }, [], "Me")).toContain("- the whole workspace");
    expect(charterTemplate(role, ["project Infra"], "Me")).toContain("looks after the work in its area");
  });

  test("a rebrief sends a role its role opening, and the sweep reaches every live role once", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    const anchor = tables.anchors[0];
    const briefing = await briefingFor(ctx, anchor);
    expect(briefing).toContain("You are the **Infra lead** (@infra)");
    expect(briefing).not.toContain("workspace's standing agent");
    expect(briefing).not.toContain("cast escalate");

    const retired = await performCreateRole(ctx, ME as any, { name: "Old", handle: "old", team_id: TEAM });
    await performRetireRole(ctx, ME as any, { role_id: String(retired._id) });
    const before = tables.pending_messages.length;
    expect((await performRebriefRoles(ctx, { dry_run: true })).sent.map((s) => s.handle)).toEqual(["infra"]);
    expect(tables.pending_messages).toHaveLength(before);
    const out = await performRebriefRoles(ctx, {});
    expect(out.sent).toEqual([{ role: role.short_id, handle: "infra", conversation: "jxmine1" }]);
    expect(tables.pending_messages).toHaveLength(before + 1);
    expect(tables.pending_messages.at(-1)!.content).toBe(briefing);
    // The same sweep again sends nothing new while the first still waits.
    await performRebriefRoles(ctx, {});
    expect(tables.pending_messages).toHaveLength(before + 1);
  });

  test("a sub-lead is told to write to the role it reports to", async () => {
    const { ctx, tables } = world();
    const top = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    await lead(ctx, { reports_to: { kind: "role", role_id: top._id } });
    expect(await briefingFor(ctx, tables.anchors[0])).toContain("cast role wake @growth");
  });

  test("pause and retire reach a live session under the role as a plain message from the person, with no tag and no role id", async () => {
    const { ctx, tables } = world({ managed_sessions: [{ _id: "ms1", conversation_id: "work1", agent_status: "working", last_heartbeat: NOW }] });
    const role = await lead(ctx);
    tables.conversations.find((c) => c._id === "work1")!.org_role_id = role._id;
    const paused = await performPauseRole(ctx, ME as any, { role_id: String(role._id) });
    expect(paused.interrupted).toBe(1);
    await performRetireRole(ctx, ME as any, { role_id: String(role._id) });
    const notes = tables.pending_messages.filter((p) => p.conversation_id === "work1").map((p) => String(p.content));
    expect(notes).toHaveLength(2);
    for (const note of notes) {
      expect(isSessionMessage(note)).toBe(true);
      expect(note).toContain('name="Me"');
      expect(note).not.toMatch(/<role-|or-\d/);
    }
  });

  test("the new role's brief and the seating note carry no frame and no role id in their words", async () => {
    const { ctx, tables } = world();
    await lead(ctx);
    const brief = tables.docs.find((d) => d.doc_type === "brief")!;
    expect(brief.content).not.toMatch(/frame|provisioned/);
    const note = seatingNote({ short_id: "or-7", handle: "head-of-people", name: "Head of People" }, "Acme");
    expect(note.replace(/https?:\S+/g, "")).not.toMatch(/or-7|seat/);
  });
});

describe("a role's own session belongs to whom the role reports to (S28)", () => {
  const owners = (tables: Record<string, any[]>, id: string) => tables.session_owners.filter((r) => String(r.conversation_id) === id).map((r) => String(r.user_id));
  test("seated under a person it is that person's; moved under a role it is nobody's; moved back it is the new person's", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx, { reports_to: { kind: "user", user_id: PEER } });
    expect(owners(tables, "mine")).toEqual([PEER]);
    const head = await performStaff(ctx, ME as any, { team_id: TEAM });
    await performReparentRole(ctx, ME as any, { role_id: String(role._id), reports_to: { kind: "role", role_id: head.role._id } as any });
    expect(owners(tables, "mine")).toEqual([]);
    expect(String(tables.conversations.find((c) => c._id === "mine")!.org_role_id)).toBe(String(head.role._id));
    await performReparentRole(ctx, ME as any, { role_id: String(role._id), reports_to: { kind: "user", user_id: ME } as any });
    expect(owners(tables, "mine")).toEqual([ME]);
    expect(tables.conversations.find((c) => c._id === "mine")!.org_role_id).toBeUndefined();
  });

  test("its owner changes only by moving the role: the owner gesture refuses and names the move", async () => {
    const { ctx, tables } = world();
    await lead(ctx);
    await expect(performReparentSession(ctx, ME as any, { session_id: "mine", target: { kind: "user", owners: [PEER], mode: "set" } as any })).rejects.toThrow("cast org reparent @infra");
    expect(owners(tables, "mine")).toEqual([ME]);
  });
});

describe("a role's own session is retired, never killed (S16)", () => {
  test("every explicit kill door refuses and names the retire; a retire still decommissions it", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    const seat = tables.conversations.find((c) => c._id === "mine")!;
    await expect(killConversation(ctx, ME as any, { conversation_id: "mine" as any })).rejects.toThrow("cast role retire @infra");
    await expect(applyHideTransition(ctx, seat, { inbox_dismissed_at: NOW }, { forceKill: true })).rejects.toThrow("@infra's own session");
    expect(seat.inbox_killed_at).toBeUndefined();
    // A plain session still kills.
    await killConversation(ctx, ME as any, { conversation_id: "work1" as any });
    expect(tables.conversations.find((c) => c._id === "work1")!.inbox_killed_at).toBeTruthy();
    await performRetireRole(ctx, ME as any, { role_id: String(role._id) });
    expect(tables.org_roles[0].status).toBe("retired");
  });
});
