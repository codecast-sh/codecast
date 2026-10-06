// The bulk import of a vendor source's recordings (external-data.md X5): one
// page at a time, skipping what is already ours, waiting out a 429, advancing
// the cursor only past a finished page, and stopping the source on a refused
// token.
import { describe, expect, test } from "bun:test";
import schema from "../schema";
import { makeFakeDb, schemaIndexes } from "../testDb";
import { REPLAY_BACKFILL_PAGE, listPostHogPage, runBackfillPage, savePage, type BackfillVendor } from "./replayBackfill";
import { VendorCallError } from "./vendorReplay";
import { replayBackfillLine, replayBackfillResumes, type ReplayBackfill } from "@codecast/shared/contracts/replay";

const h = (fn: any) => fn._handler;

function fresh(over: Partial<ReplayBackfill> = {}): ReplayBackfill {
  return { status: "running", window: "30d", since: 0, until: 1_000, listed: 0, imported: 0, skipped: 0, failed: 0, started_at: 100, updated_at: 100, ...over };
}

/** A vendor with numbered pages; `fail` answers a failure for an id until it is cleared. */
function vendor(pages: Record<string, { ids: string[]; next: string | null }>, opts: { known?: string[]; fail?: Record<string, any>; listError?: VendorCallError } = {}) {
  const known = new Set(opts.known ?? []);
  const calls: string[] = [];
  const v: BackfillVendor = {
    name: "PostHog",
    list: async (cursor) => {
      if (opts.listError) throw opts.listError;
      return pages[cursor ?? "0"];
    },
    imported: async (ids) => new Set(ids.filter((id) => known.has(id))),
    importOne: async (id) => {
      calls.push(id);
      const f = opts.fail?.[id];
      if (f) return { ok: false, ...f };
      known.add(id);
      return { ok: true };
    },
  };
  return { v, calls, known, opts };
}

const clock = (start = 1_000) => ({ now: () => start });

