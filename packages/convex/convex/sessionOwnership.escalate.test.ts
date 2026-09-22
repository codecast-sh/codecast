import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateRole } from "./orgRoles";
import { performEscalateSession, performRehomeSessions, performReparentSession } from "./sessionOwnership";
import { isSessionEscalationMessage, parseSessionEscalation } from "@codecast/shared/contracts";
import { patchConversationVisibility } from "./lib/access";

// A role's triage (docs/architecture/org-roles-run-work.md R1): escalation
// puts one of a role's sessions in front of the person with the role's line,
// clear takes it back, and a role that gains scope takes over the sessions
// that report to its host and to no role, through the one reparent core.

const ME = "u".repeat(31) + "m"; // team admin, the role's host
const MATE = "u".repeat(31) + "t"; // plain member
const BOT = "u".repeat(31) + "b"; // the role's bot user
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;

const id = (ch: string) => ch.repeat(32);
const conv = (ch: string, over: Record<string, any> = {}) => ({
  _id: id(ch),
  short_id: `jx7${ch.repeat(4)}`,
  user_id: ME,
  team_id: TEAM,
  status: "active",
  title: `Session ${ch}`,
  agent_type: "claude_code",
  message_count: 3,
  last_message_role: "assistant",
  updated_at: NOW - 60_000,
  ...over,
});

function fixtures(conversations: any[], extra: Record<string, any[]> = {}) {
  return makeFakeDb({
    users: [
      { _id: ME, name: "Me", email: "me@x.ai" },
      { _id: MATE, name: "Mate", email: "mate@x.ai" },
      { _id: BOT, name: "Growth", bot_kind: "role" },
    ],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [],
    org_roles: [],
    conversations,
    session_owners: [],
    session_decisions: [],
    managed_sessions: [],
    messages: [],
    user_presence: [],
    pending_messages: [],
    devices: [],
    anchors: [],
    role_wake_outbox: [],
    ...extra,
  });
}

const ctxOf = (db: any) => ({ db }) as any;
const row = (db: any, ch: string) => db._tables.conversations.find((c: any) => c._id === id(ch));

// A role with two sessions under it, and its standing session seated the way
// provisioning seats it (anchor with a bot user, standing_role_id on the row).
async function roleWithTwoSessions() {
  const db = fixtures([conv("a"), conv("b"), conv("s", { title: "Growth" })]);
  const ctx = ctxOf(db);
  const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
  for (const ch of ["a", "b"]) {
    await performReparentSession(ctx, ME as any, { session_id: id(ch), target: { kind: "role", role_id: role._id } });
  }
  db._tables.anchors.push({ _id: "anchors_growth", bot_user_id: BOT, org_role_id: role._id, conversation_id: id("s"), status: "active" });
  db._tables.org_roles[0].anchor_id = "anchors_growth";
  Object.assign(row(db, "s"), { standing_role_id: role._id, anchor_id: "anchors_growth" });
  return { db, ctx, role };
}

