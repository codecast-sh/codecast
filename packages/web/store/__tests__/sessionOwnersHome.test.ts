// A session's people have one home: owner_ids on its session row. Two feeders
// write it, the inbox rows and the owners read (listOwners), and a Save paints
// it; the header (ownerIdsOnRow) and the card (coOwnersOf) both read it, so
// they converge on whichever answer is newest and a Save never freezes it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isForeignRow, useInboxStore } from "../inboxStore";
import { applyUpdatesToStore } from "../syncReplication";
import { makeDispatchBinding } from "../../lib/dispatchBinding";
import { paintTakeOverOnSend } from "../sessionOwnersSlice";
import { applyCollectionFeed } from "../../hooks/useSyncCollection";
import { feedOwnerIds, selectOwnersRow } from "../../hooks/useOwners";
import { ownerIdsOnRow } from "../../hooks/useOwnersStoreEnv";
import { coOwnersOf } from "../../lib/coOwners";

const ID = "jx7000000000000000000000000000own";
const MEMBERS = ["me", "mate", "sam", "pat", "quinn"].map((_id) => ({ _id, name: _id[0].toUpperCase() + _id.slice(1) }));

/** listOwners' answer for these rows (stamps in list order). */
const read = (ids: string[]) => ({
  conversation_id: ID, owner_ids: ids, role: null, runner: { user_id: "me", is_bot: false }, author_id: null, bots: [], can_edit: true,
  owners: ids.map((user_id, i) => ({ user_id, name: user_id, email: null, added_at: i + 1 })),
});
const listOwnersPush = (ids: string[]) => applyCollectionFeed("sessionOwners", read(ids), selectOwnersRow, undefined, undefined, feedOwnerIds);
const inboxPush = (ids: string[]) => {
  const row = useInboxStore.getState().sessions[ID] as any;
  useInboxStore.getState().syncTable("sessions", [{ ...row, owner_ids: ids }] as any);
};

const header = () => ownerIdsOnRow(useInboxStore.getState(), ID)?.split(",") ?? null;
const card = () => {
  const row = useInboxStore.getState().sessions[ID] as any;
  return coOwnersOf(row, "me", MEMBERS, null)?.title ?? null;
};

beforeEach(() => {
  useInboxStore.setState({
    currentUser: { _id: "me", name: "Me" },
    pending: {},
    sessionOwners: {},
    conversations: {},
    sessions: { [ID]: { _id: ID, session_id: "s-own", user_id: "me", updated_at: 1, owner_user_id: "me", owner_ids: ["me", "mate", "sam"] } },
  } as any);
});

describe("one home for a session's people", () => {
  test("the owners read lands on the session row and holds nothing else", () => {
    listOwnersPush(["me", "mate", "sam"]);
    const s = useInboxStore.getState() as any;
    expect(s.sessionOwners[ID].owners).toHaveLength(3);
    expect("owner_ids" in s.sessionOwners[ID]).toBe(false);
    expect(header()).toEqual(["me", "mate", "sam"]);
  });

  test("Mate removes Sam from an older session you have open: header and card follow the owners read", () => {
    listOwnersPush(["me", "mate", "sam"]);
    // No inbox push comes for an out-of-window row; the read does.
    listOwnersPush(["me", "mate"]);
    expect(header()).toEqual(["me", "mate"]);
    expect(card()).toBe("Owners: You, Mate");
  });

  test("your Save, its echo, then a different refresh: the Save does not freeze the field", () => {
    listOwnersPush(["me", "mate", "sam"]);
    useInboxStore.getState().applySessionOwners(ID, { add: ["pat"] });
    expect(header()).toEqual(["me", "mate", "sam", "pat"]);
    // Adding never moves the wheel: you still drive.
    expect(card()).toBe("Owners: You, Mate, Sam, Pat");
    // The owners read echoes the Save and releases it ...
    listOwnersPush(["me", "mate", "sam", "pat"]);
    // ... so a later answer from the inbox lands.
    inboxPush(["me", "mate", "pat"]);
    expect(header()).toEqual(["me", "mate", "pat"]);
    expect(card()).toBe("Owners: You, Mate, Pat");
  });

  test("a stale inbox answer cannot override a Save the server has not echoed", () => {
    listOwnersPush(["me", "mate", "sam"]);
    useInboxStore.getState().applySessionOwners(ID, { remove: ["sam"] });
    inboxPush(["me", "mate", "sam"]);
    expect(header()).toEqual(["me", "mate"]);
    inboxPush(["me", "mate"]);
    inboxPush(["me", "mate", "quinn"]);
    expect(header()).toEqual(["me", "mate", "quinn"]);
  });

  test("a second Save before the first echo starts from the first", () => {
    listOwnersPush(["me", "mate", "sam"]);
    useInboxStore.getState().applySessionOwners(ID, { add: ["pat"] });
    useInboxStore.getState().applySessionOwners(ID, { add: ["quinn"], remove: ["sam"] });
    expect(header()).toEqual(["me", "mate", "pat", "quinn"]);
  });

  test("a session with no inbox row keeps its people on the conversation it was opened from", () => {
    useInboxStore.setState({ sessions: {}, conversations: { [ID]: { _id: ID, user_id: "me" } } } as any);
    expect(header()).toBeNull();
    listOwnersPush(["me", "mate"]);
    expect(header()).toEqual(["me", "mate"]);
    useInboxStore.getState().applySessionOwners(ID, { add: ["sam"] });
    expect(header()).toEqual(["me", "mate", "sam"]);
  });
});