describe("runBackfillPage", () => {
  test("skips recordings already imported, imports the rest, and advances the cursor", async () => {
    const { v, calls } = vendor({ "0": { ids: ["a", "b", "c"], next: "3" } }, { known: ["b"] });
    const out = await runBackfillPage(v, fresh(), clock());
    expect(calls.sort()).toEqual(["a", "c"]);
    expect(out.state).toMatchObject({ status: "running", cursor: "3", listed: 3, imported: 2, skipped: 1, failed: 0 });
    expect(out.state.page_seen).toBeUndefined();
    // A page that imported something is followed by the pacing pause; one that only skipped runs on at once.
    expect(out.next_in_ms).toBe(REPLAY_BACKFILL_PAGE.pause_ms);
    const skipOnly = await runBackfillPage(vendor({ "0": { ids: ["x"], next: "1" } }, { known: ["x"] }).v, fresh(), clock());
    expect(skipOnly.next_in_ms).toBe(0);
  });

  test("the last page finishes the import", async () => {
    const { v } = vendor({ "3": { ids: ["d"], next: null } });
    const out = await runBackfillPage(v, fresh({ cursor: "3", listed: 3, imported: 2, skipped: 1 }), clock(5_000));
    expect(out.next_in_ms).toBeNull();
    expect(out.state).toMatchObject({ status: "done", listed: 4, imported: 3, finished_at: 5_000 });
    expect(out.state.cursor).toBeUndefined();
  });

  test("a 429 mid page waits the vendor's Retry-After and redoes the page, counting each recording once", async () => {
    const world = vendor({ "0": { ids: ["a", "b", "c", "d"], next: "4" } }, { fail: { c: { error: "PostHog answered 429", status: 429, retry_after_ms: 30_000 } } });
    const first = await runBackfillPage(world.v, fresh(), clock());
    expect(first.next_in_ms).toBe(30_000);
    expect(first.state.status).toBe("running");
    expect(first.state.cursor).toBeUndefined();
    expect(first.state.listed).toBe(0);
    const doneFirst = first.state.imported;
    expect(first.state.page_seen?.length).toBe(doneFirst);
    expect(first.state.page_seen).not.toContain("c");

    delete world.opts.fail!.c;
    const second = await runBackfillPage(world.v, first.state, clock());
    expect(second.state).toMatchObject({ cursor: "4", listed: 4, imported: 4, skipped: 0, failed: 0 });
    expect(second.state.page_seen).toBeUndefined();
  });

  test("a 429 with no Retry-After waits the default, and a huge one is capped", async () => {
    const plain = await runBackfillPage(vendor({}, { listError: new VendorCallError({ error: "429", status: 429 }) }).v, fresh(), clock());
    expect(plain.next_in_ms).toBe(REPLAY_BACKFILL_PAGE.rate_wait_ms);
    expect(plain.state.status).toBe("running");
    const huge = await runBackfillPage(vendor({}, { listError: new VendorCallError({ error: "429", status: 429, retry_after_ms: 86_400_000 }) }).v, fresh(), clock());
    expect(huge.next_in_ms).toBe(REPLAY_BACKFILL_PAGE.max_rate_wait_ms);
  });

  test("a refused token pauses the import and reports the connection lost", async () => {
    const list = await runBackfillPage(vendor({}, { listError: new VendorCallError({ error: "PostHog refused the token (401)", status: 401 }) }).v, fresh(), clock());
    expect(list.next_in_ms).toBeNull();
    expect(list.lost).toBe("PostHog refused the token (401)");
    expect(list.state).toMatchObject({ status: "paused", last_error: "PostHog refused the token (401)" });

    const mid = await runBackfillPage(vendor({ "0": { ids: ["a"], next: null } }, { fail: { a: { error: "PostHog refused the token (403)", status: 403, lost: true } } }).v, fresh(), clock());
    expect(mid.lost).toContain("403");
    expect(mid.state.status).toBe("paused");
    // Resumable: a later start continues from this page.
    expect(replayBackfillResumes(mid.state, 2_000)).toBe(true);
  });

  test("a recording the vendor will not hand over is counted failed and not retried; enough in a row stop the import", async () => {
    const one = await runBackfillPage(vendor({ "0": { ids: ["a", "b"], next: "2" } }, { fail: { a: { error: "PostHog answered 404", status: 404 } } }).v, fresh(), clock());
    expect(one.state).toMatchObject({ cursor: "2", imported: 1, failed: 1, listed: 2 });

    const ids = Array.from({ length: 12 }, (_, i) => `r${i}`);
    const fail = Object.fromEntries(ids.map((id) => [id, { error: "Replays storage is not configured (REPLAYS_R2_*)" }]));
    const broken = await runBackfillPage(vendor({ "0": { ids, next: "12" } }, { fail }).v, fresh(), clock());
    expect(broken.state.status).toBe("error");
    expect(broken.state.last_error).toContain("Replays storage");
    expect(broken.next_in_ms).toBeNull();
  });

  test("out of time with recordings left, the same page runs again at once", async () => {
    let t = 0;
    const tick = { now: () => (t += REPLAY_BACKFILL_PAGE.budget_ms / 2) };
    const out = await runBackfillPage(vendor({ "0": { ids: ["a", "b", "c", "d", "e", "f"], next: "6" } }).v, fresh(), tick);
    expect(out.next_in_ms).toBe(0);
    expect(out.state.cursor).toBeUndefined();
    expect(out.state.page_seen!.length).toBe(out.state.imported);
    expect(out.state.imported).toBeLessThan(6);
  });
});

describe("listPostHogPage", () => {
  const conn = { token: "phx_secret", host: "https://us.posthog.com", project_id: "42" };

  test("asks for one page inside the pinned window and answers the next offset", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ results: [{ id: "r1" }, { id: "r2" }, { id: "../bad" }], has_next: true }), { status: 200 });
    }) as any;
    const page = await listPostHogPage(conn, { since: Date.UTC(2026, 8, 1), until: Date.UTC(2026, 9, 1) }, "20", fetchImpl);
    expect(page).toEqual({ ids: ["r1", "r2"], next: "23" });
    const q = new URL(urls[0]).searchParams;
    expect(new URL(urls[0]).pathname).toBe("/api/projects/42/session_recordings/");
    expect(q.get("offset")).toBe("20");
    expect(q.get("limit")).toBe(String(REPLAY_BACKFILL_PAGE.list_size));
    expect(q.get("date_from")).toBe("2026-09-01T00:00:00.000Z");
    expect(q.get("date_to")).toBe("2026-10-01T00:00:00.000Z");
  });

  test("the last page has no next, and a 429 carries Retry-After", async () => {
    const last = await listPostHogPage(conn, { until: 1 }, undefined, (async () => new Response(JSON.stringify({ results: [{ id: "r9" }], has_next: false }), { status: 200 })) as any);
    expect(last.next).toBeNull();
    const err = await listPostHogPage(conn, { until: 1 }, undefined, (async () => new Response("{}", { status: 429, headers: { "Retry-After": "12" } })) as any).catch((e) => e);
    expect(err).toBeInstanceOf(VendorCallError);
    expect(err.status).toBe(429);
    expect(err.retry_after_ms).toBe(12_000);
  });
});

