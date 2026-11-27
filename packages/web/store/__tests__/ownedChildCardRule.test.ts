// Which children ride a session's card under the owners model is the server's
// rule (shared ridesParentCard): its parent still owns it (no role took it,
// nobody released it) and it is none of the viewer's own inbox rows. These run
// the store end to end: an owners change paints the row, the change's
// acknowledgement lands, and the server's row echoes, in that order.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __resetInboxPlacementCacheForTests, drawnUnderParentIds, flatViewSessions, placeInboxRows, useInboxStore } from "../inboxStore";
import { applySessionOwnersRead } from "../../hooks/useSyncSessionOwners";
import { makeDispatchBinding } from "../../lib/dispatchBinding";
import { placeSections } from "./placeTestHarness";

const ME = "u_me";
const P = "p".repeat(32);
const C = "c".repeat(32);
const D = "d".repeat(32);
const ROLE = { role_id: "r_evals", short_id: "or-1", handle: "evals", name: "Evals" };
const NOW = Date.now();
const owner = {};

const st = () => useInboxStore.getState() as any;
const rowOf = (id: string) => st().sessions[id];
const base = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id, session_id: `s-${id.slice(0, 4)}`, title: id.slice(0, 4), user_id: ME, agent_type: "claude_code", message_count: 3,
  is_idle: true, has_pending: false, agent_status: "idle", status: "active", last_role_is_user: false,
  updated_at: NOW - 60_000, agent_status_updated_at: NOW - 60_000, started_at: NOW - 3_600_000,
  owners_model: true, owned_by_me: false, implicit_owner: null, org_role_id: null, owner_session_id: null, ...over,
});
// The inbox read's slim row for a child P owns.
const slim = (id: string, over: Record<string, unknown> = {}) =>
  base(id, { owner_session_id: P, parent_conversation_id: P, is_subagent: true, parent_released_at: null, adopted_at: null, ...over });
const lead = () => base(P, { owned_by_me: true, updated_at: NOW - 1_000 });
const read = (id: string, over: Record<string, unknown> = {}) => ({
  session_owners: true, conversation_id: id, people: [], role: null, parent_session: null, implicit_starter: null,
  starter_id: ME, role_started: false, can_edit: true, owners_changed_at: 1, ...over,
});
const me = { user_id: ME, name: "Me", email: null, added_by: ME, added_at: 1 };
const onP = () => {
  __resetInboxPlacementCacheForTests();
  return (placeInboxRows(st(), { now: Date.now() }).subsByParent.get(P) ?? []).map((s) => s._id);
};
const push = (rows: unknown[]) => st().syncTable("sessions", rows, { isDelta: true });
const tick = () => new Promise((r) => setTimeout(r, 0));

let calls: Array<{ action: string; resolve: (v: unknown) => void }> = [];
const ack = async (i: number) => {
  calls[i].resolve(null);
  for (let n = 0; n < 5; n++) await tick();
};

function setup(sessions: any[]) {
  calls = [];
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Me" } as any,
    pending: {},
    sessionOwners: {},
    sessions: Object.fromEntries(sessions.map((s) => [s._id, s])),
    clientState: { ...(st().clientState ?? {}), ui: { ...(st().clientState?.ui ?? {}), inbox_show_old: true } },
  } as any);
  st()._setDispatch(makeDispatchBinding((a) => new Promise((resolve) => { calls.push({ action: a.action, resolve }); })), { owner });
}
afterEach(() => st()._clearDispatch(owner));

describe("a child a role took leaves its old parent's card", () => {
  beforeEach(() => {
    setup([lead(), slim(C)]);
    applySessionOwnersRead(C, read(C, { parent_session: { conversation_id: P, short_id: "pppp", title: "lead" } }));
  });

  test("filed to a role: off the card on the press, and still off it after the ack and the server's row", async () => {
    expect(onP()).toEqual([C]);
    st().applySessionOwners(C, { role: ROLE.role_id }, { role: null });
    // The shared owners rule keeps the parent as an owner beside the role.
    expect(rowOf(C)).toMatchObject({ org_role_id: ROLE.role_id, owner_session_id: P });
    expect(onP()).toEqual([]);
    await tick();
    await ack(0);
    // byIds' answer for a role-owned child is the full row: the same stamps.
    push([{ ...rowOf(C), org_role_id: ROLE.role_id, owner_session_id: P, owned_by_me: false }]);
    expect(onP()).toEqual([]);
  });

  test("a cached row the server stamped with a role never rides the card", () => {
    push([{ ...rowOf(C), org_role_id: ROLE.role_id }]);
    expect(onP()).toEqual([]);
  });
});

