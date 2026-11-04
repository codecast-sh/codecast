import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// A watch edited on its page (store/opsSlice.ts updateOpsWatch,
// removeOpsWatch): the line moves in the same tick, holds against a list push
// from before the write, and the echo retires the lock. The poll's own fields
// (state, history) stay the server's.
const serverId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);
const WATCH = serverId("watch1");
const TEAM = serverId("team1");

const watch = (over: Record<string, unknown> = {}) => ({
  _id: WATCH, workspace: `team:${TEAM}`, source_id: serverId("src"), short_id: "mw-8", name: "Exceptions (24h)", query_kind: "hogql", query: "select 1",
  threshold: 15, direction: "above", interval_ms: 3600_000, status: "active", points: [], state: "alert", last_value: 120, last_at: 1, source_name: "union-posthog",
  source_short_id: "src-1", updated_at: 1, ...over,
});

describe("watch writes", () => {
  const owner = {};
  let calls: { action: string; args: any[] }[];
  beforeEach(() => {
    calls = [];
    useInboxStore.setState({ opsWatches: { [WATCH]: watch() }, pending: {} } as any);
    useInboxStore.getState()._setDispatch(async (action, args) => { calls.push({ action, args }); return null; }, { owner });
  });
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));
  const flush = async () => { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
  const row = () => (useInboxStore.getState() as any).opsWatches[WATCH];

  it("a moved line paints at once, survives an older push, and the echo retires it", async () => {
    useInboxStore.getState().updateOpsWatch(WATCH, { threshold: 150, direction: "below" });
    expect(row()).toMatchObject({ threshold: 150, direction: "below" });
    useInboxStore.getState().syncTable("opsWatches", [watch()]);
    expect(row()).toMatchObject({ threshold: 150, direction: "below" });
    useInboxStore.getState().syncTable("opsWatches", [watch({ threshold: 150, direction: "below", state: "ok", updated_at: 2 })]);
    expect(row().state).toBe("ok");
    await flush();
    expect(calls).toEqual([{ action: "updateOpsWatch", args: [WATCH, { threshold: 150, direction: "below" }] }]);
  });

  it("taking the line off makes it a series; pausing and resuming clears a read error", () => {
    useInboxStore.getState().updateOpsWatch(WATCH, { threshold: null });
    expect(row().threshold).toBeUndefined();
    expect(row().state).toBe("ok");
    useInboxStore.setState({ opsWatches: { [WATCH]: watch({ last_error: "403" }) } } as any);
    useInboxStore.getState().updateOpsWatch(WATCH, { status: "paused" });
    expect(row().status).toBe("paused");
    useInboxStore.getState().updateOpsWatch(WATCH, { status: "active" });
    expect(row().last_error).toBeUndefined();
  });

  it("the monitor paints as the server stores it: one read is none, a past mute is none, no line takes the warning", async () => {
    useInboxStore.getState().updateOpsWatch(WATCH, { eval_reads: 3, warn: 10, no_data_after: 5, muted_until: Date.now() + 3600_000 });
    expect(row()).toMatchObject({ eval_reads: 3, warn: 10, no_data_after: 5 });
    expect(row().muted_until).toBeGreaterThan(Date.now());
    useInboxStore.getState().updateOpsWatch(WATCH, { eval_reads: 1, no_data_after: null, muted_until: null });
    expect(row().eval_reads).toBeUndefined();
    expect(row().no_data_after).toBeUndefined();
    expect(row().muted_until).toBeUndefined();
    useInboxStore.getState().updateOpsWatch(WATCH, { threshold: null });
    expect(row().warn).toBeUndefined();
    await flush();
    expect(calls[0]).toEqual({ action: "updateOpsWatch", args: [WATCH, expect.objectContaining({ eval_reads: 3, warn: 10, no_data_after: 5 })] });
  });

  it("removing drops the row now and asks the server", async () => {
    useInboxStore.getState().removeOpsWatch(WATCH);
    expect(row()).toBeUndefined();
    await flush();
    expect(calls).toEqual([{ action: "removeOpsWatch", args: [WATCH] }]);
  });
});
