// A window that boots while a leave is in flight takes the leave's locks from
// IndexedDB (the host persists pending), and it can miss what settled them in
// the window that sent it: the ack went out on the gesture bridge before it
// subscribed. Whatever it missed, its locks still settle on what reaches it
// afterwards, and none outlives the leave to hide a later rejoin.
import { beforeEach, describe, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { applyUpdatesToStore } from "../syncReplication";

const S = "jx700000000000000000000000000bt1";
const SCOPE = "user:me";
const before = { _id: S, session_id: "s-bt", user_id: "ada", owner_user_id: "me", owned_by_me: true, owner_ids: ["ada", "me"] };
const left = { ...before, owner_user_id: "ada", owned_by_me: false, owner_ids: ["ada"] };
const FIELDS = ["owner_ids", "owned_by_me", "owner_user_id"] as const;

/** The store a window boots into: the leave's paint and its locks, as the host persisted them. */
function bootWith(ack?: Array<{ s: string; p: number }>) {
  const ts = Date.now() - 1_000;
  const pending: Record<string, any> = {};
  for (const f of FIELDS) pending[`sessions:${S}:${f}`] = { type: "field", value: (left as any)[f], ts, ...(ack ? { ack } : {}) };
  useInboxStore.setState({ currentUser: { _id: "me", name: "Me" }, pending, syncMeta: {}, conversations: {}, sessions: { [S]: { ...left, updated_at: ts } } } as any);
}
const locks = () => Object.keys(useInboxStore.getState().pending).filter((k) => k.includes(`${S}:`));
const facts = () => {
  const r = (useInboxStore.getState().sessions as any)[S];
  return r ? [r.owned_by_me, r.owner_user_id, r.owner_ids] : null;
};
const hostRow = (row: any) => applyUpdatesToStore([{ key: "sessions", upserts: [{ ...row, updated_at: Date.now() }] }] as any);

beforeEach(() => useInboxStore.setState({ pending: {}, sessions: {}, conversations: {}, syncMeta: {} } as any));

describe("a window that boots during a leave's round trip", () => {
  test("a follower with a sibling's mirror locks and no ack: an older host row stays hidden, the leave's row releases them, a rejoin shows", () => {
    bootWith();
    hostRow(before);
    expect(facts()).toEqual([false, "ada", ["ada"]]);
    hostRow(left);
    expect(locks()).toEqual([]);
    hostRow(before);
    expect(facts()).toEqual([true, "me", ["ada", "me"]]);
  });

  test("a follower whose host dropped the row: no lock is left to hide the row when a rejoin brings it back", () => {
    bootWith();
    applyUpdatesToStore([{ key: "sessions", removes: [S] }] as any);
    expect(facts()).toBeNull();
    expect(locks()).toEqual([]);
    hostRow(before);
    expect(facts()).toEqual([true, "me", ["ada", "me"]]);
  });

  test("a window holding the locks stamped with the receipt's position retires them when its cursor passes, and the re-fetch settles the row", () => {
    bootWith([{ s: SCOPE, p: 9 }]);
    useInboxStore.getState().syncTable("sessions", [{ ...before, updated_at: Date.now() }] as any);
    expect(facts()).toEqual([false, "ada", ["ada"]]);
    useInboxStore.getState().retireAckedPending(SCOPE, 9);
    expect(locks()).toEqual([]);
    useInboxStore.getState().pruneFeedEntities("sessions", [S]);
    expect(facts()).toBeNull();
    expect(locks()).toEqual([]);
  });
});
