import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetUndoStacks, getUndoHistory } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { performUndo } from "../undoStack";
import { ownerFactsOf, ownerIdsOf, ownersModelOnFor } from "../sessionOwnersSlice";
import { ownersOf } from "@codecast/shared/contracts/sessionOwners";
import { applySessionOwnersRead } from "../../hooks/useSyncSessionOwners";
import { agentOwnersOf } from "../../lib/sessionAgents";
import { coOwnersOf, coOwnersSig } from "../../lib/coOwners";
import { diffOwners } from "../../lib/ownersDraft";

// The owners model's one write (applySessionOwners): painted on the session
// row by the shared rule, reconciled by the owners read's echo, rolled back
// on a refusal, and undone by the change that puts it back.
const S = "s".repeat(32);
const ME = "u_me";
const ASHOT = "u_ashot";
const ROLE = "r_evals";

let sent: Array<{ action: string; args: any[] }> = [];
let refuse = false;
const owner = {};

const person = (id: string, added_at: number) => ({ user_id: id, name: id, email: null, added_by: ME, added_at });

function read(over: Record<string, unknown> = {}) {
  return {
    session_owners: true,
    conversation_id: S,
    people: [person(ME, 10)],
    role: null,
    parent_session: null,
    implicit_starter: null,
    starter_id: ME,
    role_started: false,
    can_edit: true,
    owners_changed_at: 1,
    ...over,
  };
}

const row = () => useInboxStore.getState().sessions[S] as any;
const facts = () => ownerFactsOf(useInboxStore.getState() as any, S)!;
const owners = () => ownerIdsOf(useInboxStore.getState() as any, S);
const peopleIds = () => (useInboxStore.getState() as any).sessionOwners[S].people_ids;
const locks = () => Object.keys(useInboxStore.getState().pending as any).filter((k) => k.startsWith(`sessions:${S}:`) || k.startsWith(`sessionOwners:${S}:`));

