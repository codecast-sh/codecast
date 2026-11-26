import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { _resetChildAuqProbeCacheForTests, collectInboxSessionsByIds, collectInboxSessionsPaginated, computeInboxSessions, computeSessionsLiveness, listClosedSessions, listFavoriteSessions, listKilledSessions, tallyInboxRows } from "./conversations";
import { INBOX_FACT_FIELDS, INBOX_MODEL_ONLY_ROW_FIELDS, INBOX_WINDOW_CAPS, inboxEpoch, isInboxMember, selectWorkingSet, trustedStatusAt, type ProjectableInboxRow } from "@codecast/shared/contracts";
import { projectInbox } from "@codecast/shared/contracts/inboxPlacement";
import { GEN_HOUR, genWorld, makeRng } from "@codecast/shared/contracts/__fixtures__/inboxProjectionGen";
import { makeFakeDb } from "./testDb";
import { inboxOwnersOf } from "./lib/inboxOwners";
import { performReleaseDeadParentChildren } from "./notifications";
import { cliSessionClassifier } from "./cliSessionClassifier";

// The owners model (team feature session_owners) in the server's inbox: the
// scan, the base list, the overlay and the CLI tally. Every case runs the same
// world with the team's flag on and off; off must be today's inbox.

const ME = "users_me";
const MATE = "users_mate";
const TEAM = "teams_t";
const EPOCH = inboxEpoch(1_800_000_000_000);
const H = GEN_HOUR;

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  nowSpy = spyOn(Date, "now").mockReturnValue(EPOCH + 5_000);
  _resetChildAuqProbeCacheForTests();
});
afterEach(() => nowSpy.mockRestore());

const live = { status: "active", team_id: TEAM, message_count: 6, last_message_role: "assistant" };

// One row per membership case, all run on my account, each settled waiting.
function world(flag: boolean) {
  const conv = (id: string, at: number, extra: Record<string, any> = {}) => ({
    _id: `conversations_${id}`, user_id: ME, updated_at: EPOCH - at * H, started_at: EPOCH - at * H - H, title: id, ...live, ...extra,
  });
  return makeFakeDb({
    teams: [{ _id: TEAM, name: "Union", features: flag ? { session_owners: true } : {} }],
    users: [{ _id: ME, name: "Me", email: "me@example.com" }, { _id: MATE, name: "Mate", email: "mate@example.com" }],
    conversations: [
      conv("own", 1),
      // Filed under a role I did not start it for: the role owns it, and my
      // owner row keeps me an owner beside it.
      conv("role_hand", 2, { org_role_id: "org_roles_r", owner_user_id: ME }),
      // A role started it on my account and no person owns it.
      conv("role_started", 3, { org_role_id: "org_roles_r", role_started: true }),
      // A worker nested under my own session (`cast spawn --subagent`), still owned by it.
      conv("child", 4, { parent_conversation_id: "conversations_own" }),
      // The same, taken over: released from its parent, mine again.
      conv("released", 5, { parent_conversation_id: "conversations_own", parent_released_at: EPOCH - 6 * H }),
      // A plain spawn from my own session: its peer, so mine, never the spawner's.
      conv("peer", 4.5, { spawned_by_conversation_id: "conversations_own" }),
      // A sub-agent I added myself to.
      conv("added_sub", 6, { is_subagent: true, parent_conversation_id: "conversations_own", owner_user_id: ME }),
      // Handed to a teammate: their owner row alone.
      conv("handed", 7, { owner_user_id: MATE }),
    ],
    session_owners: [
      { _id: "so_1", conversation_id: "conversations_role_hand", user_id: ME, added_by: ME, added_at: 1 },
      { _id: "so_2", conversation_id: "conversations_added_sub", user_id: ME, added_by: ME, added_at: 2 },
      { _id: "so_3", conversation_id: "conversations_handed", user_id: MATE, added_by: ME, added_at: 3 },
    ],
    managed_sessions: [],
    messages: [],
    session_decisions: [],
    decision_inbox: [],
  });
}

const ids = (rows: any[]) => rows.filter((r) => !r.is_subagent || r.owners_model).map((r) => String(r._id).replace("conversations_", "")).sort();
// The viewer's inbox members: a child its session owns comes with that
// session's row for its card only (owned by nobody here), never a member.
const members = (rows: any[]) => ids(rows.filter((r) => !(r.owner_session_id && !r.owned_by_me && !r.implicit_owner)));