describe("savePage", () => {
  function world(state: ReplayBackfill, status: "active" | "paused" = "active") {
    const db = makeFakeDb(
      { event_sources: [{ _id: "src1", workspace: "team:t", owner_user_id: "u1", short_id: "src-1", provider: "posthog", name: "posthog", promote: [], status, replay_backfill: state, created_at: 1, updated_at: 1 }] },
      { indexes: schemaIndexes(schema as any) },
    );
    const scheduled: Array<{ ms: number; args: any }> = [];
    const ctx = { db, scheduler: { runAfter: async (ms: number, _fn: any, args: any) => void scheduled.push({ ms, args }) } };
    return { db, ctx, scheduled };
  }

  test("writes the page and schedules the next one for the same run", async () => {
    const { db, ctx, scheduled } = world(fresh());
    await h(savePage)(ctx, { source_id: "src1", run: 100, state: fresh({ cursor: "10", listed: 10, imported: 10 }), next_in_ms: 15_000 });
    expect((await db.get("src1" as any))!.replay_backfill).toMatchObject({ cursor: "10", imported: 10 });
    expect(scheduled).toEqual([{ ms: 15_000, args: { source_id: "src1", run: 100 } }]);
  });

  test("a page from an earlier run writes nothing", async () => {
    const { db, ctx, scheduled } = world(fresh({ started_at: 200 }));
    await h(savePage)(ctx, { source_id: "src1", run: 100, state: fresh({ imported: 99 }), next_in_ms: 0 });
    expect((await db.get("src1" as any))!.replay_backfill.imported).toBe(0);
    expect(scheduled).toEqual([]);
  });

  test("a stop that landed while the page ran keeps the counts and schedules nothing", async () => {
    const { db, ctx, scheduled } = world(fresh({ status: "paused", last_error: "Stopped" }));
    await h(savePage)(ctx, { source_id: "src1", run: 100, state: fresh({ imported: 4, cursor: "10" }), next_in_ms: 0 });
    expect((await db.get("src1" as any))!.replay_backfill).toMatchObject({ status: "paused", last_error: "Stopped", imported: 4, cursor: "10" });
    expect(scheduled).toEqual([]);
  });

  test("a lost connection stops the source too (lib/sourceHealth)", async () => {
    const { db, ctx, scheduled } = world(fresh());
    const paused = fresh({ status: "paused", last_error: "PostHog refused the token (401)" });
    await h(savePage)(ctx, { source_id: "src1", run: 100, state: paused, lost: "PostHog refused the token (401)" });
    const row = (await db.get("src1" as any))!;
    expect(row.status).toBe("error");
    expect(row.last_error).toBe("PostHog refused the token (401)");
    expect(row.replay_backfill.status).toBe("paused");
    expect(scheduled).toEqual([]);
  });
});

test("the summary line names the window, the counts and why it stopped", () => {
  expect(replayBackfillLine(fresh({ listed: 40, imported: 30, skipped: 10 }), 200)).toBe("importing the last 30d: 40 listed, 30 imported, 10 already here");
  expect(replayBackfillLine(fresh({ status: "paused", window: "all", last_error: "Stopped" }), 200)).toBe("paused all retained recordings: 0 listed, 0 imported: Stopped");
  expect(replayBackfillLine(fresh({ updated_at: 0 }), 60 * 60_000)).toMatch(/^stalled/);
});
