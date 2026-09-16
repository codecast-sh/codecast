import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { CHIEF_OF_STAFF_CHARTER, CHIEF_OF_STAFF_HANDLE, COMPANY_REVIEW_TITLE, performBackfillSeatedChiefs, performCreateRole, performProvisionRole, performRetireRole, performSetTrust, performStaff, performUpdateRole, seatingNote } from "./orgRoles";
import { canAccessProject } from "./lib/access";
import { webUpdate as planWebUpdate } from "./plans";
import { webUpdate as projectWebUpdate } from "./projects";
import { charterPatch, charterLine } from "./lib/orgCharter";
import { buildFrame, type FrameInput } from "./orgWakes";
import { computeBriefFacts } from "./org";
import { handBriefing } from "./spawn";
import { workspaceAnchorFor } from "./anchors";
import { resolveChatMentions } from "./lib/mentionResolve";

// The chief of staff (docs/architecture/org-staffing.md S6) and the charters
// on projects and plans (S7): one seat per company, adoptable, capped at
// understand, with the weekly review armed on its standing session; and the
// project goal leading the role's frame and a hand's briefing.

const ME = "u".repeat(31) + "m";
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;

function world(extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [],
    org_roles: [],
    anchors: [],
    conversations: [
      // The analyzer session that offers to become the chief of staff.
      { _id: "mine", user_id: ME, session_id: "s-mine", short_id: "jxmine1", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 4, team_id: TEAM, project_path: "/repo" },
      // The same, spawned from a repo with no directory mapping: private by default.
      { _id: "private1", user_id: ME, session_id: "s-priv", short_id: "jxpriv1", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 4, team_id: TEAM, project_path: "/repo", is_private: true },
      // A hand of some other role: never adoptable.
      { _id: "hand1", user_id: ME, org_role_id: "role-other", session_id: "s-hand", short_id: "jxhand1", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 1, team_id: TEAM },
      // Another role's standing session: never adoptable either.
      { _id: "standing-other", user_id: ME, standing_role_id: "role-other", anchor_id: "anchor-other", session_id: "s-so", short_id: "jxstand", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 1, team_id: TEAM, persistent: true },
    ],
    agent_tasks: [],
    role_wake_outbox: [],
    role_wakes: [],
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
    ...extra,
  };
  const db = makeFakeDb(tables);
  const scheduled: any[] = [];
  const ctx: any = { db, scheduler: { runAfter: async (delay: number, _fn: any, args: any) => { scheduled.push({ delay, args }); } } };
  return { ctx, tables, scheduled };
}