describe("membership: the inbox is the sessions you own", () => {
  test("flag on: own, role-owned with my row, released, added-myself and a plain spawn's peer; not role-started, parent-owned or handed", async () => {
    const { sessions } = await computeInboxSessions({ db: world(true) }, ME as any, { includeLiveness: false });
    expect(members(sessions)).toEqual(["added_sub", "own", "peer", "released", "role_hand"]);
    expect(sessions.find((s: any) => s._id === "conversations_child")).toMatchObject({ owned_by_me: false, implicit_owner: null, owner_session_id: "conversations_own" });
    expect(sessions.find((s: any) => s._id === "conversations_peer")).toMatchObject({ implicit_owner: ME, owner_session_id: null });
    const own = sessions.find((s: any) => s._id === "conversations_own");
    // A row names no owner list: the viewer's claim, and the implicit starter.
    expect(own).toMatchObject({ owners_model: true, implicit_owner: ME, owned_by_me: false });
    expect(sessions.find((s: any) => s._id === "conversations_role_hand")).toMatchObject({ owners_model: true, implicit_owner: null, owned_by_me: true });
    expect("owner_ids" in own).toBe(false);
    expect(sessions.find((s: any) => s._id === "conversations_added_sub").owner_session_id).toBe("conversations_own");
  });

  test("flag off: today's inbox, owner fields absent", async () => {
    const off = world(false);
    // Every session's push writes its episode key; off the model no row
    // carries it, or any other owners-model field (the un-flagged shape).
    await off.patch("conversations_own", { needs_input_notified_key: "6:idle" });
    const { sessions } = await computeInboxSessions({ db: off }, ME as any, { includeLiveness: false });
    for (const s of sessions) expect([...INBOX_MODEL_ONLY_ROW_FIELDS].filter((k) => k in s)).toEqual([]);
    // The role's rows and the spawned peer are the runner's; the handed one is
    // assigned away; the nested workers ride their parent.
    expect(ids(sessions)).toEqual(["own", "peer", "role_hand", "role_started"]);
    for (const id of ["added_sub", "child", "released"]) {
      expect(sessions.find((s: any) => s._id === `conversations_${id}`)).toMatchObject({ is_subagent: true, parent_conversation_id: "conversations_own" }); // a child row under its parent
    }
  });

  test("a child whose parent session was killed falls back to its starter's inbox", async () => {
    const db = world(true);
    await db.patch("conversations_own", { inbox_killed_at: EPOCH - H });
    const { sessions } = await computeInboxSessions({ db }, ME as any, { includeLiveness: false });
    expect(ids(sessions)).toContain("child");
    expect(sessions.find((s: any) => s._id === "conversations_child").owner_session_id).toBeNull();
  });

  test("a teammate's inbox holds what they own: the handed session", async () => {
    const { sessions } = await computeInboxSessions({ db: world(true) }, MATE as any, { includeLiveness: false });
    expect(ids(sessions)).toEqual(["handed"]);
  });
});

// The web settles an owners change's lock on the first server value after its
// acknowledgement, and reads an owners stamp a whole row under the model leaves
// out as cleared (store syncProtocol): so every builder of an inbox row spells
// all four stamps on a row under the model, null where empty.
describe("every inbox row builder under the model spells the four owner stamps", () => {
  const STAMPS = ["owned_by_me", "implicit_owner", "owner_session_id", "org_role_id"];
  const spelled = (rows: any[]) => {
    const under = rows.filter((r) => r.owners_model === true);
    expect(under.length).toBeGreaterThan(0);
    for (const row of under) for (const f of STAMPS) expect({ id: row._id, field: f, present: f in row && row[f] !== undefined }).toEqual({ id: row._id, field: f, present: true });
    return under;
  };
  const auth = (db: any) => ({ db, auth: { getUserIdentity: async () => ({ subject: `${ME}|session`, tokenIdentifier: ME }) } });
  const handler = (q: any) => (q._handler ?? q.handler) as (ctx: any, args: any) => Promise<any>;

  test("the base list and its sub-agent rows", async () => {
    const { sessions } = await computeInboxSessions({ db: world(true) }, ME as any, { includeLiveness: false });
    const under = spelled(sessions);
    // Empty stamps are null, not absent: the own session has no role, parent or owner row.
    expect(under.find((r: any) => r._id === "conversations_own")).toMatchObject({ owned_by_me: false, org_role_id: null, owner_session_id: null });
  });

  test("byIds and the completeness crawl", async () => {
    const all = ["own", "role_hand", "role_started", "child", "released", "added_sub", "handed"].map((id) => `conversations_${id}`);
    spelled((await collectInboxSessionsByIds({ db: world(true) }, ME as any, all)).sessions);
    const page = await collectInboxSessionsPaginated({ db: world(true) }, ME as any, { paginationOpts: { numItems: 50, cursor: null } });
    spelled(page.page ?? page.sessions ?? []);
  });

  test("favorites, the killed shelf and the closed list", async () => {
    const db = world(true);
    for (const id of ["own", "role_hand"]) await db.patch(`conversations_${id}`, { is_favorite: true });
    spelled((await handler(listFavoriteSessions)(auth(db), { include_liveness: false })).sessions);
    const killed = world(true);
    for (const id of ["own", "role_hand"]) await killed.patch(`conversations_${id}`, { inbox_killed_at: EPOCH - H, inbox_dismissed_at: EPOCH - H });
    const k = await handler(listKilledSessions)(auth(killed), { paginationOpts: { numItems: 50, cursor: null } });
    spelled(k.page ?? k.sessions ?? []);
    const closed = world(true);
    for (const id of ["own", "role_hand"]) await closed.patch(`conversations_${id}`, { inbox_closed_at: EPOCH - H, inbox_dismissed_at: EPOCH - H });
    const c = await handler(listClosedSessions)(auth(closed), { paginationOpts: { numItems: 50, cursor: null } });
    spelled(c.page ?? c.sessions ?? []);
  });
});

