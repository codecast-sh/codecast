import { describe, expect, test } from "bun:test";
import type { ReplayEvent } from "../contracts/replay";
import { dedupeRrweb } from "./capture";
import {
  compareReplays,
  idleRanges,
  personKey,
  personLabel,
  anonHandle,
  rageBursts,
  replayMatches,
  exactReplayId,
  replayPeople,
  sortPeople,
  replayShape,
  replayFacets,
  resolveReplayFilter,
  REPLAY_DEFAULT_MATCH,
  SHAPE_CELLS,
  type ReplayListRow,
} from "./list";

const NOW = 1_800_000_000_000;
const row = (over: Partial<ReplayListRow> = {}): ReplayListRow => ({
  short_id: "rp-1",
  url: "https://shop.example.com/checkout",
  user: { email: "Ada@Example.com", id: "d-1" },
  started_at: NOW - 3_600_000,
  duration_ms: 90_000,
  counts: { clicks: 4, errors: 0, failed_requests: 0 },
  ...over,
});

describe("the filter", () => {
  test("the list starts past 5s of activity; an unknown activity is kept, and any shows them all", () => {
    const idle = row({ facts: { at: 1, active_ms: 2_000 } });
    const busy = row({ facts: { at: 1, active_ms: 40_000 } });
    const unknown = row();
    const def = resolveReplayFilter({}, NOW);
    expect(def).toEqual({ active_min_ms: 5_000 });
    expect(REPLAY_DEFAULT_MATCH).toEqual(def);
    expect([idle, busy, unknown].map((r) => replayMatches(r, def))).toEqual([false, true, true]);
    expect(replayMatches(idle, resolveReplayFilter({ active: "any" }, NOW))).toBe(true);
    expect(replayMatches(busy, resolveReplayFilter({ active: "1m" }, NOW))).toBe(false);
  });
  test("a recording an issue points at is never hidden by the least-activity default", () => {
    const def = resolveReplayFilter({}, NOW);
    expect(replayMatches(row({ facts: { at: 1, active_ms: 4_500 }, group_ids: ["g1"] }), def)).toBe(true);
    expect(replayMatches(row({ facts: { at: 1, active_ms: 4_500 }, group_ids: [] }), def)).toBe(false);
  });
  test("an exact rp-N search finds that recording whatever else is filtered, and only it", () => {
    const idle = row({ short_id: "rp-5241", facts: { at: 1, active_ms: 1_000 }, started_at: NOW - 90 * 86_400_000 });
    const m = resolveReplayFilter({ q: " RP-5241 ", has: ["errors"], date: "24h" }, NOW);
    expect(exactReplayId(m.q)).toBe("rp-5241");
    expect(replayMatches(idle, m)).toBe(true);
    expect(replayMatches(row({ short_id: "rp-52410" }), m)).toBe(false);
    expect(exactReplayId("rp-")).toBeNull();
    expect(exactReplayId("checkout")).toBeNull();
  });
  test("an issue filter keeps the recordings that caught it", () => {
    const m = resolveReplayFilter({ group_id: "g1", active: "any" }, NOW);
    expect(replayMatches(row({ group_ids: ["g0", "g1"] }), m)).toBe(true);
    expect(replayMatches(row({ group_ids: [] }), m)).toBe(false);
    expect(replayMatches(row(), m)).toBe(false);
  });
  test("shortest puts the shortest known length first and unknown lengths last", () => {
    const rows = [row({ short_id: "a", duration_ms: 90_000 }), row({ short_id: "b", duration_ms: null }), row({ short_id: "c", duration_ms: 4_000 })];
    expect(rows.sort(compareReplays("shortest")).map((r) => r.short_id)).toEqual(["c", "a", "b"]);
  });
  test("search reads the person, the url and the short id, in any case", () => {
    const m = (q: string) => replayMatches(row(), resolveReplayFilter({ q }, NOW));
    expect(m("ada@")).toBe(true);
    expect(m("CHECKOUT")).toBe(true);
    expect(m("rp-1")).toBe(true);
    expect(m("d-1")).toBe(true);
    expect(m("cart")).toBe(false);
  });

  test("toggles keep only recordings that hold the thing", () => {
    const f = (has: ("errors" | "failed" | "rage")[]) => resolveReplayFilter({ has, active: "any" }, NOW);
    expect(replayMatches(row(), f(["errors"]))).toBe(false);
    expect(replayMatches(row({ counts: { clicks: 0, errors: 2, failed_requests: 0 } }), f(["errors"]))).toBe(true);
    expect(replayMatches(row({ counts: { clicks: 0, errors: 2, failed_requests: 0 } }), f(["errors", "failed"]))).toBe(false);
    // A recording read before shapes existed has no rage count: it is not a match, rather than a guess.
    expect(replayMatches(row(), f(["rage"]))).toBe(false);
    expect(replayMatches(row({ shape: { v: 1, active_ms: 1, pages: 1, rage_clicks: 1, strip: "", marks: [] } }), f(["rage"]))).toBe(true);
  });

  test("a length filter never matches an unknown length", () => {
    expect(replayMatches(row(), resolveReplayFilter({ dur: "gt1m" }, NOW))).toBe(true);
    expect(replayMatches(row(), resolveReplayFilter({ dur: "gt5m" }, NOW))).toBe(false);
    expect(replayMatches(row(), resolveReplayFilter({ dur: "lt30s" }, NOW))).toBe(false);
    expect(replayMatches(row({ duration_ms: null }), resolveReplayFilter({ dur: "lt30s" }, NOW))).toBe(false);
  });

  test("a date filter resolves against now", () => {
    expect(replayMatches(row(), resolveReplayFilter({ date: "24h" }, NOW))).toBe(true);
    expect(replayMatches(row({ started_at: NOW - 2 * 86_400_000 }), resolveReplayFilter({ date: "24h" }, NOW))).toBe(false);
    expect(replayMatches(row({ started_at: NOW - 2 * 86_400_000 }), resolveReplayFilter({ date: "7d" }, NOW))).toBe(true);
  });

  test("a person is their email, else their id; an anonymous id reads as a stable handle", () => {
    expect(personKey({ email: "Ada@Example.com", id: "x" })).toBe("ada@example.com");
    expect(personKey({ id: "01a1a2b3c4d5e6f7" })).toBe("01a1a2b3c4d5e6f7");
    expect(personKey(null)).toBeNull();
    const handle = personLabel({ id: "01a1a2b3c4d5e6f7" });
    expect(handle).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ ·[0-9a-z]{3}$/);
    // Two words alone collide across a workspace's anonymous visitors; with the suffix a thousand ids read as a thousand names.
    expect(new Set(Array.from({ length: 1000 }, (_, i) => anonHandle(`0192f${i.toString(16).padStart(6, "0")}-anon`))).size).toBe(1000);
    expect(personLabel({ id: "01a1a2b3c4d5e6f7" })).toBe(handle);
    expect(anonHandle("01a1a2b3c4d5e6f8")).not.toBe(handle);
    // The handle finds them in search, as the id does.
    expect(replayMatches(row({ user: { id: "01a1a2b3c4d5e6f7" } }), resolveReplayFilter({ q: handle.toLowerCase() }, NOW))).toBe(true);
    expect(personLabel(null)).toBe("Anonymous");
    expect(replayMatches(row(), resolveReplayFilter({ person: "ada@example.com" }, NOW))).toBe(true);
    expect(replayMatches(row(), resolveReplayFilter({ person: "bob@example.com" }, NOW))).toBe(false);
  });
});

