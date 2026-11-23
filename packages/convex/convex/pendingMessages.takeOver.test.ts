import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { enqueuePendingMessage, performSessionSend } from "./pendingMessages";
import { performCreateRole, performProvisionRole, performReparentSession, performRetireRole, performTellSessionRole } from "./orgRoles";
import { patchConversationVisibility } from "./lib/conversationVisibility";
import { wakeMentionedParties } from "./chat";
import { computeInboxSessions, heldByRoleAlone } from "./conversations";
import { formatDecisionAnswer, roleDrives, rollupParentIdOf } from "@codecast/shared/contracts";
import { dispatch } from "./dispatch";
import { sendSessionMessage } from "./pendingMessages";
import { stopAndSendForUser } from "./daemonCommandUtils";
import { performApplyOwnersChange, performLeaveSession, performSetSessionDriver } from "./sessionOwnership";

// One owner drives (org-roles-run-work.md R1). A person's own message into a
// session takes the wheel from the role or person driving it; the paused role
// may no longer write into it; "Tell <role>" reaches the role and changes
// nothing.

const ME = "u".repeat(31) + "m";
const PEER = "u".repeat(31) + "p";
const STRANGER = "u".repeat(31) + "s";
const POOL = "u".repeat(31) + "b";
const TEAM = "teams_acme" as any;
const NOW = Date.now();

const session = (id: string, over: Record<string, any> = {}) => ({
  _id: id, user_id: ME, session_id: `s-${id}`, short_id: `jx${id}`.slice(0, 7), status: "active", agent_type: "claude_code",
  updated_at: NOW, message_count: 4, team_id: TEAM, project_path: "/repo", ...over,
});

async function world() {
  const tables: Record<string, any[]> = {
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: PEER, name: "Peer", email: "peer@x.ai" }, { _id: STRANGER, name: "Stranger", email: "s@x.ai" }, { _id: POOL, name: "Pool box", is_bot: true }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: PEER, team_id: TEAM, role: "member", joined_at: 1 },
      { _id: "m3", user_id: POOL, team_id: TEAM, role: "member", joined_at: 1, visibility: "full" },
    ],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    counters: [], org_roles: [], org_role_history: [], org_changes: [], org_proposals: [], org_proposal_changes: [],
    anchors: [], anchor_channels: [], session_commands: [], agent_tasks: [], pending_messages: [], managed_sessions: [],
    session_owners: [], messages: [], user_presence: [], devices: [], docs: [], projects: [], plans: [], tasks: [],
    session_decisions: [], decision_inbox: [], decision_grants: [],
    conversations: [session("seat")],
  };
  const db = makeFakeDb(tables);
  const ctx: any = { db, scheduler: { runAfter: async () => {} } };
  const role = await performCreateRole(ctx, ME as any, { name: "Growth lead", handle: "growth", team_id: TEAM });
  await performProvisionRole(ctx, ME as any, { role_id: String(role._id), adopt_conversation_id: "seat" });
  const roleId = role._id;
  tables.conversations.push(
    // A hand the role started on my machine: no person owns it.
    session("hand", { org_role_id: roleId, role_started: true }),
    // The role's hand the hand started before anyone took over.
    session("child", { org_role_id: roleId, role_started: true, parent_conversation_id: "hand", spawned_by_conversation_id: "hand", is_subagent: true }),
    // A hand the role started on a bot pool account.
    session("pool", { user_id: POOL, org_role_id: roleId, role_started: true, is_private: false, team_visibility: "full" }),
    // A session of mine I filed under the role: the role drives, I own it.
    session("filed", { org_role_id: roleId, org_role_hold: "filed" }),
    // Plain sessions of mine.
    session("plain"),
    session("shared"),
  );
  tables.session_owners.push(
    { _id: "o1", conversation_id: "shared", user_id: ME, added_by: ME, added_at: 1 },
    { _id: "o2", conversation_id: "shared", user_id: PEER, added_by: ME, added_at: 2 },
  );
  const row = (id: string) => tables.conversations.find((c) => c._id === id)!;
  const ownersOf = (id: string) => tables.session_owners.filter((o) => o.conversation_id === id).map((o) => o.user_id);
  return { ctx, tables, row, ownersOf, roleId };
}