// The client keeps one row per session, rewritten by whichever feeder pushed
// last: a child its parent owns must come back from byIds and the crawl as the
// inbox read sends it on the parent's card, or every catch-up rewrites it.
describe("a parent-owned child is one row whichever feeder sends it", () => {
  const childOf = (rows: any[]) => rows.find((r: any) => r._id === "conversations_child");

  test("byIds and the crawl send the inbox read's slim child row, field for field", async () => {
    const db = world(true);
    const listed = childOf((await computeInboxSessions({ db }, ME as any, { includeLiveness: false })).sessions);
    expect(listed).toMatchObject({ is_subagent: true, owner_session_id: "conversations_own" });
    expect(childOf((await collectInboxSessionsByIds({ db }, ME as any, ["conversations_child"])).sessions)).toEqual(listed);
    const page = await collectInboxSessionsPaginated({ db }, ME as any, { paginationOpts: { numItems: 50, cursor: null } });
    expect(childOf(page.page)).toEqual(listed);
  });

  test("an owner seat makes it a row of the viewer's own: the full row from every feeder, never the card's", async () => {
    const db = world(true);
    await db.insert("session_owners", { conversation_id: "conversations_child", user_id: ME, added_by: ME, added_at: 4 });
    const listed = childOf((await computeInboxSessions({ db }, ME as any, { includeLiveness: false })).sessions);
    expect(listed).toMatchObject({ owned_by_me: true, is_subagent: false });
    expect(childOf((await collectInboxSessionsByIds({ db }, ME as any, ["conversations_child"])).sessions)).toMatchObject({ owned_by_me: true, is_subagent: false });
    const page = await collectInboxSessionsPaginated({ db }, ME as any, { paginationOpts: { numItems: 50, cursor: null } });
    expect(childOf(page.page)).toBeUndefined();
  });
});

describe("the flag is the session's own: its team's, or its runner's teams' for a personal session", () => {
  const OTHER_TEAM = "teams_x";
  function mixed() {
    const conv = (id: string, extra: Record<string, any>) => ({
      _id: `conversations_${id}`, user_id: ME, updated_at: EPOCH - H, started_at: EPOCH - 2 * H, title: id, status: "active", message_count: 6, last_message_role: "assistant", ...extra,
    });
    return makeFakeDb({
      teams: [{ _id: TEAM, name: "Union", features: { session_owners: true } }, { _id: OTHER_TEAM, name: "Other", features: {} }],
      users: [{ _id: ME, name: "Me", email: "me@example.com" }, { _id: MATE, name: "Mate", email: "mate@example.com" }],
      team_memberships: [
        { _id: "tm_1", user_id: ME, team_id: TEAM, role: "member", joined_at: 1, visibility: "full" },
        { _id: "tm_2", user_id: ME, team_id: OTHER_TEAM, role: "member", joined_at: 1, visibility: "full" },
        { _id: "tm_3", user_id: MATE, team_id: OTHER_TEAM, role: "member", joined_at: 1, visibility: "full" },
      ],
      conversations: [
        // A Union member's session in a team without the flag: today's rules.
        conv("other_team", { team_id: OTHER_TEAM, org_role_id: "org_roles_r", role_started: true }),
        // Their personal session: on, through the runner's Union membership.
        conv("personal", { org_role_id: "org_roles_r", role_started: true }),
        conv("personal_own", {}),
        // A Union session the teammate (in no flagged team) owns: the new rules for them too.
        conv("union_for_mate", { team_id: TEAM, org_role_id: "org_roles_r", owner_user_id: MATE }),
      ],
      session_owners: [{ _id: "so_m", conversation_id: "conversations_union_for_mate", user_id: MATE, added_by: ME, added_at: 1 }],
      managed_sessions: [], messages: [], session_decisions: [], decision_inbox: [],
    });
  }

  test("a flag-off team's session stays on today's rules for a Union member; their personal session follows the new ones", async () => {
    const { sessions } = await computeInboxSessions({ db: mixed() }, ME as any, { includeLiveness: false });
    const byId = (id: string) => sessions.find((s: any) => s._id === `conversations_${id}`);
    // Off: the role's run on my account stays mine, unmarked.
    expect(byId("other_team")).toBeDefined();
    expect("owners_model" in byId("other_team")).toBe(false);
    // On (personal, runner in Union): a role-started run no person owns leaves; my own is mine.
    expect(byId("personal")).toBeUndefined();
    expect(byId("personal_own")).toMatchObject({ owners_model: true, implicit_owner: ME });
    // The Union session I run but handed to mate is not mine.
    expect(byId("union_for_mate")).toBeUndefined();
  });

  test("a Union session follows the new rules for anyone who sees it, a viewer in no flagged team included", async () => {
    const { sessions } = await computeInboxSessions({ db: mixed() }, MATE as any, { includeLiveness: false });
    const row = sessions.find((s: any) => s._id === "conversations_union_for_mate");
    expect(row).toMatchObject({ owners_model: true, owned_by_me: true, implicit_owner: null });
    const { liveness } = await computeSessionsLiveness({ db: mixed() }, MATE as any);
    expect(liveness["conversations_union_for_mate"]).toMatchObject({ bucket: "working", work_state: "needs_input" });
  });
});