describe("the sort", () => {
  const a = row({ short_id: "a", started_at: 3, duration_ms: null, counts: { clicks: 1, errors: 0, failed_requests: 0 } });
  const b = row({ short_id: "b", started_at: 2, duration_ms: 10, counts: { clicks: 9, errors: 1, failed_requests: 3 } });
  const c = row({ short_id: "c", started_at: 1, duration_ms: 50, counts: { clicks: 5, errors: 0, failed_requests: 1 } });
  const order = (sort: Parameters<typeof compareReplays>[0]) => [a, b, c].sort(compareReplays(sort)).map((r) => r.short_id).join("");
  test("each sort, with unknown lengths last", () => {
    expect(order("newest")).toBe("abc");
    expect(order("oldest")).toBe("cba");
    expect(order("longest")).toBe("cba");
    expect(order("errors")).toBe("bca");
    expect(order("clicks")).toBe("bca");
  });

  test("people fold their recordings, most recently seen first", () => {
    const people = replayPeople([a, b, c, row({ user: { id: "anon-1" }, started_at: 0 })]);
    expect(people.map((p) => [p.label, p.sessions, p.ms, p.errors, p.failed])).toEqual([
      ["Ada@Example.com", 3, 60, 1, 4],
      [anonHandle("anon-1"), 1, 90_000, 0, 0],
    ]);
    expect(people[1].anonymous).toBe(true);
  });

  test("people sort by recordings, failures or time, ties to the most recently seen", () => {
    const people = replayPeople([a, b, c, row({ user: { id: "anon-1" }, started_at: 0, url: "https://x.test/late" })]);
    expect(sortPeople(people, "recordings").map((p) => p.label)).toEqual(["Ada@Example.com", anonHandle("anon-1")]);
    expect(sortPeople(people, "failures")[0].label).toBe("Ada@Example.com");
    expect(sortPeople(people, "time")[0].key).toBe("anon-1");
    expect(people[1].url).toBe("https://x.test/late");
  });
});