describe("cast escalate (R1)", () => {
  test("a role may escalate its own standing session (org-hire.md H5); a hand still may not", async () => {
    const { db, ctx, role } = await roleWithTwoSessions();
    const res = await performEscalateSession(ctx, ME as any, { session_id: "jx7ssss", line: "verify the domain in Search Console (unlocks SEO weekly)", from_session: id("s") });
    expect(res.role?.handle).toBe("growth");
    expect(row(db, "s").escalated_by_role).toMatchObject({ role_id: role._id, line: "verify the domain in Search Console (unlocks SEO weekly)" });
    await performEscalateSession(ctx, ME as any, { session_id: "jx7ssss", clear: true, from_session: id("s") });
    expect(row(db, "s").escalated_by_role).toBeUndefined();
    await expect(performEscalateSession(ctx, ME as any, { session_id: "jx7ssss", line: "me", from_session: id("a") })).rejects.toThrow(/Your role decides/);
  });
  test("the role puts one of its sessions in front of the person with its line; clear takes it back", async () => {
    const { db, ctx, role } = await roleWithTwoSessions();
    const res = await performEscalateSession(ctx, ME as any, { session_id: "jx7aaaa", line: "  the pricing copy is ready  \r\nand needs your eye\n\n- option A\n- option B ", from_session: id("s") });
    expect(res.changed).toBe(true);
    expect(res.role).toEqual({ short_id: role.short_id, handle: "growth", name: "Growth" });
    // The row carries the contract's shape, the line WHOLE: paragraphs and
    // newlines survive (the divider renders all of it), only the edges and
    // trailing spaces are trimmed. The chime carries the first line.
    expect(row(db, "a").escalated_by_role).toMatchObject({ role_id: role._id, line: "the pricing copy is ready\nand needs your eye\n\n- option A\n- option B" });
    expect(res.notify?.message).toBe("@growth: the pricing copy is ready (Session a)");
    expect(typeof row(db, "a").escalated_by_role.at).toBe("number");
    // The sibling is untouched: it stays under the role.
    expect(row(db, "b").escalated_by_role).toBeUndefined();

    const cleared = await performEscalateSession(ctx, ME as any, { session_id: "jx7aaaa", clear: true, from_session: id("s") });
    expect(cleared).toMatchObject({ changed: true, escalated_by_role: null });
    expect(row(db, "a").escalated_by_role).toBeUndefined();
    expect(row(db, "a").org_role_id).toBe(role._id);
    // Clearing twice is a no-op, not an error.
    expect((await performEscalateSession(ctx, ME as any, { session_id: "jx7aaaa", clear: true })).changed).toBe(false);
  });

  test("the role never escalates silently, only its own sessions, and only abuse is refused", async () => {
    const { db, ctx } = await roleWithTwoSessions();
    await expect(performEscalateSession(ctx, ME as any, { session_id: "jx7aaaa", from_session: id("s") })).rejects.toThrow(/what the person will decide/);
    await expect(performEscalateSession(ctx, ME as any, { session_id: "jx7aaaa", line: "x".repeat(4001), from_session: id("s") })).rejects.toThrow(/cap is 4000/);
    expect((await performEscalateSession(ctx, ME as any, { session_id: "jx7aaaa", line: "y".repeat(4000), from_session: id("s") })).changed).toBe(true);
    db._tables.conversations.push(conv("x"));
    await expect(performEscalateSession(ctx, ME as any, { session_id: id("x"), line: "look", from_session: id("s") })).rejects.toThrow(/report to you/);
  });

  test("a hand cannot put itself in front of the person; it is told to tell its role", async () => {
    const { ctx } = await roleWithTwoSessions();
    await expect(performEscalateSession(ctx, ME as any, { session_id: "jx7aaaa", line: "me first", from_session: id("a") }))
      .rejects.toThrow(/cast send @growth/);
  });

  test("a person has the same gesture with no line needed; a session under no role is refused in plain words", async () => {
    const { db, ctx } = await roleWithTwoSessions();
    const res = await performEscalateSession(ctx, ME as any, { session_id: "jx7bbbb" });
    expect(res.escalated_by_role?.line).toBe("Me put this in their inbox");
    db._tables.conversations.push(conv("x"));
    await expect(performEscalateSession(ctx, ME as any, { session_id: id("x"), line: "look" })).rejects.toThrow(/reports to no role/);
  });

  test("escalating un-stashes the row, and a reparent to a person drops the escalation with the pointer", async () => {
    const { db, ctx } = await roleWithTwoSessions();
    Object.assign(row(db, "a"), { inbox_stashed_at: NOW, inbox_stash_hidden: true });
    await performEscalateSession(ctx, ME as any, { session_id: "jx7aaaa", line: "needs you", from_session: id("s") });
    expect(row(db, "a").inbox_stashed_at).toBeUndefined();
    await performReparentSession(ctx, ME as any, { session_id: id("a"), target: { kind: "user", user_id: MATE as any } });
    expect(row(db, "a").org_role_id).toBeUndefined();
    expect(row(db, "a").escalated_by_role).toBeUndefined();
  });
});