describe("placement: a wait its agent owner answers files as working", () => {
  test("flag on: the role-owned wait is working with its raw state; the parent-owned child is With its parent", async () => {
    const { liveness, projection } = await computeSessionsLiveness({ db: world(true) }, ME as any);
    expect(liveness["conversations_role_hand"]).toMatchObject({ bucket: "working", work_state: "needs_input" });
    expect(liveness["conversations_added_sub"]).toMatchObject({ bucket: "working", work_state: "needs_input" });
    expect(liveness["conversations_own"]).toMatchObject({ bucket: "needs_input" });
    expect(liveness["conversations_child"]).toBeUndefined();
    expect(projection.tally.shown.working).toBe(2);
  });

  test("flag off: the role's hand rides as today and nothing reads working", async () => {
    const { liveness } = await computeSessionsLiveness({ db: world(false) }, ME as any);
    expect(liveness["conversations_role_hand"].work_state).toBe("needs_input");
    expect(liveness["conversations_role_hand"].bucket).not.toBe("working");
  });

  test("the CLI counts a person's figures and says who it is with; work_state stays raw", async () => {
    const { sessions } = await computeInboxSessions({ db: world(true) }, ME as any, { projection: true });
    const { counts, rows } = tallyInboxRows(sessions, { labelByConv: new Map(), now: EPOCH });
    const hand = rows.find((r) => r.id === "conversations_role_hand")!;
    expect(hand).toMatchObject({ work_state: "needs_input", bucket: "working", with_owner: "@role" });
    expect(rows.find((r) => r.id === "conversations_own")!.with_owner).toBeNull();
    // A plain spawn's wait is its starter's own, with no agent owner.
    expect(rows.find((r) => r.id === "conversations_peer")).toMatchObject({ bucket: "needs_input", with_owner: null });
    expect(counts.working).toBe(2);
    // own, released and peer.
    expect(counts.needs_input).toBe(3);
    const off = tallyInboxRows((await computeInboxSessions({ db: world(false) }, ME as any, { projection: true })).sessions, { labelByConv: new Map(), now: EPOCH });
    expect(off.rows.every((r) => r.with_owner === null)).toBe(true);
    expect(off.counts.working).toBe(0);
  });
});

