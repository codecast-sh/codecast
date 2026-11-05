import { describe, expect, test } from "bun:test";
import { REST_SETTLED_MS, SWEEP_ENDED_MS, SWEEP_MAX_AGE_MS, chainLive, restSettled, settleWhole, sweepLane, sweepPage, sweepQueue, sweepWants, tallyPage } from "./replayRest";
import { REPLAY_REST_NO_MORE } from "@codecast/shared/contracts/replay";
import schema from "../schema";
import { makeFakeDb, schemaIndexes } from "../testDb";

const h = (fn: any) => fn._handler;
import { REST_STALL_MS } from "./vendorReplay";

const now = 2_000_000_000;
const cut = { provider: "posthog", imported_at: now - 60_000, captured_ms: 600_000, duration_ms: 3_600_000, import_rest: null };

describe("the rest sweep", () => {
  test("wants an imported PostHog copy that holds only its start", () => {
    expect(sweepWants(cut, now)).toBe(true);
    expect(sweepWants({ ...cut, captured_ms: 3_600_000 }, now)).toBe(false);
    expect(sweepWants({ ...cut, provider: "sentry" }, now)).toBe(false);
    expect(sweepWants({ ...cut, imported_at: null }, now)).toBe(false);
    expect(sweepWants({ ...cut, vendor_refresh_after: now + 1 }, now)).toBe(false);
  });

  test("wants a long copy whose reach was never stored, and not a short one", () => {
    expect(sweepWants({ ...cut, captured_ms: null }, now)).toBe(true);
    expect(sweepWants({ ...cut, captured_ms: null, duration_ms: 120_000 }, now)).toBe(false);
  });

  test("a chain is live while it steps or waits out a rate limit, and dead once it failed or went quiet", () => {
    expect(chainLive({ import_rest: { updated_at: now - 1000 } }, now)).toBe(true);
    expect(chainLive({ import_rest: { updated_at: now - REST_STALL_MS - 1, retry_at: now + 1000 } }, now)).toBe(true);
    expect(chainLive({ import_rest: { updated_at: now - REST_STALL_MS - 1 } }, now)).toBe(false);
    expect(chainLive({ import_rest: { updated_at: now, error: "PostHog answered 500" } }, now)).toBe(false);
    expect(chainLive({ import_rest: null }, now)).toBe(false);
    // A live chain's row is not wanted again.
    expect(sweepWants({ ...cut, import_rest: { updated_at: now - 1000 } }, now)).toBe(false);
  });
});