// org-roles-run-work.md R1, revised: by default the escalation reaches the
// person through the role's card, the child stays nested; --direct puts the
// child; every move writes one divider into both threads through the
// ordinary message rail; the chime follows the card.
describe("an escalation reaches the person through the role (R1, revised)", () => {
  const dividers = (db: any, convCh: string) => db._tables.pending_messages
    .filter((m: any) => m.conversation_id === id(convCh) && isSessionEscalationMessage(m.content))
    .map((m: any) => parseSessionEscalation(m.content)!);

  test("by default the role's standing session is what reaches the person; the child keeps its stamp without direct", async () => {
    const { db, ctx, role } = await roleWithTwoSessions();
    Object.assign(row(db, "s"), { inbox_stashed_at: NOW });
    const res = await performEscalateSession(ctx, ME as any, { session_id: "jx7aaaa", line: "the pricing copy needs your eye", from_session: id("s") });
    expect(res.changed).toBe(true);
    expect(row(db, "a").escalated_by_role).toEqual({ role_id: role._id, line: "the pricing copy needs your eye", at: res.escalated_by_role!.at });
    expect(res.reached).toEqual({ conversation_id: id("s"), short_id: "jx7ssss", direct: false });
    // The chime rings on the role's card, with the line.
    expect(res.notify).toEqual({ conversation_id: id("s"), title: "@growth needs you", message: "@growth: the pricing copy needs your eye (Session a)" });
    // The role's card is brought back into the inbox to carry it.
    expect(row(db, "s").inbox_stashed_at).toBeUndefined();
    // One divider in each thread, the same line whole.
    const inChild = dividers(db, "a");
    const inRole = dividers(db, "s");
    expect(inChild.length).toBe(1);
    expect(inRole.length).toBe(1);
    expect(inChild[0]).toMatchObject({ move: "handed", by: "role", role: { handle: "growth", name: "Growth" }, session: { short_id: "jx7aaaa", title: "Session a" }, to: "Me", line: "the pricing copy needs your eye" });
    expect(inRole[0]).toEqual(inChild[0]);
    // Escalating again with the same line moves nothing and writes nothing.
    const again = await performEscalateSession(ctx, ME as any, { session_id: "jx7aaaa", line: "the pricing copy needs your eye", from_session: id("s") });
    expect(again.changed).toBe(false);
    expect(again.notify).toBeNull();
    expect(dividers(db, "a").length).toBe(1);
  });

  test("the role's own copy of the divider is held for its next turn; the child's copy is a turn", async () => {
    const { db, ctx } = await roleWithTwoSessions();
    await performEscalateSession(ctx, ME as any, { session_id: "jx7aaaa", line: "needs you", from_session: id("s") });
    // Only the dividers: the reparent line the fixture wrote is a turn of its own.
    const statusOf = (ch: string) => db._tables.pending_messages.filter((m: any) => m.conversation_id === id(ch) && isSessionEscalationMessage(m.content)).map((m: any) => m.status);
    expect(statusOf("s")).toEqual(["held"]);
    expect(statusOf("a")).toEqual(["pending"]);
    // A person's hand back from the web is not the role's own line: the role
    // hears it as a turn, the child too.
    await performEscalateSession(ctx, ME as any, { session_id: "jx7aaaa", clear: true });
    expect(statusOf("s")).toEqual(["held", "pending"]);
  });

  test("a session the team can no longer see leaves the role in the same patch, and both threads say so", async () => {
    const { db, ctx, role } = await roleWithTwoSessions();
    await performEscalateSession(ctx, ME as any, { session_id: "jx7aaaa", line: "needs you", from_session: id("s") });
    await patchConversationVisibility(ctx, row(db, "a"), { is_private: true });
    expect(row(db, "a").is_private).toBe(true);
    expect(row(db, "a").org_role_id).toBeUndefined();
    expect(row(db, "a").escalated_by_role).toBeUndefined();
    const last = dividers(db, "a").at(-1)!;
    expect(last).toMatchObject({ move: "back", left: true, role: { handle: "growth" } });
    expect(last.line).toContain("no longer visible to the team");
    expect(last.line).toContain("escalation is cleared");
    expect(dividers(db, "s").at(-1)).toEqual(last);
    // A change that keeps the team's view leaves the role alone.
    await patchConversationVisibility(ctx, row(db, "b"), { team_visibility: "full" });
    expect(row(db, "b").org_role_id).toBe(role._id);
  });

  test("--direct puts the child itself in front of the person; the chime rings on the child", async () => {
    const { db, ctx, role } = await roleWithTwoSessions();
    const res = await performEscalateSession(ctx, ME as any, { session_id: "jx7aaaa", line: "a permission prompt is open in here", direct: true, from_session: id("s") });
    expect(row(db, "a").escalated_by_role).toEqual({ role_id: role._id, line: "a permission prompt is open in here", at: res.escalated_by_role!.at, direct: true });
    expect(res.reached).toEqual({ conversation_id: id("a"), short_id: "jx7aaaa", direct: true });
    expect(res.notify?.conversation_id).toBe(id("a"));
    expect(res.notify?.title).toBe("@growth put a session in front of you");
    expect(dividers(db, "a")[0].move).toBe("direct");
    expect(dividers(db, "s")[0].move).toBe("direct");
  });

  test("a person's own gesture is always direct, rings nobody, and the divider names them", async () => {
    const { db, ctx } = await roleWithTwoSessions();
    const at = Date.now() - 1000;
    const res = await performEscalateSession(ctx, ME as any, { session_id: "jx7bbbb", at });
    expect(row(db, "b").escalated_by_role).toEqual({ role_id: db._tables.org_roles[0]._id, line: "Me put this in their inbox", at, direct: true });
    expect(res.reached?.direct).toBe(true);
    expect(res.notify).toBeNull();
    expect(dividers(db, "b")[0]).toMatchObject({ move: "direct", by: "person", to: "Me", at });
  });

  test("hand back clears the stamp and writes the divider the other way into both threads; a no-op clear writes none", async () => {
    const { db, ctx } = await roleWithTwoSessions();
    await performEscalateSession(ctx, ME as any, { session_id: "jx7aaaa", line: "needs you", from_session: id("s") });
    const cleared = await performEscalateSession(ctx, ME as any, { session_id: "jx7aaaa", clear: true });
    expect(cleared.changed).toBe(true);
    expect(row(db, "a").escalated_by_role).toBeUndefined();
    expect(dividers(db, "a").map((d: any) => d.move)).toEqual(["handed", "back"]);
    expect(dividers(db, "s").map((d: any) => d.move)).toEqual(["handed", "back"]);
    expect(dividers(db, "a")[1]).toMatchObject({ by: "person", line: "" });
    await performEscalateSession(ctx, ME as any, { session_id: "jx7aaaa", clear: true });
    expect(dividers(db, "a").length).toBe(2);
  });

  test("a role escalating its own standing session has no other card to reach the person through", async () => {
    const { db, ctx } = await roleWithTwoSessions();
    const res = await performEscalateSession(ctx, ME as any, { session_id: "jx7ssss", line: "verify the domain", from_session: id("s") });
    expect(res.reached).toEqual({ conversation_id: id("s"), short_id: "jx7ssss", direct: true });
    expect(dividers(db, "s").length).toBe(1);
  });
});