describe("applySessionOwners", () => {
  beforeEach(() => {
    _resetUndoStacks();
    sent = [];
    refuse = false;
    useInboxStore.setState({
      currentUser: { _id: ME, name: "Me" } as any,
      pending: {},
      sessions: { [S]: { _id: S, session_id: S, title: "Freeze case", user_id: ME, owners_model: true, owned_by_me: true, org_role_id: null, owner_session_id: null, updated_at: 1 } as any },
      conversations: { [S]: { _id: S, title: "Freeze case" } as any },
      sessionOwners: {},
    } as any);
    useInboxStore.getState()._setDispatch(async (action, args) => {
      sent.push({ action, args });
      if (refuse && action === "applySessionOwners") throw new Error("Uncaught Error: Only its owners can change who owns it");
      return null;
    }, { owner });
    applySessionOwnersRead(S, read());
  });
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  test("the owners read marks the session as under the model and feeds both twins", () => {
    expect(ownersModelOnFor(useInboxStore.getState() as any, S)).toBe(true);
    expect(peopleIds()).toEqual([ME]);
    expect((useInboxStore.getState() as any).sessionOwners[S].can_edit).toBe(true);
  });

  test("the role and the parent come from the owners read, whatever the row says", () => {
    const state = {
      sessions: { [S]: { _id: S, org_role_id: null } },
      sessionOwners: { [S]: { _id: S, people_ids: [], people_info: {}, role: { role_id: ROLE, short_id: null, handle: "evals", name: "Evals" }, parent_session: null, implicit_starter: null, starter_id: ME, role_started: false, can_edit: true, owners_changed_at: 1 } },
    };
    expect(ownerFactsOf(state as any, S)?.org_role_id).toBe(ROLE);
  });

  test("a session with no owner fields and no read is off the model, and a cached row of another shape is no read", () => {
    expect(ownersModelOnFor({ sessions: { x: { _id: "x" } }, sessionOwners: {} } as any, "x")).toBe(false);
    expect(ownersModelOnFor({ sessions: { x: { _id: "x" } }, sessionOwners: { x: { _id: "x", owners: [] } } } as any, "x")).toBe(false);
    expect(ownersModelOnFor({ sessions: { x: { _id: "x", owners_model: true } }, sessionOwners: {} } as any, "x")).toBe(true);
  });

  test("a row cached before the flag turned on still opens the new menu once its owners read says the model", () => {
    const read = { _id: "x", people_ids: [], people_info: {}, role: null, parent_session: null, implicit_starter: null, starter_id: ME, role_started: false, can_edit: true, owners_changed_at: null };
    expect(ownersModelOnFor({ sessions: { x: { _id: "x" } }, sessionOwners: { x: read } } as any, "x")).toBe(true);
    // The flag going off: the read comes back off the model and drops the cached one.
    useInboxStore.setState({ sessionOwners: { [S]: { ...read, _id: S } } } as any);
    applySessionOwnersRead(S, { owners: [], team: null });
    expect((useInboxStore.getState() as any).sessionOwners[S]).toBeUndefined();
  });

  test("Save paints the people and the role on the owners read and the inbox row at once, and sends one change", async () => {
    useInboxStore.getState().applySessionOwners(S, { add: [ASHOT], role: ROLE }, { remove: [ASHOT], role: null });
    expect(owners()).toEqual([ME, ASHOT]);
    expect(facts().org_role_id).toBe(ROLE);
    expect(row().org_role_id).toBe(ROLE);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.filter((x) => x.action === "applySessionOwners").map((x) => x.args[1])).toEqual([{ add: [ASHOT], role: ROLE }]);
  });

  test("a stale read keeps the paint; the read that matches releases it", () => {
    useInboxStore.getState().applySessionOwners(S, { add: [ASHOT] }, { remove: [ASHOT] });
    expect(locks().length).toBeGreaterThan(0);
    applySessionOwnersRead(S, read({ owners_changed_at: 2 }));
    expect(owners()).toEqual([ME, ASHOT]);
    applySessionOwnersRead(S, read({ people: [person(ME, 10), person(ASHOT, 20)], owners_changed_at: 3 }));
    expect(owners()).toEqual([ME, ASHOT]);
    expect(locks()).toEqual([]);
  });

  test("a second change before the server answers starts from the first", () => {
    useInboxStore.getState().applySessionOwners(S, { add: [ASHOT] }, null);
    useInboxStore.getState().applySessionOwners(S, { role: ROLE }, null);
    expect(owners()).toEqual([ME, ASHOT]);
    expect(facts().org_role_id).toBe(ROLE);
  });

  test("take it over removes the role and the parent, and keeps you", () => {
    applySessionOwnersRead(S, read({ people: [], role: { role_id: ROLE, short_id: "or-1", handle: "evals", name: "Eval Suite lead" }, parent_session: { conversation_id: "p".repeat(32), short_id: "p1", title: "Parent" } }));
    expect(facts().org_role_id).toBe(ROLE);
    expect(facts().parent_conversation_id).toBe("p".repeat(32));
    useInboxStore.getState().applySessionOwners(S, { take_over: true }, null);
    expect(owners()).toEqual([ME]);
    expect(facts().org_role_id).toBeNull();
    expect(facts().parent_conversation_id).toBeNull();
  });

  test("removing the only agent brings the implicit starter back, as the server does", () => {
    applySessionOwnersRead(S, read({ people: [], role: { role_id: ROLE, short_id: "or-1", handle: "evals", name: "Eval Suite lead" } }));
    expect(owners()).toEqual([]);
    useInboxStore.getState().applySessionOwners(S, { role: null }, { role: ROLE });
    expect(owners()).toEqual([ME]);
    expect(facts().org_role_id).toBeNull();
  });

  test("leaving and rejoining paint owned_by_me on the row, under its lock", () => {
    applySessionOwnersRead(S, read({ people: [person(ME, 10), person(ASHOT, 20)] }));
    useInboxStore.getState().applySessionOwners(S, { remove: [ME] }, { add: [ME] });
    expect(owners()).toEqual([ASHOT]);
    expect(row().owned_by_me).toBe(false);
    expect(locks()).toContain(`sessions:${S}:owned_by_me`);
    useInboxStore.getState().applySessionOwners(S, { add: [ME] }, { remove: [ME] });
    expect(owners()).toEqual([ASHOT, ME]);
    expect(row().owned_by_me).toBe(true);
  });


  test("removing the role leaves your owner row, so you are nobody's implicit owner", () => {
    applySessionOwnersRead(S, read({ people: [person(ME, 10)], role: { role_id: ROLE, short_id: "or-1", handle: "evals", name: "Eval Suite lead" } }));
    useInboxStore.getState().applySessionOwners(S, { role: null }, { role: ROLE });
    expect(ownersOf(facts()).implicitStarter).toBeNull();
    expect(owners()).toEqual([ME]);
  });

  test("taking it over clears the role even on a row the server sent without one", () => {
    applySessionOwnersRead(S, read({ role: { role_id: ROLE, short_id: "or-1", handle: "evals", name: "Eval Suite lead" } }));
    useInboxStore.setState((s: any) => { const { org_role_id: _drop, ...rest } = s.sessions[S]; return { sessions: { [S]: rest } }; });
    useInboxStore.getState().applySessionOwners(S, { take_over: true }, null);
    expect(ownerFactsOf(useInboxStore.getState() as any, S)?.org_role_id ?? null).toBeNull();
    expect((useInboxStore.getState() as any).sessionOwners[S].role).toBeNull();
  });

  test("a refused change rolls the paint back", async () => {
    refuse = true;
    useInboxStore.getState().applySessionOwners(S, { add: [ASHOT] }, { remove: [ASHOT] });
    expect(owners()).toEqual([ME, ASHOT]);
    for (let i = 0; i < 100 && locks().length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(locks()).toEqual([]);
    expect(owners()).toEqual([ME]);
  });

  test("undo puts the owners back and sends the inverse", async () => {
    const before = ownerFactsOf(useInboxStore.getState() as any, S)!;
    const diff = diffOwners({ people: [ME], role: null, parent: null }, { people: [ME, ASHOT], role: { role_id: ROLE, handle: "evals", name: "Eval Suite lead" }, parent: null }, { meId: ME, snapshots: [] });
    useInboxStore.getState().applySessionOwners(S, diff.change, diff.inverse);
    expect(getUndoHistory().items.map((i) => i.label)).toEqual(["Changed the owners of “Freeze case”"]);
    expect(performUndo()).toBe(true);
    expect(owners()).toEqual(before.rows.map((r) => r.user_id));
    expect(facts().org_role_id ?? null).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.filter((x) => x.action === "applySessionOwners").map((x) => x.args[1])).toEqual([diff.change, diff.inverse]);
  });

  test("Add me on an agent paints its owners home, and the agents band reads it there", () => {
    const CHILD = "c".repeat(32);
    useInboxStore.getState().syncTable("sessionAgents", [{ _id: S, agents: [{ _id: CHILD, short_id: "c1", title: "Child", agent_status: "working", updated_at: 1, message_count: 1, owned_by_parent: true, owners: [] }] }]);
    applySessionOwnersRead(CHILD, read({ conversation_id: CHILD, people: [], parent_session: { conversation_id: S, short_id: "s1", title: "Freeze case" } }));
    const agent = () => agentOwnersOf(useInboxStore.getState() as any, S, (useInboxStore.getState() as any).sessionAgents[S].agents[0]);
    expect(agent()).toEqual({ ownedByParent: true, people: [] });
    useInboxStore.getState().applySessionOwners(CHILD, { add: [ME] }, { remove: [ME] });
    expect(agent().people.map((p) => p._id)).toEqual([ME]);
    expect(Object.keys(useInboxStore.getState().pending as any)).toContain(`sessionOwners:${CHILD}:people_ids`);
    expect(performUndo()).toBe(true);
    expect(agent().people).toEqual([]);
  });

  test("after Take it over the card shows no role face, as the header shows none", () => {
    applySessionOwnersRead(S, read({ people: [person(ME, 10), person(ASHOT, 20)], role: { role_id: ROLE, short_id: "or-1", handle: "evals", name: "Eval Suite lead" } }));
    expect(coOwnersOf(useInboxStore.getState() as any, S, ME, [])?.role?._id).toBe(ROLE);
    useInboxStore.getState().applySessionOwners(S, { take_over: true }, null);
    expect(coOwnersOf(useInboxStore.getState() as any, S, ME, [])?.role ?? null).toBeNull();
  });

  test("a read off the model drops the cached owners read, so the session draws as before the model", () => {
    expect(ownersModelOnFor(useInboxStore.getState() as any, S)).toBe(true);
    useInboxStore.setState((s: any) => ({ sessions: { [S]: { ...s.sessions[S], owners_model: null } } }));
    applySessionOwnersRead(S, { conversation_id: S, short_id: "s1", owners: [] });
    expect((useInboxStore.getState() as any).sessionOwners[S]).toBeUndefined();
    expect(ownersModelOnFor(useInboxStore.getState() as any, S)).toBe(false);
  });

  test("every card and the header share one facts object until the read changes", () => {
    const facts = ownerFactsOf(useInboxStore.getState() as any, S);
    useInboxStore.setState({ drafts: {} } as any);
    expect(ownerFactsOf(useInboxStore.getState() as any, S)).toBe(facts);
    useInboxStore.getState().applySessionOwners(S, { add: [ASHOT] }, null);
    expect(ownerFactsOf(useInboxStore.getState() as any, S)).not.toBe(facts);
  });

  test("a person the read no longer lists is no owner anywhere, whatever people_info still holds", () => {
    applySessionOwnersRead(S, read({ people: [person(ME, 10), person(ASHOT, 20)] }));
    applySessionOwnersRead(S, read({ people: [person(ME, 10)], owners_changed_at: 9 }));
    useInboxStore.setState((s: any) => ({ sessionOwners: { ...s.sessionOwners, [S]: { ...s.sessionOwners[S], people_info: { ...s.sessionOwners[S].people_info, [ASHOT]: person(ASHOT, 20) } } } }));
    const st = useInboxStore.getState() as any;
    expect(ownerIdsOf(st, S)).toEqual([ME]);
    expect(coOwnersOf(st, S, ME, [])).toBeNull();
    expect(coOwnersSig(st, S)).not.toContain(ASHOT);
  });

  test("Add me before the read arrives paints you at once, and the read that lands replaces it", async () => {
    const CHILD = "c".repeat(32);
    useInboxStore.getState().applySessionOwners(CHILD, { add: [ME] }, { remove: [ME] });
    expect(ownerIdsOf(useInboxStore.getState() as any, CHILD)).toEqual([ME]);
    await new Promise((r) => setTimeout(r, 20));
    applySessionOwnersRead(CHILD, read({ conversation_id: CHILD, people: [person(ASHOT, 5), person(ME, 30)] }));
    expect(ownerIdsOf(useInboxStore.getState() as any, CHILD)).toEqual([ASHOT, ME]);
    expect(Object.keys(useInboxStore.getState().pending as object).filter((k) => k.startsWith(`sessionOwners:${CHILD}`))).toEqual([]);
  });

  test("a refused Add me before the read arrives takes the painted row back out", async () => {
    const CHILD = "c".repeat(32);
    refuse = true;
    useInboxStore.getState().applySessionOwners(CHILD, { add: [ME] }, { remove: [ME] });
    for (let i = 0; i < 100 && (useInboxStore.getState() as any).sessionOwners[CHILD]; i++) await new Promise((r) => setTimeout(r, 10));
    expect((useInboxStore.getState() as any).sessionOwners[CHILD]).toBeUndefined();
  });
});
