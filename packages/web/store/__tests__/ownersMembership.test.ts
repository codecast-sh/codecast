// Inbox membership and placement under the owners model read the inbox row's
// stamps only. An owners change paints them (sessionOwnersSlice) beside the
// owners read, each under the ordinary field lock, so Add me, leaving and
// Take it over move the row in the same tick and hold through echoes that
// arrive in any order. The change's acknowledgement settles those locks on
// whatever the server answers since (settleAckedLocks): a concurrent change
// lands, a follower's change settles on the host, and a lock that never hears
// its acknowledgement gives way at the triage bound.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { agentAnswersRow } from "@codecast/shared/contracts";
import { useInboxStore, filterInboxScopeFromState, HIDDEN_OVERRIDE_SETTLE_MS } from "../inboxStore";
import { ownerIdsOf } from "../sessionOwnersSlice";
import { applySessionOwnersRead } from "../../hooks/useSyncSessionOwners";
import { makeDispatchBinding } from "../../lib/dispatchBinding";
import { _ackedScanCount } from "../syncProtocol";

const S = "s".repeat(32);
const ME = "u_me";
const ASHOT = "u_ashot";
const BO = "u_bo";
const ROLE = { role_id: "r_evals", short_id: "or-1", handle: "evals", name: "Evals" };
const owner = {};

const person = (id: string, added_at: number) => ({ user_id: id, name: id, email: null, added_by: ASHOT, added_at });
const read = (people: unknown[], over: Record<string, unknown> = {}) => ({ session_owners: true, conversation_id: S, people, role: null, parent_session: null, implicit_starter: null, starter_id: ASHOT, role_started: false, can_edit: true, owners_changed_at: 1, ...over });
const st = () => useInboxStore.getState() as any;
const inMyInbox = () => S in filterInboxScopeFromState(st());
const rowOf = () => st().sessions[S];
// The server's inbox row for S, as a feed pushes it.
const push = (over: Record<string, unknown>) => st().syncTable("sessions", [{ ...rowOf(), ...over }], { isDelta: true });
const ownersLocks = () => Object.keys(st().pending).filter((k) => k.startsWith(`sessionOwners:${S}:`) || /^sessions:[^:]+:(owned_by_me|implicit_owner|org_role_id|owner_session_id)$/.test(k));
const tick = () => new Promise((r) => setTimeout(r, 0));

