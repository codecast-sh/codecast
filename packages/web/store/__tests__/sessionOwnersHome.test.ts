// A session's people have one home: owner_ids on its session row. Two feeders
// write it, the inbox rows and the owners read (listOwners), and a Save paints
// it; the header (ownerIdsOnRow) and the card (coOwnersOf) both read it, so
// they converge on whichever answer is newest and a Save never freezes it.
import { beforeEach, describe, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";
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
    expect(card()).toBe("Owners: You (driver), Mate");
  });

  test("your Save, its echo, then a different refresh: the Save does not freeze the field", () => {
    listOwnersPush(["me", "mate", "sam"]);
    useInboxStore.getState().applySessionOwners(ID, { add: ["pat"] });
    expect(header()).toEqual(["me", "mate", "sam", "pat"]);
    // Adding never moves the wheel: you still drive.
    expect(card()).toBe("Owners: You (driver), Mate, Sam, Pat");
    // The owners read echoes the Save and releases it ...
    listOwnersPush(["me", "mate", "sam", "pat"]);
    // ... so a later answer from the inbox lands.
    inboxPush(["me", "mate", "pat"]);
    expect(header()).toEqual(["me", "mate", "pat"]);
    expect(card()).toBe("Owners: You (driver), Mate, Pat");
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