const composerSend = (ctx: any, conv: any, from: string, content = "keep going") =>
  enqueuePendingMessage(ctx, conv, from as any, { content, human: true, take_over: true });

describe("a person's own message takes the wheel", () => {
  test("an owner writing into a session its role drives becomes driver; the role pauses", async () => {
    const { ctx, row } = await world();
    expect(roleDrives(row("filed"))).toBe(true);
    await composerSend(ctx, row("filed"), ME);
    expect(row("filed").driver_user_id).toBe(ME);
    expect(roleDrives(row("filed"))).toBe(false);
  });

  test("an owner takes the wheel from another person who drives", async () => {
    const { ctx, row } = await world();
    await ctx.db.patch("shared", { driver_user_id: PEER });
    await composerSend(ctx, row("shared"), ME);
    expect(row("shared").driver_user_id).toBe(ME);
  });

  test("someone who neither owns nor runs it changes nothing", async () => {
    const { ctx, row } = await world();
    await composerSend(ctx, row("filed"), STRANGER);
    expect(row("filed").driver_user_id).toBeUndefined();
  });

  test("the driver's own send and a person's message on another rail change nothing", async () => {
    const { ctx, row, ownersOf } = await world();
    await composerSend(ctx, row("plain"), ME);
    expect(row("plain").driver_user_id).toBeUndefined();
    expect(ownersOf("plain")).toEqual([]);
    // A task comment or a decision answer is written by a person but is not
    // the person driving the agent.
    await enqueuePendingMessage(ctx, row("filed"), ME as any, { content: "a comment", human: true });
    expect(row("filed").driver_user_id).toBeUndefined();
  });

  test("the runner taking over a hand the role started becomes its owner, so the hand and the role's hands under it stay in their inbox", async () => {
    const { ctx, row, ownersOf } = await world();
    const before = await computeInboxSessions(ctx, ME as any, { show_all: true, includeLiveness: false });
    expect(before.sessions.map((s: any) => s._id)).not.toContain("hand");

    await composerSend(ctx, row("hand"), ME);
    expect(row("hand").driver_user_id).toBe(ME);
    expect(ownersOf("hand")).toEqual([ME]);
    expect(await heldByRoleAlone(ctx, row("hand"))).toBe(false);
    const after = await computeInboxSessions(ctx, ME as any, { show_all: true, includeLiveness: false });
    expect(after.sessions.map((s: any) => s._id)).toContain("hand");
    // The child it started for the role is still the role's (the role drives
    // it), and it nests under the hand the person now drives.
    expect(roleDrives(row("child"))).toBe(true);
    expect(rollupParentIdOf(row("child"))).toBe("hand");
  });
});

// The store's sendMessage rides dispatch.sendMessage for every surface: the
// composer, decision and poll answers, /model, the limit's "continue", inline
// threads. Only the session composer, whose line said so, asks to take over.
const dispatchSend = (ctx: any, convId: string, content: string, clientId: string, opts?: { take_over?: boolean }) =>
  (dispatch as any)._handler(
    { ...ctx, auth: { getUserIdentity: async () => ({ subject: `${ME}|session` }) } },
    { action: "sendMessage", args: [convId, content, undefined, clientId, undefined, ...(opts ? [opts] : [])] },
  );