describe("an escalated wait is in the inbox of whoever it rings (review of ct-100061)", () => {
  const LEAD = "users_lead";
  const BOT = "users_bot";
  function escalated() {
    // Shared with the team in full, so whoever a wait reaches can open it.
    const conv = (id: string, extra: Record<string, any>) => ({
      _id: `conversations_${id}`, user_id: ME, updated_at: EPOCH - H, started_at: EPOCH - 2 * H, title: id, is_private: false, ...live, ...extra,
    });
    return makeFakeDb({
      teams: [{ _id: TEAM, name: "Union", features: { session_owners: true } }],
      users: [{ _id: ME, name: "Me" }, { _id: LEAD, name: "Lead" }, { _id: BOT, name: "Bot", is_bot: true }],
      team_memberships: [ME, LEAD, BOT].map((u, i) => ({ _id: `tm_${i}`, user_id: u, team_id: TEAM, role: "member", joined_at: 1, visibility: "full" })),
      conversations: [
        conv("lead_session", { inbox_closed_at: EPOCH - H, inbox_dismissed_at: EPOCH - H }),
        // (a) Its parent was closed: still the owner, but the wait went to the human who started it.
        conv("closed_parent_child", { parent_conversation_id: "conversations_lead_session", wait_up_at: EPOCH - 60_000, wait_up_count: 6, wait_up_person: ME }),
        // The same once a message followed the escalation: the parent's again.
        conv("answered_child", { parent_conversation_id: "conversations_lead_session", message_count: 7, wait_up_at: EPOCH - 60_000, wait_up_count: 6, wait_up_person: ME }),
        // (b) A role's run on an agent account; its wait reached where the role's line ends.
        conv("bot_run", { user_id: BOT, org_role_id: "org_roles_r", role_started: true, wait_up_at: EPOCH - 60_000, wait_up_count: 6, wait_up_person: LEAD }),
        // (c) Subagents whose parent was killed: mine through the implicit
        // starter (a dead parent is a released one), with no owner row. The
        // one whose wait escalated to me lists at once; the one still running
        // lists once the release job has written its release (its nested
        // seat); the finished and the idle ones are history, listed nowhere.
        conv("killed_parent", { inbox_killed_at: EPOCH - H }),
        conv("orphan_sub", { is_subagent: true, parent_conversation_id: "conversations_killed_parent", wait_up_at: EPOCH - 60_000, wait_up_count: 6, wait_up_person: ME }),
        conv("orphan_live", { is_subagent: true, parent_conversation_id: "conversations_killed_parent" }),
        conv("orphan_idle", { is_subagent: true, parent_conversation_id: "conversations_killed_parent" }),
        conv("orphan_done", { is_subagent: true, parent_conversation_id: "conversations_killed_parent", status: "completed" }),
        // Pinned, its role answering: a person's figures read working.
        conv("pinned_hand", { org_role_id: "org_roles_r", owner_user_id: ME, inbox_pinned_at: EPOCH - H }),
      ],
      session_owners: [{ _id: "so_p", conversation_id: "conversations_pinned_hand", user_id: ME, added_by: ME, added_at: 1 }],
      managed_sessions: [{ _id: "ms_live", conversation_id: "conversations_orphan_live", user_id: ME, session_id: "s_live", last_heartbeat: EPOCH, agent_status: "working", agent_status_updated_at: EPOCH }],
      messages: [], session_decisions: [], decision_inbox: [],
    });
  }

  test("the starter sees the closed parent's child while its wait stands, and the waiting subagent whose parent died", async () => {
    const { sessions } = await computeInboxSessions({ db: escalated() }, ME as any, { includeLiveness: false });
    const listed = ids(sessions);
    expect(listed).toContain("closed_parent_child");
    expect(listed).not.toContain("answered_child");
    expect(listed).toContain("orphan_sub");
    expect(sessions.find((s: any) => s._id === "conversations_orphan_sub")).toMatchObject({ owners_model: true, implicit_owner: ME, wait_up_person: ME });
    // The running one is mine (a dead parent is released), and lists once
    // the release job writes it down; server and replica then seat it alike.
    // The finished and idle ones stay unreleased, in nobody's inbox.
    const db = escalated();
    const running = await db.get("conversations_orphan_live");
    expect(await inboxOwnersOf({ db }, running)).toMatchObject({ owners_model: true, implicit_owner: ME, owner_session_id: null });
    await performReleaseDeadParentChildren({ db, scheduler: { runAfter: async () => {} } } as any, { parent_id: "conversations_killed_parent", released_at: EPOCH - H });
    const after = await computeInboxSessions({ db }, ME as any, { includeLiveness: false });
    expect(ids(after.sessions)).not.toContain("orphan_idle");
    expect(ids(after.sessions)).not.toContain("orphan_done");
    expect((await db.get("conversations_orphan_idle")).parent_released_at).toBeUndefined();
    const row = after.sessions.find((s: any) => s._id === "conversations_orphan_live");
    expect(row).toMatchObject({ implicit_owner: ME, parent_released_at: EPOCH - H });
    expect(selectWorkingSet([row], EPOCH, ME).members.get(row._id)?.windows).toEqual(["nested"]);
    // owned_by_me means an owner row only; the escalation's seat is read off
    // the wait itself (so the next message ends it), never a stamp.
    const child = sessions.find((s: any) => s._id === "conversations_closed_parent_child");
    expect(child).toMatchObject({ owned_by_me: false, wait_up_person: ME });
    expect("escalated_to_me" in child).toBe(false);
  });

  test("the person a role's line ends at sees the agent account's run its wait reached, in Needs You", async () => {
    const { sessions } = await computeInboxSessions({ db: escalated() }, LEAD as any, { includeLiveness: false });
    expect(ids(sessions)).toEqual(["bot_run"]);
    const { liveness } = await computeSessionsLiveness({ db: escalated() }, LEAD as any);
    expect(liveness["conversations_bot_run"]).toMatchObject({ bucket: "needs_input" });
  });

  // A current escalation is a blocking ask with no message since: waiting on
  // a person whatever its daemon reports, so the scan reads no liveness for a
  // row only the escalation seats.
  test("a current escalated row costs no per-row liveness read, and files in Needs You", async () => {
    const db = escalated();
    await db.insert("managed_sessions", { session_id: "s_bot", conversation_id: "conversations_bot_run", user_id: BOT, agent_status: "working", last_heartbeat: EPOCH, agent_status_updated_at: EPOCH } as any);
    let perRow = 0;
    const counted = new Proxy(db, {
      get(target: any, prop) {
        if (prop !== "query") return typeof target[prop] === "function" ? target[prop].bind(target) : target[prop];
        return (table: string) => {
          const q = target.query(table);
          return new Proxy(q, {
            get(qt: any, qp) {
              if (qp === "withIndex") return (name: string, fn: any) => { if (table === "managed_sessions" && name === "by_conversation_id") perRow++; return qt.withIndex(name, fn); };
              return typeof qt[qp] === "function" ? qt[qp].bind(qt) : qt[qp];
            },
          });
        };
      },
    });
    const { sessions } = await computeInboxSessions({ db: counted }, LEAD as any, { projection: true });
    expect(ids(sessions)).toEqual(["bot_run"]);
    expect(sessions[0].bucket).toBe("needs_input");
    const { liveness } = await computeSessionsLiveness({ db: counted }, LEAD as any);
    expect(liveness["conversations_bot_run"]).toMatchObject({ bucket: "needs_input" });
    expect(perRow).toBe(0);
  });

  test("killed and closed sessions with a standing stamp take no escalated seat, so 200 of them leave room for a live wait", async () => {
    const db = escalated();
    for (let i = 0; i < 200; i++) {
      const gone = i % 2 ? { inbox_killed_at: EPOCH - H } : { inbox_closed_at: EPOCH - H, inbox_dismissed_at: EPOCH - H };
      await db.insert("conversations", { user_id: BOT, org_role_id: "org_roles_r", role_started: true, status: "active", title: `gone${i}`, is_private: false, updated_at: EPOCH, started_at: EPOCH - H, message_count: 6, wait_up_at: EPOCH - 1_000 + i, wait_up_count: 6, wait_up_person: LEAD, ...gone });
    }
    const { sessions, truncated } = await computeInboxSessions({ db }, LEAD as any, { includeLiveness: false });
    expect(ids(sessions)).toEqual(["bot_run"]);
    expect(truncated).toEqual([]);
  });

  test("an ended wait takes no escalated seat, even before its stamps are cleared", async () => {
    const db = escalated();
    // A message followed the escalation; the stamps are still on the row.
    await db.patch("conversations_bot_run", { message_count: 7 });
    const { sessions, truncated } = await computeInboxSessions({ db }, LEAD as any, { includeLiveness: false });
    expect(ids(sessions)).toEqual([]);
    expect(truncated).toEqual([]);
  });

  test("an escalated wait lists only for someone who can still read it: a former member never sees it", async () => {
    const FORMER = "users_former";
    const db = escalated();
    // Still in a flagged team, so the model's windows are read for them, but no longer in Union.
    await db.insert("users", { _id: FORMER, name: "Former" } as any);
    await db.insert("teams", { _id: "teams_other", name: "Other", features: { session_owners: true } } as any);
    await db.insert("team_memberships", { user_id: FORMER, team_id: "teams_other", role: "member", joined_at: 1, visibility: "full" } as any);
    await db.patch("conversations_bot_run", { wait_up_person: FORMER });
    const { sessions } = await computeInboxSessions({ db }, FORMER as any, { includeLiveness: false });
    expect(ids(sessions)).toEqual([]);
  });

  test("a pinned agent-answered wait counts as working, with its owner named, in the CLI's figures", async () => {
    const { sessions } = await computeInboxSessions({ db: escalated() }, ME as any, { projection: true });
    const { counts, rows } = tallyInboxRows(sessions, { labelByConv: new Map(), now: EPOCH });
    expect(rows.find((r) => r.id === "conversations_pinned_hand")).toMatchObject({ bucket: "pinned", work_state: "needs_input", with_owner: "@role" });
    expect(counts.working).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.with_owner === null && r.work_state === "needs_input").map((r) => r.id).sort()).toEqual(["conversations_closed_parent_child", "conversations_orphan_sub"]);
    expect(counts.needs_input).toBe(2);
  });

  test("cast sessions --team names the agent owner a wait is with; work_state stays raw", async () => {
    const db = escalated();
    const fields = await cliSessionClassifier({ db }, EPOCH).rowFields(await db.get("conversations_pinned_hand"));
    expect(fields).toMatchObject({ work_state: "needs_input", with_owner: "@role" });
    const plain = await cliSessionClassifier({ db }, EPOCH).rowFields(await db.get("conversations_closed_parent_child"));
    expect(plain.work_state).toBe("needs_input");
    expect("with_owner" in plain).toBe(false);
  });
});

