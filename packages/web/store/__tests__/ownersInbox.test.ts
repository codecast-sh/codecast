import { describe, expect, it } from "bun:test";
import { makeFakeDb } from "@codecast/convex/convex/testDb";
import { collectInboxSessionsByIds } from "@codecast/convex/convex/conversations";
import { settleDisownClaims } from "../../hooks/useLiveInboxSessions";
import {
  claimsViewer,
  isForeignRow,
  isSpawnedWorker,
  personSessionWorkState,
  sessionWorkState,
  useInboxStore,
  type InboxSession,
  type SessionDecisionItem,
} from "../inboxStore";
import { placeSections } from "./placeTestHarness";
import { waitingSoundKey } from "../../hooks/useSyncInboxSessions";
import { countsDigest } from "../../hooks/useProjectSessionCounts";
import { sessionStanding } from "../../lib/instantSessionSearch";
import { buildDecisionQueue } from "../../hooks/useDecisionQueue";
import { fleetBandFor } from "../../components/fleetBands";
import { sessionStatusOf } from "../../lib/sessionStatus";

// The owners model (team feature session_owners) on the replica. The server
// stamps owners_model (and the viewer's claim, owned_by_me) and owner_session_id
// only on a row its team's flag applies to, so every case runs the same row
// with the stamp (flag on) and without it (flag off): off is today's inbox.

const ME = "users_me";
const MATE = "users_mate";
const T0 = Date.now();

// A settled turn with content, as the server ships it: needs input on its own facts.
const row = (id: string, over: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `sess-${id}`,
  user_id: ME,
  agent_type: "claude_code",
  agent_status: "idle",
  is_idle: true,
  has_pending: false,
  message_count: 3,
  updated_at: T0 - 60_000,
  agent_status_updated_at: T0 - 60_000,
  last_role_is_user: false,
  title: id,
  ...(over as any),
});
// Under the model; `people` names who owns it, which on a row is only whether
// the viewer does (owned_by_me), never the list.
const on = (s: InboxSession, people: string[] = [ME]): InboxSession => ({ ...s, owners_model: true, owned_by_me: people.includes(ME) });
const ids = (xs: InboxSession[]) => xs.map((s) => s._id).sort();
const place = (rows: InboxSession[], decisions: Record<string, SessionDecisionItem> = {}) =>
  placeSections(Object.fromEntries(rows.map((s) => [s._id, s])), new Set(), undefined, { sessionDecisions: decisions, currentUser: { _id: ME } });
const shown = (p: ReturnType<typeof place>) => ids([...p.questions, ...p.needsInput, ...p.working, ...p.done, ...p.dormant, ...p.pinned, ...p.newSessions]);

describe("membership: the inbox is the sessions you own", () => {
  it("flag on: the viewer's claim decides, whoever runs it; flag off: the runner and assignment decide as today", () => {
    const mineRun = row("a1234567890123456789012345678901");
    const handed = row("b1234567890123456789012345678901", { owner_user_id: MATE, owned_by_me: false });
    const theirsOwned = row("c1234567890123456789012345678901", { user_id: MATE, owner_user_id: ME, owned_by_me: true });
    // Flag on, the same three, plus a run of mine a role started (no people).
    const roleStarted = row("d1234567890123456789012345678901", { org_role_id: "r", role_started: true });
    expect([mineRun, handed, theirsOwned].map((s) => isForeignRow(s, ME))).toEqual([false, true, false]);
    expect([on(mineRun), on(handed, [MATE]), on(theirsOwned, [ME]), on(roleStarted, [])].map((s) => isForeignRow(s, ME))).toEqual([false, true, false, true]);
    // Off the model a role-started run is the runner's, as today.
    expect(isForeignRow(roleStarted, ME)).toBe(false);
  });

  it("flag on: a nested row the viewer owns is its own card; a parent-owned one is out; a plain spawn is its starter's; flag off: nested rows nest under their parent", () => {
    const parent = row("parent");
    const sub = row("sub", { is_subagent: true, parent_conversation_id: "parent" });
    // A worker nested under the parent (`cast spawn --subagent`): the parent owns it.
    const worker = row("worker", { parent_conversation_id: "parent" });
    // A plain spawn: the spawner's peer, so the server stamps no owner session.
    const peer = row("spawned", { spawned_by_conversation_id: "parent" });
    // A subagent is a member through the viewer's owner row (the owned window).
    const onPlaced = place([
      on(parent),
      on({ ...sub, owner_session_id: "parent", owned_by_me: true }),
      on({ ...worker, owner_session_id: "parent" }, []),
      on({ ...peer, owner_session_id: null, implicit_owner: ME }, []),
    ]);
    expect(shown(onPlaced)).toEqual(["parent", "spawned", "sub"]);
    expect(onPlaced.placements.get("sub")).toMatchObject({ bucket: "working", work_state: "needs_input" });
    expect(isSpawnedWorker(on(peer, []))).toBe(false);
    const offPlaced = place([parent, sub, worker, peer]);
    expect(offPlaced.placements.has("sub")).toBe(false);
    expect(shown(offPlaced)).toEqual(["parent", "spawned"]);
  });

  it("the implicit starter is a member without an owner row", () => {
    expect(isForeignRow({ ...row("i1234567890123456789012345678901"), owners_model: true, implicit_owner: ME }, ME)).toBe(false);
    expect(isForeignRow({ ...row("j1234567890123456789012345678901"), owners_model: true, implicit_owner: MATE }, ME)).toBe(true);
  });

  it("a disown that drops the row from the live list clears the viewer's claim, so it cannot come back as mine", () => {
    const id = "e1234567890123456789012345678901";
    const prev = useInboxStore.getState();
    useInboxStore.setState({ currentUser: { _id: ME } as any, sessions: { [id]: on(row(id), [MATE, ME]) } });
    expect(claimsViewer(useInboxStore.getState().sessions[id], ME)).toBe(true);
    useInboxStore.getState().clearDisownedClaims([id]);
    const after = useInboxStore.getState().sessions[id];
    expect(after.owned_by_me).toBe(false);
    expect(isForeignRow(after, ME)).toBe(true);
    useInboxStore.setState({ currentUser: prev.currentUser, sessions: prev.sessions });
  });
});