describe("a session dropped on another card rides that card", () => {
  // 25 children P owns, every one started after D: past the newest 20.
  const kids = Array.from({ length: 25 }, (_, i) => slim(`k${String(i).padStart(2, "0")}`.padEnd(32, "0"), { started_at: NOW - 600_000 + i * 1_000 }));

  beforeEach(() => {
    setup([lead(), ...kids, base(D, { owned_by_me: true, started_at: NOW - 7 * 86_400_000 })]);
    applySessionOwnersRead(D, read(D, { people: [me] }));
  });

  // A session released from an earlier parent carries parent_released_at; the
  // adopt clears it (as the server's adopt does), or it would ride no card and
  // be out of the inbox until the server answered.
  test("a session once released from a parent is on the target's card on the press", () => {
    useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [D]: { ...s.sessions[D], parent_released_at: NOW - 60_000 } } }));
    st().applySessionOwners(D, { adopt_parent: P }, { detach_parent: true, restore: [{ user_id: ME, added_by: ME, added_at: 1 }] });
    expect(rowOf(D).parent_released_at ?? null).toBeNull();
    expect(onP()).toContain(D);
  });

  test("on the card on the press, and still there after the ack and the echo, past 20 newer children", async () => {
    expect(onP()).not.toContain(D);
    st().applySessionOwners(D, { adopt_parent: P }, { detach_parent: true, restore: [{ user_id: ME, added_by: ME, added_at: 1 }] });
    expect(rowOf(D)).toMatchObject({ owned_by_me: false, owner_session_id: P, parent_conversation_id: P });
    expect(rowOf(D).adopted_at).toBeGreaterThan(0);
    expect(onP()).toContain(D);
    await tick();
    await ack(0);
    // The inbox read's slim row for it: the server's own adopted_at, and a
    // real is_subagent (it runs its own process).
    push([slim(D, { adopted_at: NOW + 5, is_subagent: false, started_at: rowOf(D).started_at })]);
    expect(rowOf(D).adopted_at).toBe(NOW + 5);
    const nested = onP();
    expect(nested).toContain(D);
    // The horizon still cuts the oldest plain children.
    expect(nested).toHaveLength(21);
    expect(nested).not.toContain(kids[0]._id);
  });

  test("a detach takes it off the card on the press", () => {
    push([slim(D, { adopted_at: NOW - 1_000, is_subagent: false })]);
    applySessionOwnersRead(D, read(D, { parent_session: { conversation_id: P, short_id: "pppp", title: "lead" } }));
    expect(onP()).toContain(D);
    st().applySessionOwners(D, { detach_parent: true, add: [ME] }, null);
    expect(rowOf(D)).toMatchObject({ parent_conversation_id: null, adopted_at: null, owner_session_id: null });
    expect(onP()).not.toContain(D);
  });
});

describe("a child whose wait reached the viewer is theirs, not the card's", () => {
  test("it takes its own place and rides no card", () => {
    setup([lead(), slim(C, { wait_up_person: ME, wait_up_count: 3, wait_up_at: NOW - 1_000 })]);
    __resetInboxPlacementCacheForTests();
    const placed = placeInboxRows(st(), { now: Date.now() });
    expect((placed.subsByParent.get(P) ?? []).map((s) => s._id)).not.toContain(C);
    expect(placed.placements.has(C)).toBe(true);
  });
});

// The flat views hoist a teammate under its lead whatever section each was
// placed in (hoistNestedUnderParent); the nested look must say the same.
describe("a flat view's nested look follows where the list puts a row", () => {
  test("a teammate pinned on its own is drawn under its lead", () => {
    const L = "l".repeat(32);
    const T = "t".repeat(32);
    const leadRow = base(L, { owners_model: undefined, agent_team_name: "team", agent_name: "team-lead", agent_status: "working", is_idle: false, updated_at: NOW - 1_000, agent_status_updated_at: NOW - 1_000, last_heartbeat: NOW - 1_000, daemon_alive_until: NOW + 80_000 });
    const mate = base(T, { owners_model: undefined, spawned_by_conversation_id: L, agent_team_name: "team", agent_name: "rev", inbox_pinned_at: NOW - 500, is_pinned: true });
    const p = placeSections({ [L]: leadRow, [T]: mate } as any, new Set(), undefined, { currentUser: { _id: ME } });
    expect([...p.subsByParent.values()].flat().map((s) => s._id)).not.toContain(T);
    const flat = flatViewSessions(p.sorted, p.subsByParent, { mode: "recent", showSubagents: false });
    expect(flat.map((s) => s._id)).toEqual([L, T]);
    expect([...drawnUnderParentIds(flat, p.subsByParent)]).toEqual([T]);
  });
});