describe("only a send that says so takes the wheel", () => {
  test("a decision answer, a /model command and an inline thread's reply leave the driver alone", async () => {
    const { ctx, row, ownersOf, tables } = await world();
    await dispatchSend(ctx, "hand", formatDecisionAnswer({ id: "dc-1", question: "Ship it?", answer: "Yes" }), "a1");
    await dispatchSend(ctx, "hand", "/model opus", "a2");
    await dispatchSend(ctx, "filed", "a reply from the task page", "a3");
    expect(row("hand").driver_user_id).toBeUndefined();
    expect(row("filed").driver_user_id).toBeUndefined();
    expect(ownersOf("hand")).toEqual([]);
    expect(tables.pending_messages.filter((m) => ["a1", "a2", "a3"].includes(m.client_id))).toHaveLength(3);
  });

  test("the session composer's send takes over, plain and queued", async () => {
    const { ctx, row } = await world();
    await dispatchSend(ctx, "filed", "I'll take it from here", "c1", { take_over: true });
    expect(row("filed").driver_user_id).toBe(ME);
    await (dispatch as any)._handler(
      { ...ctx, auth: { getUserIdentity: async () => ({ subject: `${ME}|session` }) } },
      { action: "queueMessage", args: ["hand", "after this turn", "q1", { take_over: true }] },
    );
    expect(row("hand").driver_user_id).toBe(ME);
  });

  test("Stop & send takes over only when the composer asks", async () => {
    const { ctx, row } = await world();
    await stopAndSendForUser(ctx, ME as any, "filed" as any, "stop, do this", "s1", Date.now());
    expect(row("filed").driver_user_id).toBeUndefined();
    await stopAndSendForUser(ctx, ME as any, "filed" as any, "stop, do this", "s2", Date.now(), undefined, true);
    expect(row("filed").driver_user_id).toBe(ME);
  });

  test("a server path into a person's session (a checkout ask, a transcript route) never takes over; a person's own cast send does", async () => {
    const { ctx, row } = await world();
    await performSessionSend(ctx, ME as any, { to: "jxfiled", body: "these files conflict", intent: "request", wake: true, client_id: "k1" });
    expect(row("filed").driver_user_id).toBeUndefined();
    await (sendSessionMessage as any)._handler(
      { ...ctx, auth: { getUserIdentity: async () => ({ subject: `${ME}|session` }) } },
      { to: "jxfiled", body: "status?", raw: false },
    );
    expect(row("filed").driver_user_id).toBe(ME);
  });

  test("taking the wheel sends the session's open questions on to the people (the paused role hears none)", async () => {
    const { ctx, row } = await world();
    const scheduled: any[] = [];
    ctx.scheduler = { runAfter: async (_ms: number, _fn: unknown, args: any) => { scheduled.push(args); } };
    await composerSend(ctx, row("filed"), ME);
    expect(scheduled).toContainEqual({ conversation_id: "filed" });
  });

  test("taking the wheel leaves the primary owner as it was", async () => {
    const { ctx, row } = await world();
    await ctx.db.patch("shared", { driver_user_id: PEER, owner_user_id: PEER });
    await composerSend(ctx, row("shared"), ME);
    expect(row("shared").driver_user_id).toBe(ME);
    expect(row("shared").owner_user_id).toBe(PEER);
  });
});

describe("a message never claims a run a role started", () => {
  test("the role steering its pool hand from its own session gives the seat person no owner row", async () => {
    const { ctx, ownersOf } = await world();
    const res = await performSessionSend(ctx, ME as any, { to: "jxpool", from: "s-seat", body: "status?" });
    expect(res.auto_owned).toBe(false);
    expect(ownersOf("pool")).toEqual([]);
    const inbox = await computeInboxSessions(ctx, ME as any, { show_all: true, includeLiveness: false });
    expect(inbox.sessions.map((s: any) => s._id)).not.toContain("pool");
  });

  test("a person messaging a role's pool hand does not take it either", async () => {
    const { ctx, ownersOf } = await world();
    const res = await performSessionSend(ctx, PEER as any, { to: "jxpool", body: "how is it going?" });
    expect(res.auto_owned).toBe(false);
    expect(ownersOf("pool")).toEqual([]);
  });
});