describe("counts parity: the overlay is the shared projection over the replica's owned rows", () => {
  function replica(list: any[], liveness: Record<string, any>) {
    const rows: ProjectableInboxRow[] = [];
    const asking = new Set<string>();
    for (const r of list) {
      // The replica's scope: only rows it owns under the model (isForeignRow).
      if (r.owners_model && !isInboxMember(r, ME)) continue;
      const lv = liveness[r._id];
      const row: ProjectableInboxRow = { ...r, has_pending_messages: r.has_pending } as any;
      if (lv) {
        for (const f of INBOX_FACT_FIELDS) if (lv[f] !== undefined) (row as any)[f] = lv[f];
        row.agent_status = trustedStatusAt(row, EPOCH) ?? null;
        if (lv.asking) asking.add(r._id);
      }
      rows.push(row);
    }
    return { rows, asking };
  }

  for (const flag of [true, false]) {
    test(`generated worlds, flag ${flag ? "on" : "off"}: digest and tally agree`, async () => {
      for (const seed of [601, 602, 603, 604, 605, 606]) {
        const gen = genWorld(seed, 60, EPOCH, ME);
        const rng = makeRng(seed);
        // Spread the model's cases over the world: roles, nested children
        // (some released), and rows handed to a teammate.
        for (const c of gen.conversations as any[]) {
          c.team_id = TEAM;
          const roll = rng();
          if (roll < 0.12) c.org_role_id = "org_roles_r";
          else if (roll < 0.16) { c.org_role_id = "org_roles_r"; c.role_started = true; }
          else if (roll < 0.2 && !c.parent_conversation_id) c.parent_conversation_id = gen.conversations[0]._id;
          if (c.parent_conversation_id && rng() < 0.3) c.parent_released_at = EPOCH - H;
        }
        const db = () => makeFakeDb({
          teams: [{ _id: TEAM, name: "Union", features: flag ? { session_owners: true } : {} }],
          users: [{ _id: ME, name: "Me", email: "me@example.com" }],
          messages: [],
          ...JSON.parse(JSON.stringify(gen)),
        });
        const { liveness, projection } = await computeSessionsLiveness({ db: db() }, ME as any);
        const { sessions } = await computeInboxSessions({ db: db() }, ME as any, { includeLiveness: false, show_all: true });
        const { rows, asking } = replica(sessions.filter((s: any) => !s.is_subagent || s.owners_model), liveness);
        const local = projectInbox(rows, EPOCH, { asking: (id) => asking.has(id), viewer: ME });
        expect(local.set_digest).toBe(projection.set_digest!);
        expect(local.tally).toEqual(projection.tally);
      }
    });
  }
});