describe("placement: a wait its agent owner answers files as working, With <owner>", () => {
  it("a role owner: flag on working with the raw state kept; flag off needs input as today", () => {
    const hand = row("hand", { org_role_id: "r" });
    expect(place([on(hand)]).placements.get("hand")).toMatchObject({ bucket: "working", work_state: "needs_input" });
    expect(place([hand]).placements.get("hand")).toMatchObject({ bucket: "needs_input", work_state: "needs_input" });
  });

  it("an open prompt is the agent's under the flag; a decision asked of the viewer still reaches them; flag off the prompt is a question", () => {
    const asking = row("ask", { org_role_id: "r", awaiting_input: true });
    expect(ids(place([on(asking)]).questions)).toEqual([]);
    expect(ids(place([on(asking)]).working)).toEqual(["ask"]);
    const decide: SessionDecisionItem = { _id: "d1", conversation_id: "ask", session_id: "sess-ask", question: "q", options: [{ label: "a" }, { label: "b" }], blocking: true, status: "pending", created_at: T0 } as any;
    expect(ids(place([on(asking)], { d1: decide }).questions)).toEqual(["ask"]);
    expect(ids(place([asking]).questions)).toEqual(["ask"]);
  });

  it("a wait passed up (no message since its stamp) is Needs You again", () => {
    const hand = on(row("hand", { org_role_id: "r", wait_up_at: T0 - 30_000, wait_up_count: 3 }));
    expect(place([hand]).placements.get("hand")!.bucket).toBe("needs_input");
  });

  it("no child ask lifts its parent under the flag; off it, it does", () => {
    const parent = row("parent", { agent_status: "working", is_idle: false });
    const sub = row("sub", { is_subagent: true, parent_conversation_id: "parent", awaiting_input: true });
    expect(ids(place([parent, sub]).questions)).toEqual(["parent"]);
    expect(ids(place([on(parent), on({ ...sub, owner_session_id: "parent" }, [])]).questions)).toEqual([]);
  });
});