describe("a paused role may not write into the session", () => {
  test("the role's own session is refused, naming who drives", async () => {
    const { ctx, row } = await world();
    await composerSend(ctx, row("filed"), ME);
    await expect(performSessionSend(ctx, ME as any, { to: "jxfiled", from: "s-seat", body: "status?" }))
      .rejects.toThrow(/^Not sent\. Me drives jxfiled now, so @growth is paused there\./);
  });

  test("while the role drives, its session writes in as before", async () => {
    const { ctx, tables } = await world();
    const res = await performSessionSend(ctx, ME as any, { to: "jxfiled", from: "s-seat", body: "status?" });
    expect(tables.pending_messages.some((m) => m._id === res.message_id)).toBe(true);
  });

  test("the person who drives still writes in, and a hand still reports to the session that started it", async () => {
    const { ctx, row } = await world();
    await composerSend(ctx, row("hand"), ME);
    const mine = await performSessionSend(ctx, ME as any, { to: "jxhand", body: "next step" });
    expect(mine.message_id).toBeTruthy();
    expect(row("hand").driver_user_id).toBe(ME);
    const report = await performSessionSend(ctx, ME as any, { to: "jxhand", from: "s-child", body: "done" });
    expect(report.message_id).toBeTruthy();
  });

  test("a person's own session its task filed under the role: the refusal says it is theirs, not that the role is paused", async () => {
    const { ctx, tables } = await world();
    tables.conversations.push(session("bound", { org_role_id: tables.org_roles[0]._id, org_role_hold: "bound", driver_user_id: ME }));
    const err = await performSessionSend(ctx, ME as any, { to: "jxbound", from: "s-seat", body: "status?" }).then(() => null, (e) => e as Error);
    expect(err?.message).toMatch(/^Not sent\. Me drives jxbound: it is their session, filed under @growth by its task\./);
    expect(err?.message).not.toContain("paused");
  });

  test("a send into the role itself is never refused", async () => {
    const { ctx, row } = await world();
    await composerSend(ctx, row("filed"), ME);
    const res = await performSessionSend(ctx, ME as any, { to: "@growth", from: "s-filed", body: "fyi" });
    expect(res.message_id).toBeTruthy();
  });
});

describe("a paused role does not take the wheel back itself", () => {
  test("its own session making it driver again, or taking it off, is refused; the person who owns it may", async () => {
    const { ctx, row } = await world();
    await composerSend(ctx, row("filed"), ME);
    await expect(performSetSessionDriver(ctx, ME as any, { session_id: "filed", driver: { kind: "role" }, from_session: "s-seat" }))
      .rejects.toThrow(/^Me drives jxfiled, so @growth is paused there, and only a person who owns or runs it can hand @growth the wheel back\./);
    await expect(performApplyOwnersChange(ctx, ME as any, { session_id: "filed", change: { role: null }, from_session: "s-seat" })).rejects.toThrow(/@growth is paused there/);
    expect(row("filed").driver_user_id).toBe(ME);
    expect(row("filed").org_role_id).toBeTruthy();

    await performSetSessionDriver(ctx, ME as any, { session_id: "filed", driver: { kind: "role" } });
    expect(roleDrives(row("filed"))).toBe(true);
  });
});

describe("a paused role's chat line does not wake the session either", () => {
  test("its standing session mentioning the session in a channel is skipped; a person's mention still wakes it", async () => {
    const { ctx, tables, row } = await world();
    await composerSend(ctx, row("filed"), ME);
    const channel = { _id: "chan1", kind: "channel", name: "growth", team_id: TEAM };
    const line = (id: string, over: Record<string, any>) => ({ _id: id, channel_id: "chan1", content: "@jxfiled status?", created_at: NOW, ...over });
    const before = tables.pending_messages.length;
    const paused = await wakeMentionedParties(ctx, {
      channel: channel as any, message: line("msg1", { origin: "agent", author_kind: "agent", origin_session_id: "seat" }) as any, root: null,
      senderId: ME as any, senderName: "Growth lead", roles: [], sessions: [row("filed")],
    });
    expect(paused.skipped).toContain("paused_role:jxfiled");
    expect(tables.pending_messages.length).toBe(before);
    const person = await wakeMentionedParties(ctx, {
      channel: channel as any, message: line("msg2", {}) as any, root: null,
      senderId: PEER as any, senderName: "Peer", roles: [], sessions: [row("filed")],
    });
    expect(person.sessions).toBe(1);
  });
});