// A dispatch whose answers the test hands out: each call waits until answered.
let calls: Array<{ action: string; args: any; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
const answer = async (i: number, ok = true) => {
  if (ok) calls[i].resolve(null); else calls[i].reject(new Error("Uncaught Error: Only its owners can change who owns it"));
  for (let n = 0; n < 5; n++) await tick();
};

beforeEach(() => {
  calls = [];
  useInboxStore.setState({
    currentUser: { _id: ME, name: "Me" } as any,
    pending: {},
    sessionOwners: {},
    sessions: { [S]: { _id: S, session_id: S, title: "Freeze case", user_id: ASHOT, owners_model: true, owned_by_me: false, implicit_owner: null, org_role_id: null, owner_session_id: null, updated_at: Date.now(), message_count: 3 } as any },
  } as any);
  st()._setDispatch(makeDispatchBinding((a) => new Promise((resolve, reject) => { calls.push({ action: a.action, args: a.args, resolve, reject }); })), { owner });
  applySessionOwnersRead(S, read([person(ASHOT, 1)]));
});
afterEach(() => st()._clearDispatch(owner));

test("Add me puts the session in my inbox in the same tick, and leaving takes it out", async () => {
  expect(inMyInbox()).toBe(false);
  st().applySessionOwners(S, { add: [ME] }, { remove: [ME] });
  expect(inMyInbox()).toBe(true);
  expect(rowOf().owned_by_me).toBe(true);
  await tick();
  await answer(0);
  st().applySessionOwners(S, { remove: [ME] }, { add: [ME] });
  expect(inMyInbox()).toBe(false);
});

test("a refused change puts back every field it painted", async () => {
  applySessionOwnersRead(S, read([person(ASHOT, 1), person(ME, 2)], { role: ROLE }));
  push({ owned_by_me: true, org_role_id: ROLE.role_id });
  st().applySessionOwners(S, { take_over: true, remove: [ASHOT] }, null);
  expect(rowOf().org_role_id).toBeNull();
  expect(st().sessionOwners[S].role).toBeNull();
  expect(st().sessionOwners[S].people_ids).toEqual([ME]);
  await tick();
  await answer(0, false);
  for (let i = 0; i < 50 && ownersLocks().length; i++) await tick();
  expect(ownersLocks()).toEqual([]);
  expect(rowOf().org_role_id).toBe(ROLE.role_id);
  expect(st().sessionOwners[S].role?.role_id).toBe(ROLE.role_id);
  expect(st().sessionOwners[S].people_ids).toEqual([ASHOT, ME]);
  expect(inMyInbox()).toBe(true);
});

test("Add me, a concurrent add of Bo (a value that never changes again, settled at its first apply after the ack), then Ashot removes me: I leave the inbox", async () => {
  st().applySessionOwners(S, { add: [ME] }, { remove: [ME] });
  await tick();
  // The server took Bo's add at the same moment: its echo is not the paint.
  applySessionOwnersRead(S, read([person(ASHOT, 1), person(ME, 2), person(BO, 3)]));
  push({ owned_by_me: true });
  await answer(0);
  // The ack puts back nothing the store saw before it.
  expect(ownerIdsOf(st(), S)).toEqual([ASHOT, ME]);
  // The value never changes again: the next read carries the same answer,
  // and that first apply after the ack settles it.
  applySessionOwnersRead(S, read([person(ASHOT, 1), person(ME, 2), person(BO, 3)]));
  expect(ownersLocks()).toEqual([]);
  expect(ownerIdsOf(st(), S)).toEqual([ASHOT, ME, BO]);
  // Ashot removes me.
  applySessionOwnersRead(S, read([person(ASHOT, 1), person(BO, 3)]));
  push({ owned_by_me: false });
  expect(inMyInbox()).toBe(false);
  expect(ownerIdsOf(st(), S)).toEqual([ASHOT, BO]);
});

test("the ack never puts back a value seen before it: Add me stays painted through a stale push and the ack, and settles on the next push", async () => {
  st().applySessionOwners(S, { add: [ME] }, { remove: [ME] });
  await tick();
  // Pushes from before the server applied the change, still in flight.
  push({ owned_by_me: false });
  applySessionOwnersRead(S, read([person(ASHOT, 1)]));
  await answer(0);
  expect(inMyInbox()).toBe(true);
  expect(ownerIdsOf(st(), S)).toEqual([ASHOT, ME]);
  // The batched feed's newer answer lands, and the locks go with it.
  push({ owned_by_me: true });
  applySessionOwnersRead(S, read([person(ASHOT, 1), person(ME, 2)]));
  expect(ownersLocks()).toEqual([]);
  expect(inMyInbox()).toBe(true);
});

test("the ack never puts back a value seen before it: Take it over keeps the role from answering, on the row and in the read, until the next push", async () => {
  applySessionOwnersRead(S, read([person(ASHOT, 1), person(ME, 2)], { role: ROLE }));
  push({ owned_by_me: true, org_role_id: ROLE.role_id });
  st().applySessionOwners(S, { take_over: true }, null);
  await tick();
  push({ org_role_id: ROLE.role_id });
  applySessionOwnersRead(S, read([person(ASHOT, 1), person(ME, 2)], { role: ROLE }));
  await answer(0);
  expect(agentAnswersRow(rowOf())).toBe(false);
  expect(st().sessionOwners[S].role).toBeNull();
  push({ org_role_id: null });
  applySessionOwnersRead(S, read([person(ASHOT, 1), person(ME, 2)]));
  expect(ownersLocks()).toEqual([]);
  expect(agentAnswersRow(rowOf())).toBe(false);
});

test("no flicker: the owners echo before the row's, and a stale row push between, leave Add me in and Take it over taken", async () => {
  st().applySessionOwners(S, { add: [ME] }, { remove: [ME] });
  applySessionOwnersRead(S, read([person(ASHOT, 1), person(ME, 2)]));
  expect(inMyInbox()).toBe(true);
  push({ owned_by_me: false });
  expect(inMyInbox()).toBe(true);
  push({ owned_by_me: true });
  expect(inMyInbox()).toBe(true);
  await tick();
  await answer(0);

  applySessionOwnersRead(S, read([person(ASHOT, 1), person(ME, 2)], { role: ROLE }));
  push({ org_role_id: ROLE.role_id });
  expect(agentAnswersRow(rowOf())).toBe(true);
  st().applySessionOwners(S, { take_over: true }, null);
  expect(agentAnswersRow(rowOf())).toBe(false);
  applySessionOwnersRead(S, read([person(ASHOT, 1), person(ME, 2)]));
  push({ org_role_id: ROLE.role_id });
  expect(agentAnswersRow(rowOf())).toBe(false);
  push({ org_role_id: null });
  expect(agentAnswersRow(rowOf())).toBe(false);
});

test("a follower's change settles on the host: the host's mirrored lock retires on the follower's acknowledgement", () => {
  // The host mirrors the follower's paint (a replicated mut) under a lock.
  st().applyReplicatedFields("sessions", { [S]: { owned_by_me: true } }, Date.now() - 5);
  expect(st().pending[`sessions:${S}:owned_by_me`]).toBeDefined();
  // The server's answer differs from the paint (removed again at once by
  // Ashot): the lock hides it.
  push({ owned_by_me: false });
  expect(rowOf().owned_by_me).toBe(true);
  // The follower's dispatch was acknowledged: it tells the host, whose next
  // push of the row settles it.
  st().applyGestureBridge({ kind: "settle", locks: [{ key: `sessions:${S}:owned_by_me`, value: true }], lockIds: ["follower-lock"], sentAt: Date.now(), ts: Date.now() });
  expect(rowOf().owned_by_me).toBe(true);
  push({ owned_by_me: false });
  expect(st().pending[`sessions:${S}:owned_by_me`]).toBeUndefined();
  expect(rowOf().owned_by_me).toBe(false);
});

test("a settle that reaches the host before the follower's mut settles that mut's lock when it lands", () => {
  st().applyGestureBridge({ kind: "settle", locks: [{ key: `sessions:${S}:owned_by_me`, value: true }], lockIds: ["follower-lock"], sentAt: Date.now(), ts: Date.now() });
  st().applyReplicatedFields("sessions", { [S]: { owned_by_me: true } }, Date.now() - 5);
  expect(st().pending[`sessions:${S}:owned_by_me`]?.acked).toBe(true);
  push({ owned_by_me: false });
  expect(st().pending[`sessions:${S}:owned_by_me`]).toBeUndefined();
  expect(rowOf().owned_by_me).toBe(false);
});

test("a leave sent offline pins nothing: a re-add shows at once, and a lock that never hears back gives way at the bound", async () => {
  push({ owned_by_me: true });
  applySessionOwnersRead(S, read([person(ASHOT, 1), person(ME, 2)]));
  st().applySessionOwners(S, { remove: [ME] }, { add: [ME] });
  expect(inMyInbox()).toBe(false);
  // Offline: no answer. The person re-adds themselves.
  st().applySessionOwners(S, { add: [ME] }, { remove: [ME] });
  expect(inMyInbox()).toBe(true);
  // The window closed before either was answered: its locks are old now.
  const pending = { ...st().pending };
  for (const k of ownersLocks()) pending[k] = { ...pending[k], ts: Date.now() - HIDDEN_OVERRIDE_SETTLE_MS - 1 };
  useInboxStore.setState({ pending } as any);
  applySessionOwnersRead(S, read([person(ASHOT, 1)]));
  expect(st().sessionOwners[S].people_ids).toEqual([ASHOT]);
});

test("Take it over, then a whole inbox row that leaves org_role_id out: the server cleared it, and the acked lock retires", async () => {
  applySessionOwnersRead(S, read([person(ASHOT, 1), person(ME, 2)], { role: ROLE }));
  push({ owned_by_me: true, org_role_id: ROLE.role_id });
  st().applySessionOwners(S, { take_over: true }, null);
  await tick();
  await answer(0);
  expect(st().pending[`sessions:${S}:org_role_id`]?.acked).toBe(true);
  const { org_role_id: _cleared, ...without } = rowOf();
  st().syncTable("sessions", [without], { isDelta: true });
  expect(st().pending[`sessions:${S}:org_role_id`]).toBeUndefined();
  expect(rowOf().org_role_id ?? null).toBeNull();
  expect(agentAnswersRow(rowOf())).toBe(false);
});

test("with no acked lock, an apply does not scan the pending map", () => {
  // One scan finds none and clears the hint; applies after it look at nothing.
  push({ title: "first" });
  const scans = _ackedScanCount();
  for (let i = 0; i < 5; i++) push({ title: `push ${i}` });
  applySessionOwnersRead(S, read([person(ASHOT, 1), person(ME, 2)]));
  expect(_ackedScanCount()).toBe(scans);
});

test("a sessions push from a feed that carries no owners fields (no owners_model) leaves an acked lock and its value alone", async () => {
  st().applySessionOwners(S, { add: [ME] }, { remove: [ME] });
  await tick();
  await answer(0);
  expect(st().pending[`sessions:${S}:owned_by_me`]?.acked).toBe(true);
  // A team, crawl or killed-shelf row: no owners_model, no owner stamps.
  const { owned_by_me: _b, implicit_owner: _c, org_role_id: _a, owner_session_id: _d, owners_model: _e, ...bare } = rowOf();
  st().syncTable("sessions", [{ ...bare, title: "From a team feed" }], { isDelta: true });
  expect(st().pending[`sessions:${S}:owned_by_me`]?.acked).toBe(true);
  expect(rowOf().owned_by_me).toBe(true);
  expect(rowOf().title).toBe("From a team feed");
});
