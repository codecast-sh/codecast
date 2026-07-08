import { describe, expect, test } from "bun:test";
import {
  batchScanConversations,
  encodeFeedCursor,
  paginateTeamFeed,
  parseFeedCursor,
} from "./feedPagination";

// Rows for one member, updated_at descending. `subagent: true` rows simulate
// the filtered-out bands (orchestration swarms) that broke pagination live.
function member(rows: Array<{ t: number; subagent?: boolean }>, id: string) {
  return rows.map((r, i) => ({
    _id: `${id}-${i}`,
    user_id: id,
    updated_at: r.t,
    subagent: !!r.subagent,
  }));
}

function makeFetchPage(tables: Record<string, any[]>) {
  return async (memberId: string, cursor: number | null, take: number) => {
    const rows = (tables[memberId] ?? []).filter((c) => cursor == null || c.updated_at < cursor);
    return rows.slice(0, take);
  };
}

const acceptMain = (c: any) => !c.subagent;

// Drain the feed to the end, asserting per-page invariants as we go.
async function drain(tables: Record<string, any[]>, opts?: { limit?: number; startCursor?: string | null; maxPages?: number }) {
  const limit = opts?.limit ?? 5;
  let cursor: string | null = opts?.startCursor ?? null;
  const pages: any[][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < (opts?.maxPages ?? 50); i++) {
    const page = await paginateTeamFeed({
      memberIds: Object.keys(tables),
      cursor,
      limit,
      fetchPage: makeFetchPage(tables),
      accept: acceptMain,
      perMemberFetch: 4,
      perMemberWant: 3,
      maxBatches: 2,
    });
    pages.push(page.rows);
    for (const r of page.rows) seen.add(r._id);
    if (page.nextCursor == null) break;
    expect(page.nextCursor).not.toBe(cursor); // a continuation must change state
    cursor = page.nextCursor;
  }
  return { pages, seen };
}