describe("which recording the sweep reads next", () => {
  const row = (id: string, started_at: number, extra: Record<string, unknown> = {}) => ({
    _id: id, workspace: "team:t", source_id: "s1", short_id: id, provider: "posthog", external_id: id, started_at, counts: { clicks: 0, errors: 0, failed_requests: 0 },
    group_ids: [], chunk_keys: ["k"], created_at: 1, updated_at: 1, imported_at: now - 60_000, captured_ms: 600_000, duration_ms: 3_600_000, ...extra,
  });
  const db = () => makeFakeDb(
    {
      event_sources: [{ _id: "s1", workspace: "team:t", owner_user_id: "u1", short_id: "src-1", provider: "posthog", name: "ph", promote: [], status: "active", created_at: 1, updated_at: 1 }],
      replays: [row("rp-new", 3), row("rp-linked", 2, { group_ids: ["g1"] }), row("rp-old", 1)],
      event_groups: [{ _id: "g1" }],
    },
    { indexes: schemaIndexes(schema as any) },
  );

  test("a recording linked to an issue comes before newer ones that are not", async () => {
    const d = db();
    const linked = await h(sweepPage)({ db: d }, { source_id: "s1", before: null, cursor: null, now, linked_only: true });
    expect(linked.next?.external_id).toBe("rp-linked");
    const any = await h(sweepPage)({ db: d }, { source_id: "s1", before: null, cursor: null, now });
    expect(any.next?.external_id).toBe("rp-new");
  });

  test("the tally counts cut copies and names the one being read", async () => {
    const d = makeFakeDb(
      { replays: [row("rp-a", 3, { import_rest: { gen: 1, next_blob: 1, blobs: 4, carry_key: "c", updated_at: now - 1000 } }), row("rp-b", 2), row("rp-c", 1, { captured_ms: 3_600_000 })] },
      { indexes: schemaIndexes(schema as any) },
    );
    const page = await h(tallyPage)({ db: d }, { source_id: "s1", cursor: null, now });
    expect(page).toMatchObject({ cut: 2, unknown: 0, reading: { short_id: "rp-a" } });
  });

  test("the queue is the sweep's order: by lane, then newest; past retention the sweep stops", async () => {
    expect(sweepQueue([{ short_id: "a", started_at: 3, lane: 2 }, { short_id: "b", started_at: 1, lane: 1 }, { short_id: "c", started_at: 2, lane: 2 }, { short_id: "d", started_at: 0, lane: 0 }])).toEqual(["d", "b", "a", "c"]);
    const d = makeFakeDb({
      event_sources: [{ _id: "s1", workspace: "team:t", owner_user_id: "u1", short_id: "src-1", provider: "posthog", name: "ph", promote: [], status: "active", created_at: 1, updated_at: 1 }],
      replays: [row("rp-old", now - SWEEP_MAX_AGE_MS - 1)],
    }, { indexes: schemaIndexes(schema as any) });
    const page = await h(sweepPage)({ db: d }, { source_id: "s1", before: null, cursor: null, now });
    expect([page.next, page.done]).toEqual([null, true]);
    const tally = await h(tallyPage)({ db: d }, { source_id: "s1", cursor: null, now });
    expect([tally.cut, tally.wanted.length]).toEqual([1, 0]);
  });

  test("a chain gone quiet is offered as stalled, so the sweep stops it instead of starting the same part", async () => {
    const d = makeFakeDb({
      event_sources: [{ _id: "s1", workspace: "team:t", owner_user_id: "u1", short_id: "src-1", provider: "posthog", name: "ph", promote: [], status: "active", created_at: 1, updated_at: 1 }],
      replays: [row("rp-q", 5, { import_rest: { gen: 1, next_blob: 1, blobs: 4, carry_key: "c", updated_at: now - REST_STALL_MS - 1 } })],
    }, { indexes: schemaIndexes(schema as any) });
    const page = await h(sweepPage)({ db: d }, { source_id: "s1", before: null, cursor: null, now });
    expect(page.next).toMatchObject({ external_id: "rp-q", stalled: true });
  });

  test("a short recording that ended today reads before the issue backlog; one still recording, or that PostHog has no more of, does not", async () => {
    const five = 5 * 60_000;
    const ended = now - five - SWEEP_ENDED_MS - 60_000;
    expect(sweepLane({ started_at: ended, duration_ms: five }, now)).toBe(0);
    expect(sweepLane({ started_at: now - five - 60_000, duration_ms: five }, now)).toBe(2);
    expect(sweepLane({ started_at: ended, duration_ms: 2 * 3_600_000 - five }, now)).toBe(2);
    expect(sweepLane({ started_at: ended, duration_ms: five, import_rest: { error: REPLAY_REST_NO_MORE } }, now)).toBe(2);
    expect(sweepLane({ started_at: now - 3 * 86_400_000, duration_ms: five, counts: { errors: 2 } }, now)).toBe(1);
    const d = makeFakeDb({
      event_sources: [{ _id: "s1", workspace: "team:t", owner_user_id: "u1", short_id: "src-1", provider: "posthog", name: "ph", promote: [], status: "active", created_at: 1, updated_at: 1 }],
      replays: [row("rp-today", ended, { captured_ms: 90_000, duration_ms: five }), row("rp-linked", 2, { group_ids: ["g1"] }), row("rp-old", 1)],
    }, { indexes: schemaIndexes(schema as any) });
    const recent = await h(sweepPage)({ db: d }, { source_id: "s1", before: null, cursor: null, now, lane: "recent" });
    expect(recent.next?.external_id).toBe("rp-today");
    const linked = await h(sweepPage)({ db: d }, { source_id: "s1", before: null, cursor: null, now, lane: "linked" });
    expect(linked.next?.external_id).toBe("rp-today");
  });

  test("a chain that finds no more of an ended recording settles it whole and leaves the backlog", async () => {
    expect(restSettled({ started_at: now - REST_SETTLED_MS - 600_000, duration_ms: 300_000 }, now)).toBe(true);
    expect(restSettled({ started_at: now - 600_000, duration_ms: 300_000 }, now)).toBe(false);
    const d = makeFakeDb({
      event_sources: [{ _id: "s1", workspace: "team:t", owner_user_id: "u1", short_id: "src-1", provider: "posthog", name: "ph", promote: [], status: "active", created_at: 1, updated_at: 1, replay_rest: { cut: 1, unknown: 0, at: 1, reading: "rp-s" } }],
      replays: [row("rp-s", 5, { captured_ms: 93_000, duration_ms: 303_000, import_rest: { gen: 7, next_blob: 3, blobs: 3, carry_key: "c", updated_at: 1 } })],
    }, { indexes: schemaIndexes(schema as any) });
    const scheduled: unknown[] = [];
    await h(settleWhole)({ db: d, scheduler: { runAfter: async (...a: unknown[]) => void scheduled.push(a) } }, { replay_id: "rp-s", gen: 7 });
    const r: any = await d.get("rp-s");
    expect([r.captured_ms, r.import_rest, r.read_to?.next_blob]).toEqual([303_000, undefined, 3]);
    const src: any = await d.get("s1");
    expect([src.replay_rest.reading, src.replay_rest.cut]).toEqual([undefined, 0]);
    expect(scheduled.length).toBe(1);
  });
});