describe("the shape of a recording", () => {
  const click = (t: number, selector = "button.pay"): ReplayEvent => ({ type: "click", t, label: "Pay", selector });
  const events: ReplayEvent[] = [
    { type: "nav", t: 0, url: "https://shop.example.com/" },
    click(1_000),
    click(1_200),
    click(1_400),
    click(1_600),
    { type: "error", t: 2_000, message: "TypeError" },
    { type: "nav", t: 30_000, url: "https://shop.example.com/done" },
    click(31_000, "a.home"),
  ];

  test("the pages visited and the requests that failed are kept, and a search finds the recording by them", () => {
    const failed: ReplayEvent = { type: "network", t: 2_500, method: "POST", url: "https://shop.example.com/api/pay?token=", status: 500, ms: 80 };
    const shape = replayShape([...events, failed].sort((a, b) => a.t - b.t));
    expect(shape.paths).toEqual(["/", "/done"]);
    expect(shape.endpoints).toEqual(["POST /api/pay"]);
    const r = row({ shape });
    expect(replayMatches(r, { q: "/done" })).toBe(true);
    expect(replayMatches(r, { q: "post /api/pay" })).toBe(true);
    expect(replayMatches(r, { q: "/billing" })).toBe(false);
  });

  test("rage clicks are bursts on one element, each counted once", () => {
    expect(rageBursts(events)).toEqual([{ t: 1_000, selector: "button.pay", label: "Pay", clicks: 4 }]);
    expect(rageBursts([click(0), click(900), click(5_000)])).toEqual([]);
  });

  test("idle stretches leave a second at each end, and the tail counts", () => {
    expect(idleRanges(events, 60_000)).toEqual([
      { from: 3_000, to: 29_000 },
      { from: 32_000, to: 60_000 },
    ]);
    expect(idleRanges(events, 31_000)).toEqual([{ from: 3_000, to: 29_000 }]);
  });

  test("the shape counts pages, rage clicks, active time, and marks the failure", () => {
    const shape = replayShape(events);
    expect(shape.pages).toBe(2);
    expect(shape.rage_clicks).toBe(1);
    expect(shape.active_ms).toBe(31_000 - 26_000);
    expect(shape.strip).toHaveLength(SHAPE_CELLS);
    expect(shape.strip.slice(0, 3)).toBe("699");
    expect(shape.strip[SHAPE_CELLS - 1]).not.toBe("0");
    expect(shape.marks).toEqual([65]);
  });
});

