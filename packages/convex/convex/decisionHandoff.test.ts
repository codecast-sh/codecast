import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { askCore, listForUserCore } from "./sessionDecisions";
import { ESCALATE_NOTE_REQUIRED, escalateCore, passCore, unassignCore } from "./decisionHandoff";

// Pass and escalate with a note (decisionHandoff.ts): the note is stored and
// reaches the new owner, escalation goes to the owner's manager else the
// admins, an escalated decision sorts first for them, bots never receive one,
// and unassign takes either hand-off back.

const HOST = "users_host" as any; // owns the asking session
const MGR = "users_mgr" as any; // the host's manager
const MATE = "users_mate" as any;
const ADMIN = "users_admin" as any;
const BOT = "users_bot" as any;
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;

function seed(opts: { managerOfHost?: any; hosted?: boolean } = {}) {
  const tables: Record<string, any[]> = {
    users: [
      { _id: HOST, name: "Host" },
      { _id: MGR, name: "Manager" },
      { _id: MATE, name: "Mate", email: "mate@acme.dev" },
      { _id: ADMIN, name: "Admin" },
      { _id: BOT, name: "Bot", is_bot: true },
    ],
    teams: [{ _id: TEAM }],
    team_memberships: [
      { _id: "m1", user_id: HOST, team_id: TEAM, role: "admin", ...("managerOfHost" in opts ? (opts.managerOfHost ? { reports_to_user_id: opts.managerOfHost } : {}) : { reports_to_user_id: MGR }) },
      { _id: "m2", user_id: MGR, team_id: TEAM, role: "member" },
      { _id: "m3", user_id: MATE, team_id: TEAM, role: "member" },
      { _id: "m4", user_id: ADMIN, team_id: TEAM, role: "admin" },
      { _id: "m5", user_id: BOT, team_id: TEAM, role: "admin" },
    ],
    org_roles: [],
    conversations: [
      { _id: "conversations_ask", session_id: "sess-ask", user_id: HOST, owner_user_id: HOST, team_id: TEAM, message_count: 3, ...(opts.hosted ? { agent_type: "codecast" } : {}) },
    ],
    session_owners: [{ _id: "so0", conversation_id: "conversations_ask", user_id: HOST, added_by: HOST, added_at: NOW }],
    session_decisions: [],
    decision_inbox: [],
    decision_grants: [],
    decision_stacks: [],
    notifications: [],
    docs: [],
    counters: [],
    pending_messages: [],
  };
  const db = makeFakeDb(tables);
  const scheduler = { runAfter: async () => {} };
  return { ctx: { db, scheduler } as any, tables };
}

async function ask(ctx: any, question = "Keep the engine vendored?") {
  const r = await askCore(ctx, { userId: HOST }, {
    session_id: "sess-ask",
    question,
    options: [{ label: "Keep" }, { label: "Switch" }],
    category: "approach",
  });
  expect(r.error).toBeUndefined();
  return r.short_id as string;
}

const inboxOf = (tables: Record<string, any[]>, id: string) =>
  tables.decision_inbox.filter((i) => String(i.decision_id) === id && i.status === "pending").map((i) => i.user_id).sort();
const notesOf = (tables: Record<string, any[]>, type: string) => tables.notifications.filter((n) => n.type === type);

describe("pass with a note", () => {
  test("the note is stored on passed_to and reaches the new owner in their notification", async () => {
    const { ctx, tables } = seed();
    const sd = await ask(ctx);
    expect(await passCore(ctx, HOST, sd, { kind: "user", id: MATE }, "  You own the parser now.  ")).toEqual({ passed: true });
    const row = tables.session_decisions[0];
    expect(row.passed_to).toMatchObject({ kind: "user", id: MATE, by: HOST, note: "You own the parser now.", from: [HOST] });
    expect(inboxOf(tables, String(row._id))).toEqual([MATE]);
    const [n, ...more] = notesOf(tables, "decision_passed");
    expect(more).toEqual([]);
    expect(String(n.recipient_user_id)).toBe(MATE);
    expect(n.actor_user_id).toBe(HOST);
    expect(n.message).toContain("You own the parser now.");
    expect(n.link).toBe(`/decisions/${sd}`);
  });

  test("a pass to a bot is refused and changes nothing", async () => {
    const { ctx, tables } = seed();
    const sd = await ask(ctx);
    expect(await passCore(ctx, HOST, sd, { kind: "user", id: BOT }, "here")).toEqual({ error: "Pass it to a person or a role" });
    expect(tables.session_decisions[0].passed_to).toBeUndefined();
    expect(notesOf(tables, "decision_passed")).toEqual([]);
  });

  test("a hosted assistant's question stays with its owner", async () => {
    const { ctx } = seed({ hosted: true });
    const sd = await ask(ctx);
    expect(await passCore(ctx, HOST, sd, { kind: "user", id: MATE })).toEqual({ error: expect.stringContaining("Only the owner") });
    expect(await escalateCore(ctx, HOST, sd, "too big for me")).toEqual({ error: expect.stringContaining("Only the owner") });
  });
});

