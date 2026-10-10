import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeFakeDb } from "./testDb";
import { applyCancel, applyPause } from "./agentTasks";
import { briefingFor, performRebriefRoles } from "./anchors";
import { charterTemplate, ensureRoleRoutine, performCreateRole, performWakeRole, performPauseRole, performProvisionRole, performResetOrg, performReparentRole, performResumeRole, performRetireRole, performStaff, performMoveRole, resetOrgPreview, seatingNote, standingConversationOf } from "./orgRoles";
import { ROLE_CHECK_PROMPT } from "./lib/orgRoutine";
import { roleRunner, seatPlace } from "./lib/seatPlace";
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

describe("a wake reaches the role the way cast send does", () => {
  test("from a session it names that session, so the role can answer with cast send", async () => {
    const { ctx, tables } = world({ conversations: [] });
    tables.conversations.push(
      { _id: "mine", user_id: ME, session_id: "s-mine", short_id: "jxmine1", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 4, team_id: TEAM, project_path: "/repo" },
      { _id: "peers", user_id: PEER, session_id: "s-peer", short_id: "jxpeer1", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 4, team_id: TEAM, project_path: "/repo" },
    );
    const role = await lead(ctx);
    const res = await performWakeRole(ctx, PEER as any, { role_id: String(role._id), message: "send me only what needs Ashot", from_session: "s-peer" });
    const row = tables.pending_messages.find((m) => String(m._id) === String(res.pending_message_id))!;
    expect(row.content).toContain('<session-message from="jxpeer1"');
    expect(String(row.from_conversation_id)).toBe("peers");
    expect(res).toMatchObject({ from_short_id: "jxpeer1", cross_user: true, target_live: false });
  });

  test("from a terminal it carries the person's name", async () => {
    const { ctx, tables } = world();
    const role = await lead(ctx);
    const res = await performWakeRole(ctx, PEER as any, { role_id: String(role._id), message: "how is infra?" });
    const row = tables.pending_messages.find((m) => String(m._id) === String(res.pending_message_id))!;
    expect(row.content).toContain('<user-message from="Peer"');
  });
});

describe("moving a role to the caller's machine", () => {
  async function peerHostedLead() {
    const w = world({
      devices: [{ _id: "d1", user_id: ME, device_id: "mydev", label: "My-MacBook" }, { _id: "d2", user_id: PEER, device_id: "peerdev", label: "Peer-MacBook" }],
    });
    w.tables.conversations.push({ _id: "peerseat", user_id: PEER, session_id: "s-peer", short_id: "jxpeer1", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 3, team_id: TEAM, project_path: "/Users/peer/repo", owner_device_id: "peerdev", owner_user_id: ME });
    w.tables.session_owners.push({ _id: "so-peer", conversation_id: "peerseat", user_id: ME });
    const role = await performCreateRole(w.ctx, ME as any, { name: "Infra lead", handle: "infra", team_id: TEAM, host_user_id: PEER as any });
    await performProvisionRole(w.ctx, ME as any, { role_id: String(role._id), adopt_conversation_id: "peerseat" });
    const anchor = () => w.tables.anchors.find((a) => String(a.org_role_id) === String(role._id))!;
    const seat = () => w.tables.conversations.find((c) => c._id === "peerseat")!;
    return { ...w, role, anchor, seat };
  }

  test("the standing session moves to the caller's device and account; the role and anchor rows are not rewritten", async () => {
    const { ctx, tables, role, anchor, seat } = await peerHostedLead();
    const roleBefore = { ...tables.org_roles.find((r) => String(r._id) === String(role._id)) };
    const anchorBefore = { ...anchor() };
    const result = await performMoveRole(ctx, ME as any, { role_id: String(role._id), device_id: "mydev" });

    expect(seat().owner_device_id).toBe("mydev");
    expect(String(seat().user_id)).toBe(ME);
    expect(result).toMatchObject({ handle: "infra", device_id: "mydev", label: "My-MacBook", cross_user: true });
    expect(tables.org_roles.find((r) => String(r._id) === String(role._id))).toMatchObject({ host_user_id: roleBefore.host_user_id });
    expect(anchor()).toMatchObject({ host_user_id: anchorBefore.host_user_id });
    expect(anchor().project_path).toBeUndefined();
    const resume = tables.daemon_commands.find((c) => c.command === "resume_session" && c.target_device_id === "mydev");
    expect(String(resume.user_id)).toBe(ME);
    expect(JSON.parse(resume.args)).toMatchObject({ reparented: true, cross_user: true });
  });

  test("after the move, the role runs as the caller and in the session's folder, wherever the daemon placed it", async () => {
    const { ctx, role, seat } = await peerHostedLead();
    const fresh = () => ctx.db.get(role._id);
    expect(String(await roleRunner(ctx, await fresh()))).toBe(PEER);
    await performMoveRole(ctx, ME as any, { role_id: String(role._id), device_id: "mydev" });
    // The destination daemon resolves this machine's checkout and records it.
    seat().project_path = "/Users/me/src/repo";
    const r = await fresh();
    expect(String(await roleRunner(ctx, r))).toBe(ME);
    expect(seatPlace(r, seat())).toEqual({ runner_user_id: ME, project_path: "/Users/me/src/repo" });
  });

  test("a member who neither hosts nor admins the role is refused, and the session stays where it was", async () => {
    const { ctx, tables, role, seat } = await peerHostedLead();
    const OTHER = "u".repeat(31) + "o";
    tables.users.push({ _id: OTHER, name: "Other", email: "other@x.ai" });
    tables.team_memberships.push({ _id: "m3", user_id: OTHER, team_id: TEAM, role: "member", joined_at: 1 });
    tables.devices.push({ _id: "d3", user_id: OTHER, device_id: "otherdev", label: "Other-MacBook" });
    await expect(performMoveRole(ctx, OTHER as any, { role_id: String(role._id), device_id: "otherdev" })).rejects.toThrow();
    expect(seat().owner_device_id).toBe("peerdev");
    expect(String(seat().user_id)).toBe(PEER);
  });

  // cliRoute strips device_id unless the route forwards it; without that the
  // destination never reached the mutation.
  test("the CLI route forwards the destination device", () => {
    const http = fs.readFileSync(path.join(import.meta.dir, "http.ts"), "utf-8");
    const at = http.indexOf('cliRoute("/cli/role/move"');
    expect(at).toBeGreaterThan(-1);
    expect(http.slice(at, at + 200)).toContain("{ forwardDeviceId: true }");
  });

  test("a role with no standing session says how to seat one", async () => {
    const { ctx } = world();
    const role = await performCreateRole(ctx, ME as any, { name: "Data lead", handle: "data", team_id: TEAM });
    await expect(performMoveRole(ctx, ME as any, { role_id: String(role._id), device_id: "mydev" })).rejects.toThrow(/cast role provision/);
  });
});