describe("a vendor read", () => {
  test("an event sent twice is kept once; the same moment with other data is kept", () => {
    const e = (timestamp: number, data: unknown) => ({ type: 3, timestamp, data }) as any;
    const out = dedupeRrweb([e(1, { source: 2, id: 5 }), e(1, { source: 2, id: 5 }), e(1, { source: 2, id: 6 }), e(2, { source: 2, id: 5 })]);
    expect(out.map((x) => `${x.timestamp}:${x.data.id}`)).toEqual(["1:5", "1:6", "2:5"]);
  });
});

describe("vendor facts", () => {
  const base = { short_id: "rp-1", started_at: 1, counts: { clicks: 0, errors: 0, failed_requests: 0 } };
  test("the partly imported filter keeps copies that stop well short of their length", () => {
    expect(replayMatches({ ...base, duration_ms: 3_600_000, captured_ms: 600_000 }, { has: ["partial"] })).toBe(true);
    expect(replayMatches({ ...base, duration_ms: 3_600_000, captured_ms: 3_599_000 }, { has: ["partial"] })).toBe(false);
    expect(replayMatches({ ...base, duration_ms: 3_600_000 }, { has: ["partial"] })).toBe(false);
  });
  test("the rage filter reads the vendor's count when the stream was never read", () => {
    expect(replayMatches({ ...base, facts: { at: 1, rage_clicks: 2 } }, { has: ["rage"] })).toBe(true);
    expect(replayMatches({ ...base, facts: { at: 1, rage_clicks: 0 } }, { has: ["rage"] })).toBe(false);
    // Either reader seeing a rage click is enough: an import cut short misses what the vendor saw.
    const shape = { v: 1, active_ms: 0, pages: 0, rage_clicks: 0, strip: "", marks: [] };
    expect(replayMatches({ ...base, shape, facts: { at: 1, rage_clicks: 3 } }, { has: ["rage"] })).toBe(true);
    expect(replayMatches({ ...base, shape, facts: { at: 1 } }, { has: ["rage"] })).toBe(false);
  });
  test("environment filters match exactly and leave unknown rows out", () => {
    const chrome = { ...base, facts: { at: 1, browser: "Chrome", os: "Mac OS X", country: "US" } };
    expect(replayMatches(chrome, resolveReplayFilter({ browser: "Chrome", country: "US" }, 0))).toBe(true);
    expect(replayMatches(chrome, resolveReplayFilter({ browser: "Safari" }, 0))).toBe(false);
    expect(replayMatches(base, resolveReplayFilter({ os: "Windows" }, 0))).toBe(false);
  });
  test("facets count each value, most first", () => {
    const rows = [
      { ...base, facts: { at: 1, browser: "Chrome", country: "US" } },
      { ...base, facts: { at: 1, browser: "Chrome", country: "DE" } },
      { ...base, facts: { at: 1, browser: "Safari" } },
      base,
    ];
    const f = replayFacets(rows);
    expect(f.browser).toEqual([["Chrome", 2], ["Safari", 1]]);
    expect(f.country).toEqual([["DE", 1], ["US", 1]]);
    expect(f.os).toEqual([]);
  });
  test("an anonymous person carries where their newest recording ran", () => {
    const people = replayPeople([{ ...base, user: { id: "abc" }, facts: { at: 1, browser: "Opera", os: "Windows", country: "US" } }]);
    expect(people[0].env).toBe("Opera · Windows · US");
  });
});