describe("paginateTeamFeed", () => {
  test("tiles the full history with zero duplicate rows across pages", async () => {
    const tables = {
      a: member([{ t: 100 }, { t: 90 }, { t: 80 }, { t: 70 }, { t: 60 }, { t: 50 }], "a"),
      b: member([{ t: 95 }, { t: 85 }, { t: 75 }, { t: 65 }, { t: 55 }, { t: 45 }], "b"),
    };
    const { pages, seen } = await drain(tables);
    const all = pages.flat();
    expect(all.length).toBe(seen.size); // no row served twice
    expect(seen.size).toBe(12); // nothing skipped
    for (const page of pages) {
      const ts = page.map((r) => r.updated_at);
      expect([...ts].sort((x, y) => y - x)).toEqual(ts); // desc within page
    }
  });

  test("a dense filtered band in one member doesn't stall or duplicate the others", async () => {
    // Member a: 40 subagent rows wedged mid-history; member b: plain history.
    const aRows = [
      { t: 1000 },
      ...Array.from({ length: 40 }, (_, i) => ({ t: 900 - i, subagent: true })),
      { t: 100 },
    ];
    const tables = {
      a: member(aRows, "a"),
      b: member(Array.from({ length: 10 }, (_, i) => ({ t: 950 - i * 50 })), "b"),
    };
    const { pages, seen } = await drain(tables);
    expect(seen.size).toBe(2 + 10); // every accepted row served exactly once
    expect(pages.flat().length).toBe(seen.size);
  });

  test("rows cut from a merged page are served later, never skipped", async () => {
    // b's rows are all older than a's first page worth — they get cut, then lead.
    const tables = {
      a: member([{ t: 100 }, { t: 99 }, { t: 98 }], "a"),
      b: member([{ t: 50 }, { t: 49 }, { t: 48 }], "b"),
    };
    const { seen } = await drain(tables, { limit: 3 });
    expect(seen.size).toBe(6);
  });

  test("legacy numeric cursor is honored as a shared bound and upgrades to composite", async () => {
    const tables = {
      a: member([{ t: 100 }, { t: 80 }, { t: 60 }], "a"),
      b: member([{ t: 90 }, { t: 70 }, { t: 50 }], "b"),
    };
    const page = await paginateTeamFeed({
      memberIds: ["a", "b"],
      cursor: "85",
      limit: 10,
      fetchPage: makeFetchPage(tables),
      accept: acceptMain,
      perMemberFetch: 4,
      perMemberWant: 5,
      maxBatches: 3,
    });
    expect(page.rows.map((r) => r.updated_at)).toEqual([80, 70, 60, 50]); // strictly below 85
    expect(page.nextCursor).toBeNull(); // both exhausted
  });

  test("end of history is null only when every member's index ran dry", async () => {
    const tables = {
      a: member([{ t: 100 }], "a"),
      b: member(Array.from({ length: 9 }, (_, i) => ({ t: 90 - i })), "b"),
    };
    let cursor: string | null = null;
    let sawNonNullAfterAEmpty = false;
    for (let i = 0; i < 20; i++) {
      const page = await paginateTeamFeed({
        memberIds: ["a", "b"],
        cursor,
        limit: 2,
        fetchPage: makeFetchPage(tables),
        accept: acceptMain,
        perMemberFetch: 3,
        perMemberWant: 2,
        maxBatches: 2,
      });
      if (page.nextCursor == null) break;
      const parsed = parseFeedCursor(page.nextCursor);
      if (parsed.members?.a === null && parsed.members?.b != null) sawNonNullAfterAEmpty = true;
      cursor = page.nextCursor;
    }
    expect(sawNonNullAfterAEmpty).toBe(true); // a done, b still paginating
  });

  test("a member with no visible rows at all cannot wedge the cursor", async () => {
    const tables = {
      a: member(Array.from({ length: 30 }, (_, i) => ({ t: 100 - i, subagent: true })), "a"),
      b: member([{ t: 95 }, { t: 90 }], "b"),
    };
    const { seen, pages } = await drain(tables);
    expect(seen.size).toBe(2);
    expect(pages.length).toBeLessThan(10); // crosses a's 30-row band in few pages
  });
});

describe("feed cursor encoding", () => {
  test("round-trips composite bounds and omits undefined", () => {
    const encoded = encodeFeedCursor({ a: 123, b: null, c: undefined });
    const parsed = parseFeedCursor(encoded);
    expect(parsed.members).toEqual({ a: 123, b: null });
  });

  test("null only when every member is explicitly done", () => {
    expect(encodeFeedCursor({ a: null, b: null })).toBeNull();
    // undefined = not started; rows may remain, so this is NOT end-of-history.
    expect(encodeFeedCursor({ a: null, b: undefined })).not.toBeNull();
  });

  test("legacy and garbage cursors parse safely", () => {
    expect(parseFeedCursor("1779480786475").legacy).toBe(1779480786475);
    expect(parseFeedCursor(null)).toEqual({ legacy: null, members: null });
    expect(parseFeedCursor("not-json{").members).toBeNull();
  });
});

describe("batchScanConversations", () => {
  test("reports the examined floor when stopping on budget, exhausted when dry", async () => {
    const rows = member(Array.from({ length: 10 }, (_, i) => ({ t: 100 - i, subagent: true })), "a");
    const fetchPage = async (cursor: number | null, take: number) =>
      rows.filter((c) => cursor == null || c.updated_at < cursor).slice(0, take);
    const budgeted = await batchScanConversations({
      fetchPage, startCursor: null, want: 5, accept: acceptMain, batchSize: 3, maxBatches: 2,
    });
    expect(budgeted.rows.length).toBe(0);
    expect(budgeted.exhausted).toBe(false);
    expect(budgeted.oldestSeen).toBe(95); // examined 6 rows: 100..95
    const drained = await batchScanConversations({
      fetchPage, startCursor: null, want: 5, accept: acceptMain, batchSize: 50, maxBatches: 2,
    });
    expect(drained.exhausted).toBe(true);
  });
});