describe("Tell <role>", () => {
  test("sends the person's words to the role's own session, naming the session, and the role keeps driving", async () => {
    const { ctx, tables, row } = await world();
    const res = await performTellSessionRole(ctx, ME as any, { session_id: "filed", message: "try the other fixture", client_id: "c1" });
    const sent = tables.pending_messages.find((m) => m._id === res.pending_message_id)!;
    expect(sent.conversation_id).toBe("seat");
    expect(sent.content).toContain("About jxfiled: try the other fixture");
    expect(sent.content).toContain('<user-message from="Me"');
    expect(row("filed").driver_user_id).toBeUndefined();
    // A retry of the same dispatch queues nothing new.
    const queued = tables.pending_messages.length;
    await performTellSessionRole(ctx, ME as any, { session_id: "filed", message: "try the other fixture", client_id: "c1" });
    expect(tables.pending_messages).toHaveLength(queued);
  });

  test("refused for someone who may not write into the session", async () => {
    const { ctx } = await world();
    await expect(performTellSessionRole(ctx, STRANGER as any, { session_id: "filed", message: "hi" })).rejects.toThrow("Unauthorized");
  });
});

// A run a role started is the role's when no person owns it (R1): leaving one
// you took needs no move and leaves nobody, and the role drives it again.
describe("leaving a run a role started", () => {
  test("the runner who took over its hand leaves without a move: the role drives and it leaves their inbox", async () => {
    const { ctx, row, ownersOf } = await world();
    await composerSend(ctx, row("hand"), ME);
    expect(ownersOf("hand")).toEqual([ME]);
    await performLeaveSession(ctx, ME as any, { session_id: "hand" });
    expect(ownersOf("hand")).toEqual([]);
    expect(row("hand").driver_user_id).toBeUndefined();
    expect(roleDrives(row("hand"))).toBe(true);
    const inbox = await computeInboxSessions(ctx, ME as any, { show_all: true, includeLiveness: false });
    expect(inbox.sessions.map((s: any) => s._id)).not.toContain("hand");
  });

  test("an owner of a pool hand who made the role driver again leaves it to the role", async () => {
    const { ctx, row, ownersOf } = await world();
    await performApplyOwnersChange(ctx, ME as any, { session_id: "pool", change: { add: [ME] } });
    await performSetSessionDriver(ctx, ME as any, { session_id: "pool", driver: { kind: "user", user_id: ME } });
    await performSetSessionDriver(ctx, ME as any, { session_id: "pool", driver: { kind: "role" } });
    await performApplyOwnersChange(ctx, ME as any, { session_id: "pool", change: { leave: {} } });
    expect(ownersOf("pool")).toEqual([]);
    expect(roleDrives(row("pool"))).toBe(true);
  });

  test("a person's own session still moves before its runner leaves", async () => {
    const { ctx } = await world();
    await expect(performLeaveSession(ctx, ME as any, { session_id: "filed" })).rejects.toThrow(/runs on your account/);
  });
});

// When the role comes off a run it started that no person owns, the person
// the role answers to takes it: never nobody (lib/roleRelease).
describe("a role's pool hand never ends up owned by nobody", () => {
  const inInbox = async (ctx: any, id: string) =>
    (await computeInboxSessions(ctx, ME as any, { show_all: true, includeLiveness: false })).sessions.some((s: any) => s._id === id);

  test("retiring the role gives its hand to the person it reported to", async () => {
    const { ctx, row, ownersOf, roleId } = await world();
    expect(await inInbox(ctx, "pool")).toBe(false);
    await performRetireRole(ctx, ME as any, { role_id: String(roleId), handoff: "skip" });
    expect(row("pool").org_role_id).toBeUndefined();
    expect(ownersOf("pool")).toEqual([ME]);
    expect(await inInbox(ctx, "pool")).toBe(true);
  });

  test("taking the role off it, or a visibility change that drops the role, does the same", async () => {
    const { ctx, tables, row, ownersOf, roleId } = await world();
    await performReparentSession(ctx, POOL as any, { session_id: "pool", target: { kind: "role", role_id: null } });
    expect(row("pool").org_role_id).toBeUndefined();
    expect(ownersOf("pool")).toEqual([ME]);

    tables.conversations.push(session("pool2", { user_id: POOL, org_role_id: roleId, role_started: true, is_private: false, team_visibility: "full" }));
    await patchConversationVisibility(ctx, row("pool2"), { is_private: true, team_visibility: undefined });
    expect(row("pool2").org_role_id).toBeUndefined();
    expect(ownersOf("pool2")).toEqual([ME]);
  });
});