describe("orgRoles.staff", () => {
  test("creates the chief of staff once, adopting the caller's session as its standing session", async () => {
    const { ctx, tables } = world();
    const out = await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "jxmine1" });
    expect(out.created).toBe(true);
    expect(out.adopted).toBe(true);
    expect(out.role.handle).toBe(CHIEF_OF_STAFF_HANDLE);
    const role = tables.org_roles[0];
    expect(role.name).toBe("Chief of Staff");
    expect(role.scope).toEqual({ project_ids: [], plan_ids: [] });
    expect(role.trust).toBe("understand");
    expect(role.reports_to).toEqual({ kind: "user", user_id: ME });
    expect(role.charter).toBe(CHIEF_OF_STAFF_CHARTER);
    expect(role.anchor_id).toBeDefined();
    // The adopted row IS the standing session: identity, anchor, persistence.
    const mine = tables.conversations.find((c) => c._id === "mine")!;
    expect(String(mine.standing_role_id)).toBe(String(role._id));
    expect(mine.anchor_id).toBe(role.anchor_id);
    expect(mine.persistent).toBe(true);
    const anchor = tables.anchors.find((a) => a._id === role.anchor_id)!;
    expect(anchor.conversation_id).toBe("mine");
    expect(String(anchor.org_role_id)).toBe(String(role._id));
    expect(mine.acting_user_id).toBe(anchor.bot_user_id);
    expect(tables.users.find((u) => u._id === anchor.bot_user_id)?.bot_kind).toBe("role");
    expect(out.standing).toEqual({ conversation_id: "mine", short_id: "jxmine1" } as any);
    // No new session was started for an adoption.
    expect(tables.conversations).toHaveLength(4);

    // Idempotent per company: the second call returns the same seat and arms nothing new.
    const again = await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "jxmine1" });
    expect(again.created).toBe(false);
    expect(again.already_existed).toBe(true);
    expect(String(again.role._id)).toBe(String(role._id));
    expect(tables.org_roles).toHaveLength(1);
    expect(tables.agent_tasks).toHaveLength(1);
  });

  // org-staffing.md S12: the chief of staff IS the workspace's standing agent.
  test("with a workspace anchor and no session named, staff seats the anchor as the chief: its row gains the role pointer, nothing restarts", async () => {
    const BOT = "u".repeat(31) + "b";
    const { ctx, tables } = world({
      users: [{ _id: ME, name: "Me", email: "me@x.ai", github_username: "me" }, { _id: BOT, name: "Anchor", is_bot: true, bot_kind: "anchor" }],
      team_memberships: [
        { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
        { _id: "m2", user_id: BOT, team_id: TEAM, role: "member", joined_at: 1, visibility: "full" },
      ],
      anchors: [{ _id: "anchor-t", scope_type: "team", team_id: TEAM, bot_user_id: BOT, host_user_id: ME, name: "Anchor", status: "active", conversation_id: "anchor-conv", created_at: 1, updated_at: 1 }],
    });
    tables.conversations.push({ _id: "anchor-conv", user_id: ME, acting_user_id: BOT, anchor_id: "anchor-t", session_id: "s-anchor", short_id: "jxanchr", title: "Anchor", title_is_custom: true, status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 9, team_id: TEAM, is_private: false, persistent: true, project_path: "/repo" });
    const before = { anchors: tables.anchors.length, users: tables.users.length, conversations: tables.conversations.length };

    const out = await performStaff(ctx, ME as any, { team_id: TEAM });
    expect(out.created).toBe(true);
    expect(out.adopted).toBe(true);
    expect(out.standing).toEqual({ conversation_id: "anchor-conv", short_id: "jxanchr" } as any);
    // S16: the web can say what happened.
    expect(out.seated).toBe("existing");
    expect(out.conversation_short_id).toBe("jxanchr");
    expect(out.previous_title).toBe("Anchor");
    expect(out.previous_standing).toBeNull();
    const role = tables.org_roles[0];
    expect(role.anchor_id).toBe("anchor-t");
    const anchor = tables.anchors.find((a) => a._id === "anchor-t")!;
    expect(String(anchor.org_role_id)).toBe(String(role._id));
    const conv = tables.conversations.find((c) => c._id === "anchor-conv")!;
    expect(String(conv.standing_role_id)).toBe(String(role._id));
    expect(conv.anchor_id).toBe("anchor-t");
    expect(conv.acting_user_id).toBe(BOT);
    expect(conv.persistent).toBe(true);
    // Nothing minted, nothing started: the same bot, the same row, the same session.
    expect({ anchors: tables.anchors.length, users: tables.users.length, conversations: tables.conversations.length }).toEqual(before);
    expect(tables.users.find((u) => u._id === BOT)?.bot_kind).toBe("role");
    // The review routine lives on that session.
    expect(tables.agent_tasks[0].originating_conversation_id).toBe("anchor-conv");
    // The thread looks like the role, and remembers what it was called.
    expect(conv.title).toBe("Chief of Staff");
    expect(conv.title_is_custom).toBe(true);
    expect(conv.seat_previous).toEqual({ title: "Anchor", title_is_custom: true });
    // The thread says what changed: the seating note from Me, then the briefing.
    const turns = tables.pending_messages.filter((p) => p.conversation_id === "anchor-conv");
    expect(turns).toHaveLength(2);
    expect(turns[0].content).toBe(`<session-message from="unknown" name="Me">\n${seatingNote(role, "Acme")}\n</session-message>`);
    expect(turns[0].content).toContain("I have seated you as the Chief of Staff of Acme (@chief-of-staff, or-1): https://codecast.sh/org/or-1.");
    expect(turns[0].content).toContain("Nothing else changed: your memory, your handle, your chat and Slack bindings and this thread are as they were.");
    expect(turns[0].status).not.toBe("held");
    expect(turns[1].content).toContain("@chief-of-staff");

    // The aliases keep working: the workspace anchor lookup still answers with
    // this row, and `@anchor` in chat now names the chief, never the bare bot.
    expect((await workspaceAnchorFor(ctx, { team_id: TEAM }))?._id).toBe("anchor-t");
    const mentions = await resolveChatMentions(ctx, TEAM, "@anchor what changed this week?", ME as any);
    expect(mentions.roles.map((r) => r.handle)).toEqual([CHIEF_OF_STAFF_HANDLE]);
    expect(mentions.users).toEqual([]);
    expect(mentions.refs).toEqual([{ kind: "role", role_id: String(role._id), short_id: role.short_id, handle: CHIEF_OF_STAFF_HANDLE }]);
    // A second hire is idempotent.
    const again = await performStaff(ctx, ME as any, { team_id: TEAM });
    expect(again.already_existed).toBe(true);
    expect(tables.anchors).toHaveLength(before.anchors);
  });

  test("without a chief, @anchor still names the bot; a named session outranks the anchor for adoption", async () => {
    const BOT = "u".repeat(31) + "b";
    const { ctx, tables } = world({
      users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: BOT, name: "Anchor", is_bot: true, bot_kind: "anchor" }],
      team_memberships: [
        { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
        { _id: "m2", user_id: BOT, team_id: TEAM, role: "member", joined_at: 1, visibility: "full" },
      ],
      anchors: [{ _id: "anchor-t", scope_type: "team", team_id: TEAM, bot_user_id: BOT, host_user_id: ME, name: "Anchor", status: "active", conversation_id: "anchor-conv", created_at: 1, updated_at: 1 }],
    });
    tables.conversations.push({ _id: "anchor-conv", user_id: ME, acting_user_id: BOT, anchor_id: "anchor-t", session_id: "s-anchor", short_id: "jxanchr", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 9, team_id: TEAM, is_private: false, persistent: true });
    const plain = await resolveChatMentions(ctx, TEAM, "@anchor hello", ME as any);
    expect(plain.users).toEqual([BOT]);
    expect(plain.roles).toEqual([]);

    const out = await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "jxmine1" });
    expect(out.standing?.conversation_id).toBe("mine");
    // The workspace anchor is untouched and still the workspace anchor.
    expect(tables.anchors.find((a) => a._id === "anchor-t")!.org_role_id).toBeUndefined();
    expect((await workspaceAnchorFor(ctx, { team_id: TEAM }))?._id).toBe("anchor-t");
  });

  test("seat fresh: a new session is started and the old standing agent is retired in the same act, its thread kept and linked from the role", async () => {
    const BOT = "u".repeat(31) + "b";
    const { ctx, tables } = world({
      users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: BOT, name: "Anchor", is_bot: true, bot_kind: "anchor" }],
      team_memberships: [
        { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
        { _id: "m2", user_id: BOT, team_id: TEAM, role: "member", joined_at: 1, visibility: "full" },
      ],
      anchors: [{ _id: "anchor-t", scope_type: "team", team_id: TEAM, bot_user_id: BOT, host_user_id: ME, name: "Anchor", status: "active", conversation_id: "anchor-conv", project_path: "/repo", created_at: 1, updated_at: 1 }],
      anchor_channels: [],
      session_commands: [],
    });
    tables.conversations.push({ _id: "anchor-conv", user_id: ME, acting_user_id: BOT, anchor_id: "anchor-t", session_id: "s-anchor", short_id: "jxanchr", title: "Anchor", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 9, team_id: TEAM, is_private: false, persistent: true, project_path: "/repo" });
    const out = await performStaff(ctx, ME as any, { team_id: TEAM, seat: "fresh" });
    expect(out.seated).toBe("fresh");
    expect(out.adopted).toBe(false);
    expect(out.previous_standing).toEqual({ conversation_id: "anchor-conv", short_id: "jxanchr" } as any);
    expect(out.previous_title).toBeNull();
    const role = tables.org_roles[0];
    expect(role.previous_standing_conversation_id).toBe("anchor-conv");
    // The old agent is retired, not deleted: its thread stays readable.
    const old = tables.anchors.find((a) => a._id === "anchor-t")!;
    expect(old.status).toBe("decommissioned");
    expect(old.org_role_id).toBeUndefined();
    const oldConv = tables.conversations.find((c) => c._id === "anchor-conv")!;
    expect(oldConv.status).toBe("completed");
    expect(oldConv.persistent).toBe(false);
    // One root agent: the fresh seat is a new anchors row with its own session.
    const seat = tables.anchors.find((a) => String(a.org_role_id) === String(role._id))!;
    expect(seat._id).not.toBe("anchor-t");
    expect(seat.status).toBe("active");
    const standing = tables.conversations.find((c) => c._id === seat.conversation_id)!;
    expect(standing.title).toBe("Chief of Staff");
    expect(String(standing.standing_role_id)).toBe(String(role._id));
    expect(out.conversation_short_id).toBe(standing.short_id);
    // A fresh session has no history to explain: no seating note, only the bootstrap.
    expect(tables.pending_messages.filter((p) => p.conversation_id === standing._id)).toHaveLength(1);
    // The workspace's standing agent is the chief now.
    expect((await workspaceAnchorFor(ctx, { team_id: TEAM }))?._id).toBe(seat._id);
  });

  test("seat fresh with a chief already standing is refused; a plain member cannot retire the host's agent for a fresh seat", async () => {
    const BOT = "u".repeat(31) + "b";
    const MATE = "u".repeat(31) + "t";
    const { ctx, tables } = world({
      users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: MATE, name: "Mate", email: "mate@x.ai" }, { _id: BOT, name: "Anchor", is_bot: true, bot_kind: "anchor" }],
      team_memberships: [
        { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
        { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
        { _id: "m3", user_id: BOT, team_id: TEAM, role: "member", joined_at: 1, visibility: "full" },
      ],
      anchors: [{ _id: "anchor-t", scope_type: "team", team_id: TEAM, bot_user_id: BOT, host_user_id: ME, name: "Anchor", status: "active", conversation_id: "anchor-conv", created_at: 1, updated_at: 1 }],
      anchor_channels: [],
      session_commands: [],
    });
    tables.conversations.push({ _id: "anchor-conv", user_id: ME, acting_user_id: BOT, anchor_id: "anchor-t", session_id: "s-anchor", short_id: "jxanchr", title: "Anchor", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 9, team_id: TEAM, is_private: false, persistent: true });
    await expect(performStaff(ctx, MATE as any, { team_id: TEAM, seat: "fresh" })).rejects.toThrow(/host or a team admin/);
    expect(tables.anchors[0].status).toBe("active");
    await performStaff(ctx, ME as any, { team_id: TEAM });
    await expect(performStaff(ctx, ME as any, { team_id: TEAM, seat: "fresh" })).rejects.toThrow(/already stands/);
  });

  test("unseating the chief keeps the standing agent by default: the old title returns, the pointers clear, the anchor answers again", async () => {
    const BOT = "u".repeat(31) + "b";
    const { ctx, tables } = world({
      users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: BOT, name: "Anchor", is_bot: true, bot_kind: "anchor" }],
      team_memberships: [
        { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
        { _id: "m2", user_id: BOT, team_id: TEAM, role: "member", joined_at: 1, visibility: "full" },
      ],
      anchors: [{ _id: "anchor-t", scope_type: "team", team_id: TEAM, bot_user_id: BOT, host_user_id: ME, name: "Anchor", status: "active", conversation_id: "anchor-conv", created_at: 1, updated_at: 1 }],
      anchor_channels: [],
      session_commands: [],
    });
    tables.conversations.push({ _id: "anchor-conv", user_id: ME, acting_user_id: BOT, anchor_id: "anchor-t", session_id: "s-anchor", short_id: "jxanchr", title: "Anchor", title_is_custom: true, status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 9, team_id: TEAM, is_private: false, persistent: true });
    const out = await performStaff(ctx, ME as any, { team_id: TEAM });
    const retired = await performRetireRole(ctx, ME as any, { role_id: String(out.role._id) });
    expect(retired.standing_session).toBe("kept");
    const conv = tables.conversations.find((c) => c._id === "anchor-conv")!;
    expect(conv.title).toBe("Anchor");
    expect(conv.title_is_custom).toBe(true);
    expect(conv.seat_previous).toBeUndefined();
    expect(conv.standing_role_id).toBeUndefined();
    expect(conv.status).toBe("active");
    expect(conv.persistent).toBe(true);
    expect(conv.anchor_id).toBe("anchor-t");
    expect(conv.acting_user_id).toBe(BOT);
    const anchor = tables.anchors.find((a) => a._id === "anchor-t")!;
    expect(anchor.status).toBe("active");
    expect(anchor.org_role_id).toBeUndefined();
    expect(tables.users.find((u) => u._id === BOT)?.bot_kind).toBe("anchor");
    expect((await workspaceAnchorFor(ctx, { team_id: TEAM }))?._id).toBe("anchor-t");
    // The seat's routine went with the seat.
    expect(tables.agent_tasks[0].status).not.toBe("scheduled");
    // Retiring the standing session with the seat is the other choice.
    const again = await performStaff(ctx, ME as any, { team_id: TEAM });
    const gone = await performRetireRole(ctx, ME as any, { role_id: String(again.role._id), standing_session: "retire" });
    expect(gone.standing_session).toBe("retired");
    expect(tables.anchors.find((a) => a._id === "anchor-t")!.status).toBe("decommissioned");
    expect(conv.status).toBe("completed");
    expect(conv.anchor_id).toBeUndefined();
  });

  test("backfill: a chief seated before S16 gets the title, the kept old title and the note from its host, once", async () => {
    const BOT = "u".repeat(31) + "b";
    const { ctx, tables } = world({
      users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: BOT, name: "Anchor", is_bot: true, bot_kind: "role" }],
      anchors: [{ _id: "anchor-t", scope_type: "team", team_id: TEAM, bot_user_id: BOT, host_user_id: ME, name: "Anchor", status: "active", conversation_id: "anchor-conv", org_role_id: "cos", created_at: 1, updated_at: 1 }],
      org_roles: [{ _id: "cos", short_id: "or-4", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Chief of Staff", handle: CHIEF_OF_STAFF_HANDLE, scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: "anchor-t", created_by: ME, created_at: 1, updated_at: 1 }],
    });
    tables.conversations.push({ _id: "anchor-conv", user_id: ME, acting_user_id: BOT, anchor_id: "anchor-t", standing_role_id: "cos", session_id: "s-anchor", short_id: "jxanchr", title: "Anchor", title_is_custom: true, status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 9, team_id: TEAM, is_private: false, persistent: true });
    const dry = await performBackfillSeatedChiefs(ctx, true);
    expect(dry).toEqual({ dry_run: true, updated: [{ role: "or-4", conversation: "jxanchr", previous_title: "Anchor", title: "Chief of Staff", workspace: "Acme" }], skipped: 0 });
    expect(tables.conversations.find((c) => c._id === "anchor-conv")!.title).toBe("Anchor");
    expect(tables.pending_messages).toHaveLength(0);
    const real = await performBackfillSeatedChiefs(ctx, false);
    expect(real.updated).toHaveLength(1);
    const conv = tables.conversations.find((c) => c._id === "anchor-conv")!;
    expect(conv.title).toBe("Chief of Staff");
    expect(conv.seat_previous).toEqual({ title: "Anchor", title_is_custom: true });
    expect(tables.pending_messages).toHaveLength(1);
    expect(tables.pending_messages[0].from_user_id).toBe(ME);
    expect(tables.pending_messages[0].content).toContain("I have seated you as the Chief of Staff of Acme (@chief-of-staff, or-4)");
    // A second run finds nothing to do.
    expect(await performBackfillSeatedChiefs(ctx, false)).toEqual({ dry_run: false, updated: [], skipped: 1 });
    expect(tables.pending_messages).toHaveLength(1);
  });

  test("arms one Company review routine on the standing session and queues the first review at once", async () => {
    const { ctx, tables } = world();
    const out = await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "mine", every_ms: 3 * 86_400_000 });
    const routine = tables.agent_tasks[0];
    expect(out.routine?.id).toBe(routine._id);
    expect(routine.title).toBe(COMPANY_REVIEW_TITLE);
    expect(routine.originating_conversation_id).toBe("mine");
    expect(routine.schedule_type).toBe("recurring");
    expect(routine.interval_ms).toBe(3 * 86_400_000);
    expect(routine.prompt).toContain("cast org review");
    expect(routine.status).toBe("scheduled");
    // The first review: an immediate wake for the role carrying the prompt.
    const wake = tables.role_wake_outbox.find((r) => String(r.role_id) === String(out.role._id));
    expect(wake?.kind).toBe("immediate");
    expect(wake?.cause).toContain("cast org review");
  });

  test("the default cadence is seven days", async () => {
    const { ctx, tables } = world();
    await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "mine" });
    expect(tables.agent_tasks[0].interval_ms).toBe(7 * 86_400_000);
  });

  test("adopt refuses a hand and another role's standing session", async () => {
    // The other seat is live; a pointer at a retired one is stale (see below).
    const { ctx } = world({
      org_roles: [{ _id: "role-other", short_id: "or-2", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Other", handle: "other", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: "anchor-other", created_by: ME, created_at: 1, updated_at: 1 }],
    });
    await expect(performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "hand1" })).rejects.toThrow(/hand/);
    await expect(performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "standing-other" })).rejects.toThrow(/another role's standing session/);
  });

  test("provision with adopt_conversation_id works for any role, not only the chief of staff", async () => {
    const { ctx, tables } = world();
    const role = await performCreateRole(ctx, ME as any, { name: "Infra lead", handle: "infra", team_id: TEAM });
    const out = await performProvisionRole(ctx, ME as any, { role_id: String(role._id), adopt_conversation_id: "mine" });
    expect(out.adopted).toBe(true);
    expect(out.conversation_id).toBe("mine");
    expect(String(tables.conversations.find((c) => c._id === "mine")!.standing_role_id)).toBe(String(role._id));
  });

  test("setTrust refuses to raise the chief of staff above understand", async () => {
    const { ctx, tables } = world();
    const out = await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "mine" });
    for (const trust of ["decide", "direct"]) {
      await expect(performSetTrust(ctx, ME as any, { role_id: String(out.role._id), trust, human_decision: "sd-1" } as any)).rejects.toThrow(/understand/);
    }
    expect(tables.org_roles[0].trust).toBe("understand");
    // Setting it to understand again is allowed (a no-op a person may make).
    await performSetTrust(ctx, ME as any, { role_id: String(out.role._id), trust: "understand", human_decision: "sd-1" } as any);
  });

  test("retire takes the seat's markers off the adopted session, so it can be adopted again", async () => {
    const { ctx, tables } = world({ anchor_channels: [], session_commands: [] });
    const first = await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "mine" });
    await performRetireRole(ctx, ME as any, { role_id: String(first.role._id), standing_session: "retire" });
    const mine = tables.conversations.find((c) => c._id === "mine")!;
    expect(mine.standing_role_id).toBeUndefined();
    expect(mine.anchor_id).toBeUndefined();
    expect(mine.acting_user_id).toBeUndefined();
    // Hire again into the same session: a new seat, adopted cleanly.
    const again = await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "mine" });
    expect(again.created).toBe(true);
    expect(again.adopted).toBe(true);
    expect(String(mine.standing_role_id)).toBe(String(again.role._id));
  });

  test("a stale standing pointer at a retired role does not block adoption", async () => {
    const { ctx, tables } = world({
      org_roles: [{ _id: "role-dead", short_id: "or-7", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Old", handle: "old", scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "retired", created_by: ME, created_at: 1, updated_at: 1 }],
    });
    // A row retired before retire learned to clear the markers.
    tables.conversations.find((c) => c._id === "mine")!.standing_role_id = "role-dead";
    const out = await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "mine" });
    expect(out.adopted).toBe(true);
    expect(String(tables.conversations.find((c) => c._id === "mine")!.standing_role_id)).toBe(String(out.role._id));
  });

  test("a handle change may not leave or enter the chief of staff seat", async () => {
    const { ctx, tables } = world();
    const out = await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "mine" });
    await expect(performUpdateRole(ctx, ME as any, { role_id: String(out.role._id), handle: "cos" })).rejects.toThrow(/keeps its handle/);
    expect(tables.org_roles[0].handle).toBe(CHIEF_OF_STAFF_HANDLE);
    const other = await performCreateRole(ctx, ME as any, { name: "Ops", handle: "ops", team_id: TEAM });
    await expect(performUpdateRole(ctx, ME as any, { role_id: String(other._id), handle: CHIEF_OF_STAFF_HANDLE })).rejects.toThrow(/keeps its handle/);
    // Any other rename still works, and the seat's own name may change.
    await performUpdateRole(ctx, ME as any, { role_id: String(other._id), handle: "operations" });
    await performUpdateRole(ctx, ME as any, { role_id: String(out.role._id), name: "Chief of Staff (interim)" });
  });

  test("adopting a private team session shares it, so every member sees the seat", async () => {
    const { ctx, tables } = world();
    await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "private1" });
    const row = tables.conversations.find((c) => c._id === "private1")!;
    expect(row.is_private).toBe(false);
    expect(row.team_id).toBe(TEAM);
    expect(row.standing_role_id).toBeDefined();
    expect(row.persistent).toBe(true);
  });

  test("the charter is written at principle level and carries the capacity model", () => {
    expect(CHIEF_OF_STAFF_CHARTER).toContain("The executives decide; you propose");
    expect(CHIEF_OF_STAFF_CHARTER).toContain("smallest change");
    expect(CHIEF_OF_STAFF_CHARTER).toContain("never apply");
    expect(CHIEF_OF_STAFF_CHARTER).toContain("phone");
    expect(CHIEF_OF_STAFF_CHARTER).toContain("open_tasks");
  });
});