describe("the owners read touches only owner_ids", () => {
  const owner = {};
  let settle: ((refuse: boolean) => void) | null = null;
  beforeEach(() => {
    useInboxStore.getState()._setDispatch(() => new Promise((resolve, reject) => {
      settle = (refuse) => (refuse ? reject(new Error("Uncaught Error: no")) : resolve(null));
    }), { owner });
  });
  afterEach(() => { settle = null; useInboxStore.getState()._clearDispatch(owner); });
  const locks = () => Object.keys(useInboxStore.getState().pending).filter((k) => k.includes(ID));

  test("a refused role change rolls back to the old role though an owners push came between", async () => {
    useInboxStore.setState({ sessions: { [ID]: { ...(useInboxStore.getState().sessions as any)[ID], org_role_id: "roleP" } } } as any);
    listOwnersPush(["me", "mate", "sam"]);
    useInboxStore.getState().applySessionOwners(ID, { role: "roleR" });
    expect((useInboxStore.getState().sessions as any)[ID].org_role_id).toBe("roleR");
    // An unrelated push of the owners read (an ack, a teammate's change).
    listOwnersPush(["me", "mate", "sam"]);
    settle!(true);
    for (let i = 0; i < 100 && locks().length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(locks()).toEqual([]);
    expect((useInboxStore.getState().sessions as any)[ID].org_role_id).toBe("roleP");
  });

  test("a Save made outside the inbox leaves no hold behind once the session enters it", () => {
    useInboxStore.setState({ sessions: {}, conversations: { [ID]: { _id: ID, user_id: "me" } } } as any);
    listOwnersPush(["me", "mate"]);
    useInboxStore.getState().applySessionOwners(ID, { add: ["sam"] });
    expect(locks()).toContain(`conversations:${ID}:owner_ids`);
    // Taking it puts it in the inbox, with a row from before the Save.
    useInboxStore.getState().syncTable("sessions", [{ _id: ID, session_id: "s-own", user_id: "me", updated_at: 1, owner_ids: ["me", "mate"] }] as any);
    // The owners read echoes the Save onto both copies.
    listOwnersPush(["me", "mate", "sam"]);
    expect(locks().filter((k) => k.endsWith(":owner_ids"))).toEqual([]);
    expect(header()).toEqual(["me", "mate", "sam"]);
    // It leaves the inbox again: the conversation's copy is the live answer.
    useInboxStore.setState({ sessions: {} } as any);
    listOwnersPush(["me", "sam"]);
    expect(header()).toEqual(["me", "sam"]);
  });
});

// The three owner fields are server-written, but a Save's patch carries the
// paint so the Save's sync receipt retires their locks (the server's gate
// drops them). Without it a Save the server answered differently froze them
// (sim ownersTwoEditors).
describe("a Save's dispatch carries what it painted", () => {
  const owner = {};
  const SID = "jx700000000000000000000000000sav";
  let sent: any[] = [];
  beforeEach(() => {
    sent = [];
    useInboxStore.setState({ sessions: { [SID]: { _id: SID, session_id: "s-sav", user_id: "me", updated_at: 1, owner_ids: ["me", "mate"] } } } as any);
    applyCollectionFeed("sessionOwners", { ...read(["me", "mate"]), conversation_id: SID }, selectOwnersRow, undefined, undefined, feedOwnerIds);
    useInboxStore.getState()._setDispatch(((action: string, _args: any, patches: any) => { sent.push({ action, patches }); return Promise.resolve(null); }) as any, { owner });
  });
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  test("owner_ids, the role and the driver ride the sessions patch", async () => {
    useInboxStore.getState().applySessionOwners(SID, { add: ["sam"], role: "roleR", driver: { kind: "user", user_id: "mate" } });
    for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(sent[0].action).toBe("applySessionOwners");
    expect(sent[0].patches.conversations[SID]).toEqual({ owner_ids: ["me", "mate", "sam"], org_role_id: "roleR", driver_user_id: "mate" });
  });
});

// A follower takes its host's conversation rows as replicated upserts, and a
// row that changed only its owner_ids must not read as a no-op. Only that
// path compares it by content: a registry `sync` entry on conversations would
// make the host drop a follower's whole-value conversations write.
test("a replicated row that changes only owner_ids applies to the follower's conversation row", () => {
  useInboxStore.setState({ pending: {}, sessions: {}, conversations: { [ID]: { _id: ID, user_id: "me", updated_at: 1, owner_ids: ["me"] } } } as any);
  applyUpdatesToStore([{ key: "conversations", upserts: [{ _id: ID, user_id: "me", updated_at: 1, owner_ids: ["me", "mate"] }] } as any]);
  expect((useInboxStore.getState().conversations as any)[ID].owner_ids).toEqual(["me", "mate"]);
});

test("a follower's whole-value conversations write lands on the host", () => {
  useInboxStore.setState({ pending: {}, conversations: { [ID]: { _id: ID, title: "old", inbox_stashed_at: 5 } } } as any);
  applyUpdatesToStore([{ key: "conversations", hasValue: true, value: { [ID]: { _id: ID, title: "new", inbox_stashed_at: null } } } as any], { optimistic: true });
  expect((useInboxStore.getState().conversations as any)[ID]).toMatchObject({ title: "new", inbox_stashed_at: null });
});

// A run that only a role holds (role_alone) is out of its runner's inbox. A
// take-over send paints the runner into owner_ids, and that alone brings the
// row in, before the server's owned_by_me echo.
test("taking over a run only a role holds brings it into the taker's inbox at once", () => {
  const RID = "jx700000000000000000000000000tko";
  const row = { _id: RID, session_id: "s-own", user_id: "me", updated_at: 1, org_role_id: "roleR", role_alone: true, owned_by_me: false, owner_ids: [] };
  const draft: any = { currentUser: { _id: "me" }, sessionOwners: {}, sessions: { [RID]: { ...row } }, conversations: {} };
  expect(isForeignRow(draft.sessions[RID], "me")).toBe(true);
  paintTakeOverOnSend(draft, RID);
  expect(draft.sessions[RID].owner_ids).toEqual(["me"]);
  expect(draft.sessions[RID].driver_user_id).toBe("me");
  expect(isForeignRow({ ...draft.sessions[RID] }, "me")).toBe(false);
});

// A leave paints the inbox the way the server will answer: the row leaves the
// leaver's inbox at once, whether they co-owned a teammate's run or moved
// their own to a teammate's machine first.
describe("a leave takes the session out of the inbox at once", () => {
  const owner = {};
  const LID = "jx700000000000000000000000000lv1";
  const readOf = (ids: string[], runner: string) => ({ ...read(ids), conversation_id: LID, runner: { user_id: runner, is_bot: false } });
  beforeEach(() => useInboxStore.getState()._setDispatch((() => new Promise(() => {})) as any, { owner }));
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  test("leaving a teammate's run you co-own", () => {
    useInboxStore.setState({ sessions: { [LID]: { _id: LID, session_id: "s-lv", user_id: "mate", updated_at: Date.now(), owner_user_id: "mate", owned_by_me: true, owner_ids: ["mate", "me"] } } } as any);
    applyCollectionFeed("sessionOwners", readOf(["mate", "me"], "mate"), selectOwnersRow, undefined, undefined, feedOwnerIds);
    useInboxStore.getState().applySessionOwners(LID, { leave: {} }, null);
    const row = (useInboxStore.getState().sessions as any)[LID];
    expect([row.owner_ids, row.owned_by_me]).toEqual([["mate"], false]);
    expect(isForeignRow(row, "me")).toBe(true);
  });

  test("the last person leaving a hand a role started gives it back to the role, and rejoining undoes it", () => {
    // The role's seat runs on my machine; I took the hand over, so I am its one person.
    useInboxStore.setState({ sessions: { [LID]: { _id: LID, session_id: "s-lv", user_id: "me", updated_at: Date.now(), owner_user_id: "me", owned_by_me: true, owner_ids: ["me"], org_role_id: "org_roles_r", driver_user_id: "me", role_alone: false } } } as any);
    applyCollectionFeed("sessionOwners", { ...readOf(["me"], "me"), role_started: true }, selectOwnersRow, undefined, undefined, feedOwnerIds);
    useInboxStore.getState().applySessionOwners(LID, { leave: {} }, null);
    let row = (useInboxStore.getState().sessions as any)[LID];
    // runnerTakesLeftSession gives nobody a row: no person is painted as owner.
    expect([row.owner_ids, row.owner_user_id, row.owned_by_me, row.role_alone, row.driver_user_id]).toEqual([[], null, false, true, null]);
    expect(isForeignRow(row, "me")).toBe(true);

    useInboxStore.getState().applySessionOwners(LID, { add: ["me"] }, null);
    row = (useInboxStore.getState().sessions as any)[LID];
    expect([row.owner_ids, row.owned_by_me, row.role_alone]).toEqual([["me"], true, false]);
    expect(isForeignRow(row, "me")).toBe(false);
  });

  test("leaving your own run by moving it to a teammate's machine", () => {
    useInboxStore.setState({ sessions: { [LID]: { _id: LID, session_id: "s-lv", user_id: "me", updated_at: Date.now(), owner_user_id: "me", owned_by_me: true, owner_ids: ["me", "mate"] } } } as any);
    applyCollectionFeed("sessionOwners", readOf(["me", "mate"], "me"), selectOwnersRow, undefined, undefined, feedOwnerIds);
    useInboxStore.getState().applySessionOwners(LID, { leave: { move_to_device_id: "dev-mate", runner_id: "mate", runner_is_bot: false } }, null);
    const row = (useInboxStore.getState().sessions as any)[LID];
    expect([row.owner_ids, row.user_id, row.owner_user_id]).toEqual([["mate"], "mate", "mate"]);
    expect(isForeignRow(row, "me")).toBe(true);
  });
});

// A leave takes the leaver's scope out of the session's fan-out, so the server
// gives it a receipt in the leaver's own user scope (convex settleLeave). Its
// locks retire there like any write's: when that scope's cursor passes the
// receipt. Released on the result instead, they let an older row in flight
// land after them and put the session back in the leaver's inbox for good.
describe("a leave's locks retire on its receipt", () => {
  const owner = {};
  const MID = "jx700000000000000000000000000mb1";
  const SCOPE = "user:me";
  const readOf = (ids: string[], runner: string) => ({ ...read(ids), conversation_id: MID, runner: { user_id: runner, is_bot: false } });
  const mine = { _id: MID, session_id: "s-mb", user_id: "me", owner_user_id: "me", owned_by_me: true, owner_ids: ["me", "mate"] };
  const myRun = () => useInboxStore.setState({ pending: {}, syncMeta: {}, sessions: { [MID]: { ...mine, updated_at: Date.now() } } } as any);
  const leaveToMate = () => useInboxStore.getState().applySessionOwners(MID, { leave: { move_to_device_id: "dev-mate", runner_id: "mate", runner_is_bot: false } }, null);
  const locks = () => Object.entries(useInboxStore.getState().pending).filter(([k]) => k.includes(MID)) as Array<[string, any]>;
  const until = async (done: () => boolean) => { for (let i = 0; i < 50 && !done(); i++) await new Promise((r) => setTimeout(r, 5)); };
  const facts = () => {
    const row = (useInboxStore.getState().sessions as any)[MID];
    return [row.user_id, row.owned_by_me, row.owner_user_id, row.owner_ids];
  };
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  test("an older row landing after the result keeps the leave painted; the cursor passing the receipt hands the row to the re-fetch", async () => {
    useInboxStore.getState()._setDispatch(makeDispatchBinding(async () => ({ __syncAckV1: [{ scope_key: SCOPE, position: 7 }], __syncAckV2: [], result: null })), { owner });
    myRun();
    applyCollectionFeed("sessionOwners", readOf(["me", "mate"], "me"), selectOwnersRow, undefined, undefined, feedOwnerIds);
    leaveToMate();
    expect(facts()).toEqual(["mate", false, "mate", ["mate"]]);
    await until(() => locks().length > 0 && locks().every(([, e]) => e.ack));
    expect(locks().length).toBeGreaterThan(0);
    // A push the server computed before the leave arrives after its result.
    useInboxStore.getState().syncTable("sessions", [{ ...mine, updated_at: Date.now() }] as any);
    expect(facts()).toEqual(["mate", false, "mate", ["mate"]]);
    // The receipt: the log applier retires up to the cursor, then the thin
    // upsert's byIds re-fetch lands the server's row.
    useInboxStore.getState().retireAckedPending(SCOPE, 7);
    expect(locks()).toEqual([]);
    useInboxStore.getState().syncTable("sessions", [{ ...mine, user_id: "mate", owned_by_me: false, owner_user_id: "mate", owner_ids: ["mate"], updated_at: Date.now() + 1 }] as any);
    expect(facts()).toEqual(["mate", false, "mate", ["mate"]]);
    // Mate leaves later and moves it back onto my machine.
    useInboxStore.getState().syncTable("sessions", [{ ...mine, owner_ids: ["me"], updated_at: Date.now() + 1000 }] as any);
    expect(facts()).toEqual(["me", true, "me", ["me"]]);
    expect(isForeignRow((useInboxStore.getState().sessions as any)[MID], "me")).toBe(false);
  });

  test("an open session the re-fetch no longer returns keeps the leave painted when its delivery receipt settles", async () => {
    // A receipt the outbox delivers: the locks carry its id, and settle with restore once the scope's cursor passes it.
    useInboxStore.getState()._setDispatch(makeDispatchBinding(async () => ({ __syncAckV1: [], __syncAckV2: [{ id: "ob1", revision: 3, entity_type: "conversations", entity_id: MID, scope_key: SCOPE }], result: null })), { owner });
    myRun();
    useInboxStore.getState().navigateToSession(MID);
    expect(useInboxStore.getState().currentSessionId).toBe(MID);
    applyCollectionFeed("sessionOwners", readOf(["me", "mate"], "me"), selectOwnersRow, undefined, undefined, feedOwnerIds);
    leaveToMate();
    await until(() => locks().length > 0 && locks().every(([, e]) => e.ack));
    // An older push lands under the locks, then the receipt's re-fetch omits the row: I left, and I have it open.
    useInboxStore.getState().syncTable("sessions", [{ ...mine, updated_at: Date.now() }] as any);
    useInboxStore.getState().pruneFeedEntities("sessions", [MID]);
    useInboxStore.getState().retireAckedPending("outbox:ob1", 3, { restore: true });
    expect(locks()).toEqual([]);
    expect(facts()).toEqual(["mate", false, "mate", ["mate"]]);
  });

  test("a refused leave rolls back with its locks", async () => {
    useInboxStore.getState()._setDispatch(makeDispatchBinding(async () => { throw new Error("Uncaught Error: no"); }), { owner });
    myRun();
    applyCollectionFeed("sessionOwners", readOf(["me", "mate"], "me"), selectOwnersRow, undefined, undefined, feedOwnerIds);
    leaveToMate();
    await until(() => locks().length === 0);
    expect(locks()).toEqual([]);
    expect(facts()).toEqual(["me", true, "me", ["me", "mate"]]);
  });
});