describe("taking over a scope takes over its sessions (R1)", () => {
  async function scopeWithSessions() {
    const db = fixtures(
      [
        conv("a"), // the host's, under no role: moves
        conv("b"), // the host's, with a question open to a person: moves and stays in front
        conv("c", { user_id: MATE }), // a teammate's: stays
        conv("d", { anchor_id: "anchors_x" }), // a standing thread: never filed under a role
      ],
      { session_decisions: [{ _id: "sd1", conversation_id: id("b"), status: "pending", asked_user_ids: [ME], created_at: NOW }] },
    );
    const ctx = ctxOf(db);
    const other = await performCreateRole(ctx, ME as any, { name: "Platform", handle: "platform", team_id: TEAM });
    db._tables.conversations.push(conv("e", { org_role_id: other._id })); // already another role's: stays
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    const candidates = db._tables.conversations.map((raw: any) => ({ raw }));
    return { db, ctx, role, other, candidates };
  }

  test("a dry run counts what would move and writes nothing", async () => {
    const { db, ctx, role, candidates } = await scopeWithSessions();
    const before = JSON.stringify(db._tables.conversations);
    const dry = await performRehomeSessions(ctx, ME as any, role, candidates, { dry: true });
    expect(dry.sessions).toEqual(["jx7aaaa", "jx7bbbb"]);
    expect(dry.kept_in_front).toEqual(["jx7bbbb"]);
    expect(dry.told).toEqual({ sessions: 0, roles: 0, deferred: 0 });
    expect(JSON.stringify(db._tables.conversations)).toBe(before);
    expect(db._tables.pending_messages.length).toBe(0);
  });

  test("the apply files the host's unowned sessions under the role, tells each once, and keeps an open question in front of the person", async () => {
    const { db, ctx, role, other, candidates } = await scopeWithSessions();
    const res = await performRehomeSessions(ctx, ME as any, role, candidates, { note: "It reads your questions first." });
    expect(res.sessions).toEqual(["jx7aaaa", "jx7bbbb"]);
    expect(res.told.sessions + res.told.deferred).toBe(2);
    expect(row(db, "a").org_role_id).toBe(role._id);
    expect(row(db, "a").escalated_by_role).toBeUndefined();
    expect(row(db, "b").org_role_id).toBe(role._id);
    expect(row(db, "b").escalated_by_role).toMatchObject({ role_id: role._id });
    // A teammate's session, a standing thread and another role's session stay.
    expect(row(db, "c").org_role_id).toBeUndefined();
    expect(row(db, "d").org_role_id).toBeUndefined();
    expect(row(db, "e").org_role_id).toBe(other._id);
    // Each moved session heard the one reparent line, with the note.
    const bodies = db._tables.pending_messages.map((m: any) => m.content);
    expect(bodies.length).toBe(2);
    for (const body of bodies) expect(body).toContain("You now report to Growth. It reads your questions first.");
    // A second apply finds nothing left to move.
    const again = await performRehomeSessions(ctx, ME as any, role, db._tables.conversations.map((raw: any) => ({ raw })));
    expect(again.sessions).toEqual([]);
  });
});