describe("project and plan charters", () => {
  const project = { _id: "p1", user_id: ME, team_id: TEAM, workspace: `team:${TEAM}`, title: "Growth", status: "active", project_path: "/repo", created_at: 1, updated_at: 1 };

  test("charterPatch writes the fields and resolves the owner through the role handle in the same boundary", async () => {
    const { ctx, tables } = world({ projects: [project] });
    const role = await performCreateRole(ctx, ME as any, { name: "Head of Growth", handle: "growth", team_id: TEAM });
    const patch = await charterPatch(ctx, project, {
      goal: " Double weekly signups ", success_metrics: ["signups/week", " ", "activation rate"], priority: "p1", owner: "@growth", non_goals: ["paid ads"], risks: ["one channel"], budget: { tokens_per_day: 200_000 },
    }, "projects");
    expect(patch).toEqual({
      goal: "Double weekly signups", success_metrics: ["signups/week", "activation rate"], priority: "p1", owner_role_id: role._id, non_goals: ["paid ads"], risks: ["one channel"], budget: { tokens_per_day: 200_000 },
    });
    // A plan takes no risks or budget; null and empty clear.
    const planPatch = await charterPatch(ctx, project, { priority: null, owner: null, success_metrics: [], risks: ["ignored"], budget: null }, "plans");
    expect(planPatch).toEqual({ priority: undefined, owner_role_id: undefined, success_metrics: undefined });
    await expect(charterPatch(ctx, project, { owner: "@nobody" }, "projects")).rejects.toThrow(/No role/);
    await expect(charterPatch(ctx, project, { priority: "p9" as any }, "projects")).rejects.toThrow(/Priority/);
    // The goal has one writer: it is trimmed, and empty clears it.
    expect(await charterPatch(ctx, project, { goal: "  " }, "plans")).toEqual({ goal: undefined });
    expect(await charterPatch(ctx, project, { goal: " x " }, "plans")).toEqual({ goal: "x" });
    // A role in another boundary is refused.
    tables.org_roles.push({ _id: "r-personal", short_id: "or-9", scope_type: "user", scope_user_id: ME, handle: "solo", name: "Solo", status: "active", scope: { project_ids: [], plan_ids: [] } });
    await expect(charterPatch(ctx, project, { owner: "or-9" }, "projects")).rejects.toThrow(/another workspace/);
  });

  test("a plan goal cleared through the web path is stored as absent, not an empty string", async () => {
    const plan = { _id: "pl1", short_id: "pl-1", user_id: ME, team_id: TEAM, workspace: `team:${TEAM}`, title: "Signups", status: "active", goal: "old", source: "human", created_at: 1, updated_at: 1 };
    const { ctx, tables } = world({ plans: [plan] });
    ctx.auth = { getUserIdentity: async () => ({ subject: `${ME}|session` }) };
    await (planWebUpdate as any)._handler(ctx, { short_id: "pl-1", goal: "" });
    expect(tables.plans[0].goal).toBeUndefined();
    await (planWebUpdate as any)._handler(ctx, { short_id: "pl-1", goal: "  Double signups " });
    expect(tables.plans[0].goal).toBe("Double signups");
  });

  test("project access is the workspace stamp: a teammate cannot edit a project private inside the team", async () => {
    const MATE = "u".repeat(31) + "t";
    const shared = { ...project, _id: "p-shared" };
    const privateInTeam = { ...project, _id: "p-private", workspace: `user:${ME}` };
    const { ctx, tables } = world({
      projects: [shared, privateInTeam],
      users: [{ _id: ME, name: "Me" }, { _id: MATE, name: "Mate" }],
      team_memberships: [
        { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
        { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
      ],
    });
    expect(await canAccessProject(ctx, MATE as any, shared as any)).toBe(true);
    expect(await canAccessProject(ctx, MATE as any, privateInTeam as any)).toBe(false);
    ctx.auth = { getUserIdentity: async () => ({ subject: `${MATE}|session` }) };
    await (projectWebUpdate as any)._handler(ctx, { id: "p-shared", goal: "Grow" });
    expect(tables.projects.find((p) => p._id === "p-shared")!.goal).toBe("Grow");
    await expect((projectWebUpdate as any)._handler(ctx, { id: "p-private", goal: "Grow" })).rejects.toThrow("Project not found");
  });

  test("the frame's scope section leads with each project's goal, priority and metrics", async () => {
    const chartered = { ...project, goal: "Double weekly signups", priority: "p1", success_metrics: ["signups/week"] };
    const { ctx, tables } = world({ projects: [chartered] });
    const role = await performCreateRole(ctx, ME as any, { name: "Head of Growth", handle: "growth", team_id: TEAM, scope: { project_ids: ["p1" as any], plan_ids: [] } });
    const facts = await computeBriefFacts(ctx, ME as any, tables.org_roles[0], NOW);
    expect(facts.scope.projects[0]).toMatchObject({ id: "p1", goal: "Double weekly signups", priority: "p1", success_metrics: ["signups/week"] });
    const input: FrameInput = {
      role: { ...role, last_frame_seq: 0 }, anchor: null, rows: [{ kind: "immediate", cause: "hello" }], facts,
      charter: null, brief: null, channelLines: [], parentName: "Me", restart: false, now: NOW,
    };
    const frame = buildFrame(input).text;
    const scope = frame.slice(frame.indexOf("## Your scope now"), frame.indexOf("## Hands say"));
    expect(scope.split("\n")[1]).toBe("Direction:");
    expect(scope.split("\n")[2]).toBe("- project Growth [p1] · goal: Double weekly signups · metrics: signups/week");
    expect(scope.indexOf("Direction:")).toBeLessThan(scope.indexOf("Tasks:"));
  });

  test("a whole-company role reads every project's charter", async () => {
    const chartered = { ...project, goal: "Double weekly signups", priority: "p0" };
    const { ctx, tables } = world({ projects: [chartered, { ...project, _id: "p2", title: "Ops", goal: undefined }] });
    await performStaff(ctx, ME as any, { team_id: TEAM, adopt_conversation_id: "mine" });
    const facts = await computeBriefFacts(ctx, ME as any, tables.org_roles[0], NOW);
    expect(facts.scope.whole_workspace).toBe(true);
    expect(facts.scope.projects.map((p) => p.title).sort()).toEqual(["Growth", "Ops"]);
    expect(charterLine("- project Growth", facts.scope.projects.find((p) => p.id === "p1"))).toBe("- project Growth [p0] · goal: Double weekly signups");
    expect(charterLine("- project Ops", facts.scope.projects.find((p) => p.id === "p2"))).toBeNull();
  });

  test("the hand briefing names the task's project goal", () => {
    const withGoal = handBriefing({ name: "Head of Growth", handle: "growth" }, "Ship the signup form", "ct-7", { title: "Growth", goal: "Double weekly signups", priority: "p1" });
    expect(withGoal).toContain("Project Growth [p1] · goal: Double weekly signups. Your work serves that goal");
    const without = handBriefing({ name: "Head of Growth", handle: "growth" }, "Ship the signup form", "ct-7", { title: "Growth" });
    expect(without).not.toContain("Project Growth");
  });
});
