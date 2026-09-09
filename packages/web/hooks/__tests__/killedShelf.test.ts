import { afterEach, describe, expect, it } from "bun:test";
import { useInboxStore, EMPTY_KILLED_SHELF } from "../../store/inboxStore";
import { loadMoreKilledSessions } from "../killedShelf";

// The shelf verb pages kills into the never-prune sessions cache and records
// only its reading position (ids + cursor) — see hooks/killedShelf.ts (ct-50248).

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const row = (id: string) => ({ _id: id, session_id: `s-${id[0]}`, agent_type: "claude_code", status: "completed", message_count: 3, title: `t-${id[0]}`, inbox_killed_at: 5, inbox_dismissed_at: 5, updated_at: 4 });

function fakeConvex(pages: Array<{ page: any[]; isDone: boolean; continueCursor: string | null }>) {
  const calls: any[] = [];
  return {
    calls,
    client: { query: async (_fn: unknown, args: any) => { calls.push(args); return pages.shift(); } } as any,
  };
}

afterEach(() => {
  useInboxStore.setState({ killedShelf: EMPTY_KILLED_SHELF, sessions: {} } as any);
});

describe("loadMoreKilledSessions", () => {
  it("pages rows into the cache and advances the cursor across clicks", async () => {
    const { client, calls } = fakeConvex([
      { page: [row(A), row(B)], isDone: false, continueCursor: "cur1" },
      { page: [row(C)], isDone: true, continueCursor: null },
    ]);
    await loadMoreKilledSessions(client);
    let shelf = useInboxStore.getState().killedShelf;
    expect(shelf).toEqual({ ids: [A, B], cursor: "cur1", complete: false, loading: false });
    expect(Object.keys(useInboxStore.getState().sessions).sort()).toEqual([A, B]);
    expect(calls[0].paginationOpts).toEqual({ numItems: 25, cursor: null });

    await loadMoreKilledSessions(client);
    shelf = useInboxStore.getState().killedShelf;
    expect(shelf).toEqual({ ids: [A, B, C], cursor: null, complete: true, loading: false });
    expect(calls[1].paginationOpts.cursor).toBe("cur1");

    // Drained: a further click is a no-op.
    await loadMoreKilledSessions(client);
    expect(calls.length).toBe(2);
  });

  it("a failed page leaves the position untouched and clears loading", async () => {
    const client = { query: async () => { throw new Error("Could not find public function"); } } as any;
    await loadMoreKilledSessions(client);
    expect(useInboxStore.getState().killedShelf).toEqual(EMPTY_KILLED_SHELF);
  });
});
