// The calls list is a delta overlay, so each answer prunes only the window it
// is the whole truth about (callListPruneScope), and a call the server lists
// again lifts the tombstone that prune left (inboxStore SYNC_REGISTRY).
import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { callListPruneScope } from "../useSyncCalls";

const id = (seed: string) => seed.padEnd(32, "0").slice(0, 32);
const call = (seed: string, started_at: number, extra: Record<string, unknown> = {}) => ({
  _id: id(seed),
  room_key: `session:${seed}`,
  status: "ended",
  started_at,
  ...extra,
});
const sync = (rows: any[], limit: number) =>
  useInboxStore.getState().syncTable("callList", rows, callListPruneScope(rows, limit));

describe("callList pruning", () => {
  beforeEach(() => {
    useInboxStore.setState({ callList: {}, pending: {} } as any);
  });

  it("drops a call a short answer no longer lists: a huddle that ended silent does not stay Live", () => {
    sync([call("a", 300, { status: "live" }), call("b", 200)], 100);
    sync([call("b", 200)], 100);
    const s = useInboxStore.getState();
    expect(s.callList[id("a")]).toBeUndefined();
    expect(s.callList[id("b")]).toBeDefined();
    expect(s.pending[`callList:${id("a")}`]?.type).toBe("exclude");
  });

  it("a full page vouches only back to its oldest call", () => {
    sync([call("old", 50)], 100);
    sync([call("x", 300), call("y", 200)], 2);
    // Older than the page reaches: a longer page (another surface) may still list it.
    expect(useInboxStore.getState().callList[id("old")]).toBeDefined();
    sync([call("x", 300), call("z", 150)], 2);
    // Inside the window and absent: gone.
    expect(useInboxStore.getState().callList[id("y")]).toBeUndefined();
  });

  it("a pruned call the server lists again comes back", () => {
    sync([call("r", 100)], 100);
    sync([], 100);
    expect(useInboxStore.getState().callList[id("r")]).toBeUndefined();
    sync([call("r", 100, { rec_shared: true })], 100);
    const s = useInboxStore.getState();
    expect(s.callList[id("r")]?.rec_shared).toBe(true);
    expect(s.pending[`callList:${id("r")}`]).toBeUndefined();
  });

  it("never prunes a row without a server id", () => {
    useInboxStore.setState({ callList: { stub: { _id: "stub", started_at: 999 } } } as any);
    sync([], 100);
    expect(useInboxStore.getState().callList.stub).toBeDefined();
  });

  it("a refused or missing answer prunes nothing", () => {
    expect(callListPruneScope(null, 100)).toBeUndefined();
    expect(callListPruneScope(undefined, 100)).toBeUndefined();
  });
});