// The nested window reads only subagents the viewer released and owns
// (by_user_subagent_released), so its cap counts members: a busy account's
// parent-owned subagents never push a released one out.
describe("the nested window: released subagents only", () => {
  const sub = (id: string, minutesAgo: number, extra: Record<string, any> = {}) => ({
    _id: `conversations_${id}`, user_id: ME, is_subagent: true, parent_conversation_id: "conversations_lead",
    updated_at: EPOCH - minutesAgo * 60_000, started_at: EPOCH - minutesAgo * 60_000 - H, title: id, ...live, ...extra,
  });
  const nestedWorld = (subs: any[]) => makeFakeDb({
    teams: [{ _id: TEAM, name: "Union", features: { session_owners: true } }],
    users: [{ _id: ME, name: "Me", email: "me@example.com" }],
    team_memberships: [{ _id: "tm_me", user_id: ME, team_id: TEAM, role: "member", joined_at: 1, visibility: "full" }],
    conversations: [{ _id: "conversations_lead", user_id: ME, updated_at: EPOCH - H, started_at: EPOCH - 2 * H, title: "lead", ...live }, ...subs],
    session_owners: [], managed_sessions: [], messages: [], session_decisions: [], decision_inbox: [],
  });

  test("one released subagent stays listed under 30 newer subagents its parent owns", async () => {
    const busy = Array.from({ length: 30 }, (_, i) => sub(`busy${i}`, i + 1));
    const db = nestedWorld([sub("released", 120, { parent_released_at: EPOCH - 3 * H }), ...busy]);
    const { sessions, truncated } = await computeInboxSessions({ db }, ME as any, { includeLiveness: false });
    expect(ids(sessions)).toContain("released");
    expect(truncated).not.toContain("nested");
    // A subagent its parent owns is never mine: it rides the parent's card,
    // stamped owned by that session, so the client files it nowhere else.
    const busyRows = sessions.filter((s: any) => String(s._id).startsWith("conversations_busy"));
    expect(busyRows.length).toBeGreaterThan(0);
    for (const row of busyRows) {
      expect(row.owned_by_me).toBe(false);
      expect(row.owners_model).toBe(true);
      expect(row.owner_session_id).toBe("conversations_lead");
      expect(row.implicit_owner).toBeNull();
    }
  });

  // Only the web's own inbox draws them on the lead's card. The CLI's list
  // and the team board count each row as a session of its own.
  test("cast sessions and the team board list the lead, not the subagents it owns", async () => {
    const owned = () => nestedWorld(Array.from({ length: 3 }, (_, i) => sub(`busy${i}`, i + 1)));
    const busyIn = (rows: any[]) => rows.filter((s: any) => String(s._id ?? s.id).startsWith("conversations_busy"));
    expect(busyIn((await computeInboxSessions({ db: owned() }, ME as any, { includeLiveness: false })).sessions)).toHaveLength(3);
    const { sessions } = await computeInboxSessions({ db: owned() }, ME as any, { projection: true });
    const { rows } = tallyInboxRows(sessions, { labelByConv: new Map(), now: EPOCH });
    expect(rows.map((r) => r.id)).toEqual(["conversations_lead"]);
    const team = await computeInboxSessions({ db: owned() }, ME as any, { includeLiveness: false, teamScope: TEAM as any });
    expect(team.sessions.map((s: any) => s._id)).toContain("conversations_lead");
    expect(busyIn(team.sessions)).toEqual([]);
  });

  test("past its cap the window names itself and keeps the newest releases, the replica's selection", async () => {
    const released = Array.from({ length: INBOX_WINDOW_CAPS.nested + 1 }, (_, i) =>
      // Released in the opposite order to their activity: the release decides.
      sub(`rel${i}`, i + 1, { parent_released_at: EPOCH - 3 * H + i * 1000 }));
    const { sessions, truncated } = await computeInboxSessions({ db: nestedWorld(released) }, ME as any, { includeLiveness: false });
    expect(truncated).toContain("nested");
    const listed = ids(sessions).filter((id) => id.startsWith("rel"));
    expect(listed).toHaveLength(INBOX_WINDOW_CAPS.nested);
    expect(listed).not.toContain("rel0");
    // A replica holding all of them cuts the same seats.
    const local = selectWorkingSet(released.map((r) => ({ ...r, owners_model: true, implicit_owner: ME })), EPOCH, ME);
    expect([...local.members.keys()].sort()).toEqual(listed.map((id) => `conversations_${id}`).sort());
    expect(local.truncated).toEqual(["nested"]);
  });

  test("another person's or a role's released subagent takes no seat of mine", async () => {
    const db = nestedWorld([
      sub("theirs", 5, { parent_released_at: EPOCH - H, owner_user_id: MATE }),
      sub("roled", 6, { parent_released_at: EPOCH - H, org_role_id: "org_roles_r" }),
      sub("authored", 7, { parent_released_at: EPOCH - H, author_user_id: MATE }),
      sub("mine", 8, { parent_released_at: EPOCH - H }),
    ]);
    const { sessions } = await computeInboxSessions({ db }, ME as any, { includeLiveness: false });
    expect(ids(sessions).filter((id) => id !== "lead")).toEqual(["mine"]);
  });

  // A child a role took, or one someone released, has left its parent's card
  // (isParentOwnedChild): neither read sends it under the lead stamped as the
  // lead's. Neither is mine, so no seat of its own masks the check.
  test("a role-owned or released child of a listed lead never rides the lead's card", async () => {
    const db = () => nestedWorld([
      sub("roled", 5, { org_role_id: "org_roles_r", role_started: true }),
      sub("theirs", 6, { parent_released_at: EPOCH - H, owner_user_id: MATE }),
      sub("kept", 7),
    ]);
    const underLead = (rows: any[]) => rows.filter((r: any) => r.owner_session_id === "conversations_lead").map((r: any) => String(r._id)).sort();
    const { sessions } = await computeInboxSessions({ db: db() }, ME as any, { includeLiveness: false });
    expect(ids(sessions)).toContain("lead");
    expect(underLead(sessions)).toEqual(["conversations_kept"]);
    const page = await collectInboxSessionsPaginated({ db: db() }, ME as any, { paginationOpts: { numItems: 50, cursor: null } });
    expect(page.page.map((r: any) => String(r._id))).toContain("conversations_lead");
    expect(underLead(page.page)).toEqual(["conversations_kept"]);
  });
});
