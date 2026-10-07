import { describe, expect, it } from "bun:test";
import {
  MAX_COLD_WARM_PER_PASS,
  MAX_DEEPEN_PER_PASS,
  WARM_DEEP_RANKS,
  WARM_DEEP_ROWS,
  WARM_TAIL_ROWS,
  planWarm,
  readForward,
  rereadAnchor,
  warmDepthForRank,
  type WarmRow,
} from "../inboxWarm";
import { useInboxStore } from "../../store/inboxStore";
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";

function row(id: string, over: Partial<WarmRow> = {}): WarmRow {
  return {
    id,
    serverCount: 500,
    storedCount: 0,
    hasMoreAbove: false,
    newestTs: null,
    syncedCount: undefined,
    inFlight: false,
    ...over,
  };
}

describe("planWarm", () => {
  it("warms the top of the rendered list to the deep window and the rest to the tail", () => {
    const rows = Array.from({ length: WARM_DEEP_RANKS + 5 }, (_, i) => row(`c${i}`));
    const actions = planWarm(rows);
    expect(actions[0]).toEqual({ kind: "cold", id: "c0", rows: WARM_DEEP_ROWS, serverCount: 500 });
    expect(actions[WARM_DEEP_RANKS - 1]).toMatchObject({ kind: "cold", rows: WARM_DEEP_ROWS });
    expect(actions[WARM_DEEP_RANKS]).toMatchObject({ kind: "cold", id: `c${WARM_DEEP_RANKS}`, rows: WARM_TAIL_ROWS });
    expect(warmDepthForRank(0)).toBe(WARM_DEEP_ROWS);
    expect(warmDepthForRank(WARM_DEEP_RANKS)).toBe(WARM_TAIL_ROWS);
  });

  it("bounds cold warms per pass in on-screen order", () => {
    const rows = Array.from({ length: MAX_COLD_WARM_PER_PASS + 20 }, (_, i) => row(`c${i}`));
    const actions = planWarm(rows);
    expect(actions.length).toBe(MAX_COLD_WARM_PER_PASS);
    expect(actions[actions.length - 1].id).toBe(`c${MAX_COLD_WARM_PER_PASS - 1}`);
  });

  it("deepens a shallow tail inside the deep tier only when older rows exist", () => {
    const shallow = row("top", { storedCount: WARM_TAIL_ROWS, hasMoreAbove: true, newestTs: 10, syncedCount: 500 });
    const complete = row("done", { storedCount: 30, hasMoreAbove: false, newestTs: 10, syncedCount: 500 });
    expect(planWarm([shallow, complete])).toEqual([
      { kind: "deepen", id: "top", rows: WARM_DEEP_ROWS - WARM_TAIL_ROWS },
    ]);
  });

  it("does not deepen a row below the deep tier that already holds its tail", () => {
    const rows = Array.from({ length: WARM_DEEP_RANKS }, (_, i) =>
      row(`c${i}`, { storedCount: WARM_DEEP_ROWS, newestTs: 10, syncedCount: 500 }));
    rows.push(row("low", { storedCount: WARM_TAIL_ROWS, hasMoreAbove: true, newestTs: 10, syncedCount: 500 }));
    expect(planWarm(rows)).toEqual([]);
  });

  it("bounds deepens per pass", () => {
    const rows = Array.from({ length: MAX_DEEPEN_PER_PASS + 5 }, (_, i) =>
      row(`c${i}`, { storedCount: 10, hasMoreAbove: true, newestTs: 10, syncedCount: 500 }));
    expect(planWarm(rows).length).toBe(MAX_DEEPEN_PER_PASS);
  });

  it("fetches the delta only once message_count grows past the synced mark", () => {
    const caught = row("a", { storedCount: WARM_DEEP_ROWS, newestTs: 10, syncedCount: 500 });
    const grown = row("b", { storedCount: WARM_DEEP_ROWS, newestTs: 42, syncedCount: 400 });
    expect(planWarm([caught, grown])).toEqual([{ kind: "delta", id: "b", after: 41, serverCount: 500 }]);
  });

  it("skips rows in flight and rows with no messages yet", () => {
    expect(planWarm([row("x", { inFlight: true }), row("y", { serverCount: 0 })])).toEqual([]);
  });
});

describe("rereadAnchor", () => {
  const rows = [{ timestamp: 100 }, { timestamp: 200 }, { timestamp: 300 }];
  it("re-reads from the newest row for a coding session", () => {
    expect(rereadAnchor(rows, "claude_code")).toBe(299);
  });
  it("re-reads the whole cached window of a hosted conversation", () => {
    expect(rereadAnchor(rows, HOSTED_AGENT_TYPE)).toBe(99);
  });
  it("has nothing to anchor on an empty cache", () => {
    expect(rereadAnchor([], HOSTED_AGENT_TYPE)).toBeNull();
  });
  it("plans a hosted delta from the window's first row", () => {
    const grown = row("h", { storedCount: WARM_DEEP_ROWS, newestTs: 300, rereadFrom: 99, syncedCount: 400 });
    expect(planWarm([grown])).toEqual([{ kind: "delta", id: "h", after: 99, serverCount: 500 }]);
  });
});

describe("readForward heals a stale row in the middle of a hosted turn", () => {
  it("replaces the mid-stream 'I' second of four, with an equal count", async () => {
    const id = "jx7766rrazgm7t4qmps950dpsh8fvfq8";
    const user = { _id: "m1", role: "user", content: "Make a packing list as a table", timestamp: 1000 };
    const stale = { _id: "m2", role: "assistant", content: "I", timestamp: 2000 };
    const full = { ...stale, content: "I'll create a packing list for your October camping trip", tool_calls: [{ id: "t1", name: "write_doc", input: "{}" }] };
    const results = { _id: "m3", role: "user", content: "", tool_results: [{ tool_use_id: "t1", content: "ok" }], timestamp: 3000 };
    const final = { _id: "m4", role: "assistant", content: "Here is the list.", timestamp: 4000 };
    useInboxStore.getState().setMessages(id, [user, stale, results, final] as any, { initialized: true });
    const server = [user, full, results, final];
    const convex = {
      query: async (_fn: unknown, args: { after_timestamp: number }) => ({
        messages: server.filter((m) => m.timestamp > args.after_timestamp),
        has_more: false,
        last_timestamp: server[server.length - 1].timestamp,
      }),
    };
    const local = useInboxStore.getState().messages[id];
    expect(await readForward(convex, id, rereadAnchor(local, HOSTED_AGENT_TYPE)!)).toBe(4);
    const healed = useInboxStore.getState().messages[id];
    expect(healed.length).toBe(4);
    expect(healed[1].content).toBe(full.content);
    expect((healed[1] as any).tool_calls?.[0]?.name).toBe("write_doc");
  });
});