describe("review of ct-100061: escalations, pins and mixed teams", () => {
  it("an escalated wait is in the inbox of the person it reached until the next message", () => {
    const run = on(row("g1234567890123456789012345678901", { user_id: "users_bot", org_role_id: "r", role_started: true, wait_up_count: 3, wait_up_person: ME }), []);
    expect(isForeignRow(run, ME)).toBe(false);
    expect(isForeignRow({ ...run, message_count: 4 }, ME)).toBe(true);
  });

  it("an escalated permission prompt files under questions from its row alone: no liveness rides it", () => {
    const run = on(row("m1234567890123456789012345678901", { user_id: "users_bot", org_role_id: "r", role_started: true, agent_status: undefined, wait_up_at: T0 - 30_000, wait_up_count: 3, wait_up_person: ME, needs_input_notified_key: "3:permission_blocked" }), []);
    expect(ids(place([run]).questions)).toEqual([run._id]);
    // An episode before the current turn says nothing about this wait.
    expect(ids(place([{ ...run, needs_input_notified_key: "2:permission_blocked" }]).questions)).toEqual([]);
  });

  it("an escalation that only fell past its window's cap keeps its claim: byIds still answers it to its person", async () => {
    const id = "k1234567890123456789012345678901";
    const TEAM = "teams_acme";
    const escalated = { _id: id, user_id: "users_bot", team_id: TEAM, is_private: false, status: "active", title: "role run", org_role_id: "org_roles_r", role_started: true, message_count: 3, updated_at: T0 - 60_000, started_at: T0 - 120_000, wait_up_at: T0 - 30_000, wait_up_count: 3, wait_up_person: ME };
    const db = makeFakeDb({
      teams: [{ _id: TEAM, name: "Acme", features: { session_owners: true } }],
      users: [{ _id: ME, name: "Me" }, { _id: "users_bot", name: "Bot", is_bot: true }],
      team_memberships: [ME, "users_bot"].map((u) => ({ _id: `tm_${u}`, user_id: u, team_id: TEAM, role: "member", joined_at: 1, visibility: "full" })),
      conversations: [escalated],
      session_owners: [], managed_sessions: [], messages: [], session_decisions: [], decision_inbox: [],
    });
    const convex = { query: async (_fn: unknown, args: { ids: string[] }) => collectInboxSessionsByIds({ db }, ME as any, args.ids) };
    const prev = useInboxStore.getState();
    useInboxStore.setState({ currentUser: { _id: ME } as any, sessions: { [id]: on(row(id, { ...escalated, user_id: "users_bot" } as any), []) } });
    try {
      // It left the live list only because the escalated window's cap cut it.
      await settleDisownClaims(convex, [id]);
      expect(useInboxStore.getState().sessions[id]).toMatchObject({ wait_up_person: ME });
      expect(isForeignRow(useInboxStore.getState().sessions[id], ME)).toBe(false);
      // Once the escalation really ended (the next message cleared it), byIds
      // omits the row and the claim clears.
      await db.patch(id, { message_count: 4, wait_up_at: undefined, wait_up_count: undefined, wait_up_person: undefined });
      await settleDisownClaims(convex, [id]);
      expect(isForeignRow(useInboxStore.getState().sessions[id], ME)).toBe(true);
    } finally {
      useInboxStore.setState({ currentUser: prev.currentUser, sessions: prev.sessions });
    }
  });

  it("a pinned agent-answered wait reads working for project counts and plan groups", () => {
    const pinned = on(row("h1234567890123456789012345678901", { org_role_id: "r", project_id: "proj1", is_pinned: true, inbox_pinned_at: T0 - 1000 }));
    expect(personSessionWorkState(pinned)).toBe("working");
    expect(countsDigest({ sessions: { [pinned._id]: pinned } }, "*", null, T0, { current: null })).toBe("proj1=working:1");
  });

  it("a flag-off child's ask never lifts a parent under the model (the server's rowAsks agrees)", () => {
    const parent = on(row("parent", { agent_status: "working", is_idle: false }));
    const sub = row("sub", { is_subagent: true, parent_conversation_id: "parent", awaiting_input: true });
    expect(ids(place([parent, sub]).questions)).toEqual([]);
  });
});

describe("re-review of ct-100061: a card's word agrees with its section", () => {
  it("an agent-answered wait in Questions, or one the person filed, says Needs you; otherwise Working", () => {
    const hand = on(row("hand", { org_role_id: "r" }));
    const word = (r: InboxSession, bucket: string) => sessionStatusOf({ row: r as any, section: null, placement: { bucket, state: "needs_input" }, now: T0 });
    expect(word(hand, "pinned")).toBe("working");
    expect(word(hand, "questions")).toBe("needs_you");
    expect(word({ ...hand, user_rest: "needs_input" }, "pinned")).toBe("needs_you");
    // The person's filing as the server stamps it (inbox_rest, current by userRestOf), before user_rest is derived.
    expect(word({ ...hand, inbox_rest: "needs_input", inbox_rest_at: T0 } as InboxSession, "pinned")).toBe("needs_you");
    expect(word(row("off", { org_role_id: "r" }), "pinned")).toBe("needs_you");
  });
});

describe("person-facing readers read the person's state", () => {
  const hand = row("f1234567890123456789012345678901", { org_role_id: "r", project_id: "proj1" });

  it("the chime rings nobody for an agent-answered wait; off the flag it rings", () => {
    expect(waitingSoundKey(on(hand), new Set())).toBeNull();
    expect(waitingSoundKey(hand, new Set())).not.toBeNull();
  });

  it("project counts, the palette and the fleet read working; agents still read the raw state", () => {
    expect(personSessionWorkState(on(hand))).toBe("working");
    expect(sessionWorkState(on(hand))).toBe("needs_input");
    expect(personSessionWorkState(hand)).toBe("needs_input");
    const counts = (s: InboxSession) => countsDigest({ sessions: { [s._id]: s } }, "*", null, T0, { current: null });
    expect(counts(on(hand))).toBe("proj1=working:1");
    expect(counts(hand)).toBe("proj1=needs_input:1");
    expect(sessionStanding(on(hand), ME, on(hand)).state).toBe("working");
    expect(sessionStanding(hand, ME, hand).state).toBe("needs_input");
    const opts = { now: T0, queued: new Set<string>(), pendingSendIds: new Set<string>() } as any;
    expect(fleetBandFor(on({ ...hand, awaiting_input: true }), opts)).toBe("running");
    expect(fleetBandFor({ ...hand, awaiting_input: true }, opts)).toBe("needsYou");
  });

  it("the decision queue leaves an agent-answered prompt to its agent", () => {
    const asking = { ...hand, awaiting_input: true };
    expect(buildDecisionQueue({}, { [asking._id]: on(asking) }, {}, ME).length).toBe(0);
    expect(buildDecisionQueue({}, { [asking._id]: asking }, {}, ME).length).toBe(1);
  });
});

