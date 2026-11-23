import { afterEach, describe, expect, it } from "bun:test";
import { getFunctionName } from "convex/server";
import { useInboxStore, EMPTY_KILLED_SHELF } from "../../store/inboxStore";
import { loadMoreKilledSessions } from "../killedShelf";

// The shelf verb pages kills and closes into the never-prune sessions cache
// and records only its reading position (ids + a cursor each) — see
// hooks/killedShelf.ts (ct-50248).

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const D = "d".repeat(32);
const killed = (id: string) => ({ _id: id, session_id: `s-${id[0]}`, agent_type: "claude_code", status: "completed", message_count: 3, title: `t-${id[0]}`, inbox_killed_at: 5, inbox_dismissed_at: 5, updated_at: 4 });
const closed = (id: string) => ({ _id: id, session_id: `s-${id[0]}`, agent_type: "claude_code", status: "active", message_count: 3, title: `t-${id[0]}`, inbox_closed_at: 6, inbox_dismissed_at: 6, updated_at: 4 });
type Page = { page: any[]; isDone: boolean; continueCursor: string | null };

function fakeConvex(kills: Page[], closes: Page[]) {
  const calls: Array<{ which: string; args: any }> = [];
  return {
    calls,
    client: {
      query: async (fn: unknown, args: any) => {
        const which = getFunctionName(fn as any).endsWith("listClosedSessions") ? "closed" : "killed";
        calls.push({ which, args });
        return (which === "closed" ? closes : kills).shift();
      },
    } as any,
  };
}

afterEach(() => {
  useInboxStore.setState({ killedShelf: EMPTY_KILLED_SHELF, sessions: {} } as any);
});

describe("loadMoreKilledSessions", () => {
  it("pages kills and closes into the cache, each on its own cursor, until both are drained", async () => {
    const { client, calls } = fakeConvex(
      [{ page: [killed(A)], isDone: false, continueCursor: "k1" }, { page: [killed(C)], isDone: true, continueCursor: null }],
      [{ page: [closed(B)], isDone: true, continueCursor: null }],
    );
    await loadMoreKilledSessions(client);
    let shelf = useInboxStore.getState().killedShelf;
    expect(shelf).toEqual({ ids: [A, B], cursor: "k1", closedCursor: null, killedDone: false, closedDone: true, complete: false, loading: false });
    expect(Object.keys(useInboxStore.getState().sessions).sort()).toEqual([A, B]);
    expect(calls.map((c) => [c.which, c.args.paginationOpts])).toEqual([
      ["killed", { numItems: 25, cursor: null }],
      ["closed", { numItems: 25, cursor: null }],
    ]);

    await loadMoreKilledSessions(client);
    shelf = useInboxStore.getState().killedShelf;
    expect(shelf.ids).toEqual([A, B, C]);
    expect(shelf.complete).toBe(true);
    // The drained closes are not asked again.
    expect(calls.slice(2).map((c) => c.which)).toEqual(["killed"]);
    expect(calls[2]!.args.paginationOpts.cursor).toBe("k1");

    await loadMoreKilledSessions(client);
    expect(calls.length).toBe(3);
  });

  it("a page of closes alone fills the shelf", async () => {
    const { client } = fakeConvex([{ page: [], isDone: true, continueCursor: null }], [{ page: [closed(D)], isDone: true, continueCursor: null }]);
    await loadMoreKilledSessions(client);
    expect(useInboxStore.getState().killedShelf.ids).toEqual([D]);
  });

  it("a failed page leaves the position untouched and clears loading", async () => {
    const client = { query: async () => { throw new Error("Could not find public function"); } } as any;
    await loadMoreKilledSessions(client);
    expect(useInboxStore.getState().killedShelf).toEqual(EMPTY_KILLED_SHELF);
  });
});