describe("escalate", () => {
  test("goes to the owner's manager with the note, flags the decision, and notifies them", async () => {
    const { ctx, tables } = seed();
    const sd = await ask(ctx);
    expect(await escalateCore(ctx, HOST, sd, "Costs money; your call")).toEqual({ escalated: true, to: [MGR] });
    const row = tables.session_decisions[0];
    expect(row.escalated).toMatchObject({ by: HOST, note: "Costs money; your call", to: [MGR] });
    expect(row.holder).toEqual({ kind: "user", id: MGR });
    expect(row.asked_user_ids).toEqual([MGR]);
    expect(inboxOf(tables, String(row._id))).toEqual([MGR]);
    const notes = notesOf(tables, "decision_escalated");
    expect(notes.map((n) => String(n.recipient_user_id))).toEqual([MGR]);
    expect(notes[0].message).toContain("Costs money; your call");
  });

  test("with no manager it goes to the workspace's admins, never the owner or a bot", async () => {
    const { ctx, tables } = seed({ managerOfHost: null });
    const sd = await ask(ctx);
    expect(await escalateCore(ctx, HOST, sd, "Needs an admin")).toEqual({ escalated: true, to: [ADMIN] });
    expect(inboxOf(tables, String(tables.session_decisions[0]._id))).toEqual([ADMIN]);
  });

  test("a manager who is a bot is skipped for the admins", async () => {
    const { ctx } = seed({ managerOfHost: BOT });
    const sd = await ask(ctx);
    expect(await escalateCore(ctx, HOST, sd, "Needs a person")).toEqual({ escalated: true, to: [ADMIN] });
  });

  test("the owner's manager is asked, not the caller's: a passed decision escalates from whoever holds it", async () => {
    const { ctx, tables } = seed();
    tables.team_memberships.find((m) => m.user_id === MATE).reports_to_user_id = ADMIN;
    const sd = await ask(ctx);
    await passCore(ctx, HOST, sd, { kind: "user", id: MATE });
    expect(await escalateCore(ctx, MATE, sd, "Above my pay grade")).toEqual({ escalated: true, to: [ADMIN] });
  });

  test("a note is required", async () => {
    const { ctx, tables } = seed();
    const sd = await ask(ctx);
    expect(await escalateCore(ctx, HOST, sd, "   ")).toEqual({ error: ESCALATE_NOTE_REQUIRED });
    expect(await escalateCore(ctx, HOST, sd, undefined)).toEqual({ error: ESCALATE_NOTE_REQUIRED });
    expect(tables.session_decisions[0].escalated).toBeUndefined();
  });

  test("an escalated decision sorts first in the queue of the person it went to", async () => {
    const { ctx, tables } = seed();
    const first = await ask(ctx, "Which parser?");
    const second = await ask(ctx, "Which logger?");
    await passCore(ctx, HOST, first, { kind: "user", id: MGR });
    await escalateCore(ctx, HOST, second, "Blocks the release");
    const ids = (await listForUserCore(ctx, MGR, Date.now())).map((d: any) => d.short_id);
    expect(ids).toEqual([second, first]);
    // A later pass clears the flag: the next owner was chosen on purpose.
    await passCore(ctx, MGR, second, { kind: "user", id: MATE }, "You know this one");
    expect(tables.session_decisions.find((d) => d.short_id === second).escalated).toBeUndefined();
  });
});

describe("unassign", () => {
  test("still restores a pass to the people it was asked of", async () => {
    const { ctx, tables } = seed();
    const sd = await ask(ctx);
    await passCore(ctx, HOST, sd, { kind: "user", id: MATE }, "yours");
    expect(await unassignCore(ctx, HOST, sd)).toEqual({ unassigned: true });
    const row = tables.session_decisions[0];
    expect(row.passed_to).toBeUndefined();
    expect(row.asked_user_ids).toEqual([HOST]);
    expect(inboxOf(tables, String(row._id))).toEqual([HOST]);
  });

  test("takes an escalation back and clears its flag", async () => {
    const { ctx, tables } = seed();
    const sd = await ask(ctx);
    await passCore(ctx, HOST, sd, { kind: "user", id: MATE });
    await escalateCore(ctx, MATE, sd, "up it goes");
    expect(await unassignCore(ctx, HOST, sd)).toEqual({ unassigned: true });
    const row = tables.session_decisions[0];
    expect(row.escalated).toBeUndefined();
    // Back to whom it was first asked of, not to the teammate who escalated it.
    expect(row.asked_user_ids).toEqual([HOST]);
  });
});
