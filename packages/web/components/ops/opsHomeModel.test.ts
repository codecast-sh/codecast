import { describe, expect, test } from "bun:test";
import { ATTENTION_FILTERS, BADGE_STATES, filterWords, attentionCounts, attentionItems as rawItems, admitsShow, foldedTitle, groupSources, handled, healthBad, homeIssueRefs, issueAttention, opsBadge, replayName, resolveSource, sourceLastDay, titleShape, type AttentionInput } from "./opsHomeModel";
import type { SourceHealth } from "./sourceHealth";
import type { OpsGroup, OpsReplay, OpsSource, OpsWatch } from "./opsTypes";

const NOW = Date.UTC(2026, 10, 3, 12);
const H = 3600_000;

const source = (over: Partial<OpsSource> = {}): OpsSource => ({
  _id: "s1", short_id: "src-1", workspace: "team:t", owner_user_id: "u", provider: "sdk", name: "web", keyed: true,
  promote: [], status: "active", last_event_at: NOW - 60_000, created_at: NOW - 30 * 24 * H, updated_at: NOW, ...over,
});
const group = (over: Partial<OpsGroup> = {}): OpsGroup => ({
  _id: "g1", workspace: "team:t", source_id: "s1", short_id: "eg-1", kind: "error", fingerprint: "f", title: "TypeError",
  status: "open", first_seen: NOW - 2 * H, last_seen: NOW - H, count: 3, buckets: [], updated_at: NOW, ...over,
});
const watch = (over: Partial<OpsWatch> = {}): OpsWatch => ({
  _id: "w1", workspace: "team:t", source_id: "s1", short_id: "mw-1", name: "Signups", query_kind: "series", query: "q",
  direction: "below", interval_ms: 300_000, status: "active", points: [], state: "ok", last_value: 1, last_at: NOW,
  source_name: "web", source_short_id: "src-1", updated_at: NOW, ...over,
});
const replay = (over: Partial<OpsReplay> = {}): OpsReplay => ({
  _id: "r1", short_id: "rp-1", workspace: "team:t", source_id: "s1", source_name: "web", provider: "posthog", external_id: "x",
  url: null, user: null, started_at: NOW - H, duration_ms: 1000, counts: { clicks: 1, errors: 2, failed_requests: 0 },
  group_ids: [], chunks: 1, has_timeline: false, imported_at: NOW, updated_at: NOW, ...over,
});

// The one health reading (sourceHealth.ts), stubbed: a source with status "error" reads stopped, any other flowing.
const reading = (s: OpsSource): SourceHealth => ({
  lastAt: s.last_event_at ?? null, today: 0, normal: 0, days: [], dropped: 0, polledAt: null, reason: s.last_error ?? null, fix: null,
  ...(s.status === "error" ? { state: "stopped", tone: "bad", label: "Stopped" } : { state: "flowing", tone: "ok", label: "Flowing" }),
}) as SourceHealth;
const attentionItems = (input: AttentionInput, now: number) => rawItems(input, now, reading);

/** Hourly buckets: `perHour` for each of the `hours` before the last two, then `last` in the newest hour. */
const buckets = (perHour: number, hours: number, last: number) => [
  ...Array.from({ length: hours }, (_, i) => ({ hour: NOW - (i + 2) * H, count: perHour })),
  { hour: NOW, count: last },
];

test("only a stopped or failing reading asks a person to act", () => {
  expect(healthBad({ tone: "bad" })).toBe(true);
  expect(healthBad({ tone: "warn" })).toBe(true);
  expect(healthBad({ tone: "calm" })).toBe(false);
  expect(healthBad({ tone: "off" })).toBe(false);
  expect(healthBad(undefined)).toBe(false);
});

describe("attentionItems", () => {
  test("worst first: a regression and an alerting watch above a new issue, above a replay", () => {
    const items = attentionItems({
      sources: [source()],
      groups: [group(), group({ _id: "g2", short_id: "eg-2", first_seen: NOW - 9 * 24 * H, regressed_at: NOW - 3 * H })],
      watches: [watch({ state: "alert" })],
      replays: [replay()],
    }, NOW);
    expect(items.map((i) => i.key)).toEqual(["watch:w1", "issue:g2", "issue:g1", "replay:r1"]);
    expect(items[1].state).toBe("regressed");
  });

  test("old, resolved, fine-now and watch-backed groups are not listed; replays an issue covers fold into it", () => {
    const items = attentionItems({
      sources: [],
      groups: [
        group({ first_seen: NOW - 3 * 24 * H }),
        group({ _id: "g2", status: "resolved" }),
        group({ _id: "g3", kind: "check", meta: { ok: true } }),
        group({ _id: "g4", kind: "metric" }),
        group({ _id: "g5" }),
      ],
      watches: [watch({ group_id: "g4" })],
      replays: [replay({ group_ids: ["g5"] }), replay({ _id: "r4", started_at: NOW - 30 * 60_000, group_ids: ["g5"] }), replay({ _id: "r2", counts: { clicks: 0, errors: 0, failed_requests: 0 } }), replay({ _id: "r3", started_at: NOW - 2 * 24 * H })],
    }, NOW);
    expect(items.map((i) => i.key)).toEqual(["issue:g5"]);
    const it = items[0];
    expect(it.kind === "issue" && [it.replay?._id, it.replays]).toEqual(["r4", 2]);
  });

  test("an old issue whose day ran 3x its usual is escalating (the Issues lane's rule), ranks with the pages, and outranks a new issue seen once", () => {
    const old = group({ _id: "g7", short_id: "eg-7", first_seen: NOW - 3 * 24 * H, count: 400, buckets: buckets(1, 40, 175) });
    const once = group({ _id: "g8", short_id: "eg-8", first_seen: NOW - 10 * 60_000, count: 1 });
    const items = attentionItems({ sources: [], groups: [once, old], watches: [], replays: [] }, NOW);
    expect(items.map((i) => [i.key, i.state, i.severity])).toEqual([["issue:g7", "escalating", 3], ["issue:g8", "new", 1]]);
    expect(issueAttention(old, NOW)?.spike).toMatchObject({ recent: 22 + 175, baseline: 9 });
  });

  test("a steady busy issue is not escalating but firing, and a brand new one is new, never escalating", () => {
    // 50 an hour for days: its usual rate, so never escalating; over FIRING_MIN a day and still going, so firing.
    expect(issueAttention(group({ first_seen: NOW - 3 * 24 * H, buckets: buckets(50, 40, 60) }), NOW)?.state).toBe("firing");
    // The same rate gone quiet three hours is ongoing, out of the list.
    expect(issueAttention(group({ first_seen: NOW - 3 * 24 * H, last_seen: NOW - 4 * H, buckets: buckets(50, 40, 60) }), NOW)).toBeNull();
    expect(issueAttention(group({ first_seen: NOW - 2 * H, buckets: buckets(0, 0, 500) }), NOW)?.state).toBe("new");
    expect(issueAttention(group({ first_seen: NOW - 3 * 24 * H, buckets: buckets(0, 40, 6) }), NOW)).toBeNull();
  });

  test("inside a severity, the issue with more events this day leads", () => {
    const small = group({ _id: "a", short_id: "eg-a", count: 12, buckets: [{ hour: NOW - H, count: 12 }] });
    const big = group({ _id: "b", short_id: "eg-b", count: 300, first_seen: NOW - 3 * H, buckets: [{ hour: NOW - H, count: 300 }] });
    expect(attentionItems({ sources: [], groups: [small, big], watches: [], replays: [] }, NOW).map((i) => i.key)).toEqual(["issue:b", "issue:a"]);
  });

  test("a paused watch alerts nobody; a source the one reading calls stopped is listed", () => {
    const items = attentionItems({ sources: [source({ status: "error" })], groups: [], watches: [watch({ state: "alert", status: "paused" })], replays: [] }, NOW);
    expect(items.map((i) => i.key)).toEqual(["source:s1"]);
  });

  test("every item sits under exactly one kind, so the kinds add up to the list (the Overview tab's count)", () => {
    const items = attentionItems({
      sources: [source({ status: "error" }), source({ _id: "s2" })],
      groups: [group(), group({ _id: "g2", regressed_at: NOW - H, first_seen: NOW - 9 * 24 * H }), group({ _id: "g7", first_seen: NOW - 3 * 24 * H, buckets: buckets(1, 40, 90) })],
      watches: [watch({ state: "alert" })],
      replays: [replay()],
    }, NOW);
    const counts = attentionCounts(items);
    const kinds = ATTENTION_FILTERS.filter((f) => f.key !== "unassigned").reduce((n, f) => n + counts[f.key], 0);
    expect(kinds).toBe(items.length);
    expect(counts).toMatchObject({ alerting: 1, regressed: 1, escalating: 1, new: 1, errors: 1, sources: 1 });
  });
});

describe("nobody on it", () => {
  const task = (over: Record<string, unknown>) => ({ short_id: "ct-1", status: "open", assignee: null, ...over });
  test("a task filed and left open with nobody on it is still nobody's; work in progress, an assignee or a session is someone's", () => {
    expect(handled({ sessionId: null, task: task({}) })).toBe(false);
    expect(handled({ sessionId: null, task: null })).toBe(false);
    expect(handled({ sessionId: null, task: task({ status: "in_progress" }) })).toBe(true);
    expect(handled({ sessionId: null, task: task({ assignee: "u1" }) })).toBe(true);
    expect(handled({ sessionId: null, task: task({ assignee: "u1", status: "done" }) })).toBe(false);
    expect(handled({ sessionId: "c1", task: null })).toBe(true);
  });

  test("the filter and its count read the task from the store", () => {
    const tasks: Record<string, any> = { t1: task({}), t2: task({ status: "in_progress" }) };
    const items = attentionItems({
      sources: [source({ status: "error" })],
      groups: [group(), group({ _id: "g2", signal_task_id: "t1" }), group({ _id: "g3", signal_task_id: "t2" }), group({ _id: "g4", fix_conversation_id: "c1" })],
      watches: [watch({ state: "alert" })],
      replays: [replay()],
      taskOf: (id) => tasks[id],
    }, NOW);
    expect(attentionCounts(items).unassigned).toBe(3);
    expect(items.filter((i) => admitsShow(i, "unassigned")).map((i) => i.key).sort()).toEqual(["issue:g1", "issue:g2", "watch:w1"]);
  });
});

test("the sidebar badge is the home's paging tiles: alerting, regressed, spiking and sources down", () => {
  const items = attentionItems({
    sources: [source(), source({ _id: "s2", status: "error" })],
    groups: [group(), group({ _id: "g2", regressed_at: NOW - H, first_seen: NOW - 9 * 24 * H })],
    watches: [watch({ state: "alert" }), watch({ _id: "w2" })],
    replays: [replay()],
  }, NOW);
  const counts = attentionCounts(items);
  expect(opsBadge(items)).toEqual({ n: counts.alerting + counts.regressed + counts.escalating + counts.sources, words: "1 alerting · 1 regressed · 1 source down" });
});

test("a replay with no address is named by whose session it was, never its vendor id or a uuid", () => {
  expect(replayName({ url: null, user: { email: "a@b.co" }, duration_ms: 1000 })).toBe("Session of a@b.co");
  expect(replayName({ url: null, user: null, duration_ms: null })).toBe("Anonymous session");
  expect(replayName({ url: null, user: { id: "01a155b5-a322-7c1e-9d2f-0123456789ab" }, duration_ms: 65_000 })).not.toContain("01a155b5");
  expect(replayName({ url: null, user: { id: "ada" }, duration_ms: null })).toBe("Session of ada");
});

test("a source's last 24h is its groups' occurrences in the window plus its replays, the total its own chart draws", () => {
  const groups = [
    group({ _id: "a", buckets: [{ hour: NOW - H, count: 74 }, { hour: NOW - 5 * H, count: 300 }, { hour: NOW - 30 * H, count: 999 }] }),
    group({ _id: "b", buckets: [{ hour: NOW, count: 8 }] }),
    group({ _id: "c", source_id: "other", buckets: [{ hour: NOW, count: 50 }] }),
  ];
  const replays = [replay({ started_at: NOW - 2 * H }), replay({ _id: "r2", started_at: NOW - 30 * H }), replay({ _id: "r3", source_id: "other" })];
  // The door's own day counter (events_today) plays no part: it counts ingest pushes, not occurrences.
  expect(sourceLastDay("s1", groups, replays, NOW)).toEqual({ occurrences: 74 + 300 + 8, replays: 1, total: 383 });
});

test("an issue's attention state is one rule for the home and the palette", () => {
  expect(issueAttention(group({ first_seen: NOW - 2 * H }), NOW)?.state).toBe("new");
  expect(issueAttention(group({ first_seen: NOW - 5 * 24 * H, regressed_at: NOW - H }), NOW)?.state).toBe("regressed");
  expect(issueAttention(group({ first_seen: NOW - 5 * 24 * H }), NOW)).toBeNull();
  expect(issueAttention(group({ status: "resolved" }), NOW)).toBeNull();
});

test("the source filter groups by provider in a fixed order and finds by name, provider or src-N", () => {
  const rows = [source({ _id: "a", name: "web", provider: "sdk" }), source({ _id: "b", name: "union-posthog", provider: "posthog", short_id: "src-9" }), source({ _id: "c", name: "api", provider: "sdk" })];
  expect(groupSources(rows, "").map((g) => [g.provider, g.sources.map((s) => s.name)])).toEqual([["posthog", ["union-posthog"]], ["sdk", ["api", "web"]]]);
  expect(groupSources(rows, "posthog").map((g) => g.provider)).toEqual(["posthog"]);
  expect(groupSources(rows, "src-9")[0].sources[0].name).toBe("union-posthog");
  expect(resolveSource(rows, "src-9")?._id).toBe("b");
  expect(resolveSource(rows, "web")?._id).toBe("a");
  expect(resolveSource(rows, null)).toBeUndefined();
});

describe("replay errors, one row per root cause", () => {
  test("replays naming the same issue fold into one row that counts its replays and people, and opens on the issue", async () => {
    const { replayUsers } = await import("./opsHomeModel");
    // An old issue (not listed itself) that five replays from three people keep hitting.
    const old = group({ _id: "g9", short_id: "eg-9", title: "GET /api/users/:id answers 403", first_seen: NOW - 9 * 24 * H });
    const rs = [
      replay({ _id: "a", group_ids: ["g9"], user: { id: "ada" }, started_at: NOW - 5 * H }),
      replay({ _id: "b", group_ids: ["g9"], user: { id: "ada" }, started_at: NOW - 4 * H }),
      replay({ _id: "c", group_ids: ["g9"], user: { email: "bo@x.co" }, started_at: NOW - 3 * H }),
      replay({ _id: "d", group_ids: ["g9"], user: null, started_at: NOW - 2 * H }),
      replay({ _id: "e", group_ids: ["g9"], user: null, started_at: NOW - H }),
      // One that names no issue stays its own row.
      replay({ _id: "solo", group_ids: [], user: { id: "cy" }, started_at: NOW - H }),
    ];
    const items = attentionItems({ sources: [source()], groups: [old], watches: [], replays: rs }, NOW);
    expect(items.map((i) => i.key)).toEqual(["replays:g9", "replay:solo"]);
    const sig = items[0];
    if (sig.kind !== "replay") throw new Error("expected a replay row");
    expect([sig.replays.length, sig.users, sig.replay._id, sig.group?.short_id]).toEqual([5, 4, "e", "eg-9"]);
    expect(replayUsers(rs.slice(0, 2))).toBe(1);
  });

  test("more people outrank more errors", () => {
    const g1 = group({ _id: "g1", first_seen: NOW - 9 * 24 * H });
    const g2 = group({ _id: "g2", short_id: "eg-2", first_seen: NOW - 9 * 24 * H });
    const items = attentionItems({
      sources: [source()], groups: [g1, g2], watches: [],
      replays: [
        replay({ _id: "loud", group_ids: ["g1"], counts: { clicks: 0, errors: 400, failed_requests: 0 }, user: { id: "a" } }),
        replay({ _id: "p1", group_ids: ["g2"], user: { id: "a" } }),
        replay({ _id: "p2", group_ids: ["g2"], user: { id: "b" } }),
      ],
    }, NOW);
    expect(items.map((i) => i.key)).toEqual(["replays:g2", "replays:g1"]);
  });
});

describe("a watch that cannot read", () => {
  test("is a watch error row, never its source down, and pages nobody", () => {
    const blind = watch({ threshold: 10, last_error: "no answer in 15s", missed: 3 });
    const items = attentionItems({ sources: [source()], groups: [], watches: [blind], replays: [] }, NOW);
    expect(items.map((i) => [i.key, i.state])).toEqual([["watch-error:w1", "erroring"]]);
    expect(attentionCounts(items).erroring).toBe(1);
    expect(attentionCounts(items).sources).toBe(0);
    expect(opsBadge(items).n).toBe(0);
  });

  test("one failed read is not yet an error", () => {
    const once = watch({ threshold: 10, last_error: "timeout", missed: 1 });
    expect(attentionItems({ sources: [source()], groups: [], watches: [once], replays: [] }, NOW)).toEqual([]);
  });
});

test("the watch band counts every live watch by health and leads with the worst, the healthy ones closest to their line first", async () => {
  const { watchBand } = await import("./opsHomeModel");
  const band = watchBand([
    watch({ _id: "far", name: "Far", threshold: 10, direction: "above", last_value: 1 }),
    watch({ _id: "near", name: "Near", threshold: 10, direction: "above", last_value: 9 }),
    watch({ _id: "alert", name: "Alert", threshold: 10, direction: "above", last_value: 20, state: "alert" }),
    watch({ _id: "blind", name: "Blind", threshold: 10, last_error: "boom", missed: 2 }),
    watch({ _id: "off", name: "Off", status: "paused" }),
  ]);
  expect(band.watches.map((w) => w._id)).toEqual(["alert", "blind", "near", "far"]);
  expect([band.counts.alert, band.counts.error, band.counts.ok, band.counts.paused]).toEqual([1, 1, 2, 0]);
});

test("the band's tiles are the watches that are not fine; the healthy ones fold behind their count", async () => {
  const { watchBand } = await import("./opsHomeModel");
  const band = watchBand([
    watch({ _id: "ok", threshold: 10, direction: "above", last_value: 1 }),
    watch({ _id: "series" }),
    watch({ _id: "alert", threshold: 10, direction: "above", last_value: 20, state: "alert" }),
    watch({ _id: "warn", threshold: 10, warn: 5, direction: "above", last_value: 7 }),
    watch({ _id: "nodata", threshold: 10, last_value: null }),
  ]);
  expect(band.attention.map((w) => w._id)).toEqual(["alert", "warn", "nodata"]);
  expect(band.healthy.map((w) => w._id).sort()).toEqual(["ok", "series"]);
});

describe("a source that is degraded, not down", () => {
  const withHealth = (h: Partial<SourceHealth>) => (s: OpsSource) => ({ ...reading(s), ...h }) as SourceHealth;
  test("a failing import or reader is amber: its own tile, never Sources down, and it pages nobody", () => {
    const items = rawItems({ sources: [source({ provider: "posthog" })], groups: [], watches: [], replays: [] }, NOW, withHealth({ state: "failing", tone: "warn", label: "Import stalled", level: "degraded" }));
    expect(items.map((i) => [i.key, i.state, i.severity])).toEqual([["source:s1", "degraded", 2]]);
    expect(attentionCounts(items)).toMatchObject({ sources: 0, degraded: 1 });
    expect(opsBadge(items).n).toBe(0);
  });

  test("an app whose own check fails is a check failing: listed, red, paging, and never counted as a metric watch alerting", () => {
    const items = rawItems({ sources: [source({ provider: "app", name: "union" })], groups: [], watches: [], replays: [] }, NOW, withHealth({ state: "failing", tone: "warn", label: "Invariants check failing", level: "degraded", fix: "watches", problems: [{ kind: "check", name: "Invariants", line: "Invariants: the response is over 256 KB" }] }));
    expect(items.map((i) => [i.key, i.state, i.severity])).toEqual([["source:s1", "check", 3]]);
    expect(attentionCounts(items)).toMatchObject({ alerting: 0, check: 1, degraded: 0 });
    expect(opsBadge(items).words).toBe("1 check failing");
    expect(opsBadge(items).n).toBe(1);
    // Calls failing alone stay amber.
    const calls = rawItems({ sources: [source({ provider: "app" })], groups: [], watches: [], replays: [] }, NOW, withHealth({ state: "degraded", tone: "warn", label: "1 call failing", level: "degraded", fix: "calls", problems: [{ kind: "act", name: "deploy", line: "deploy: 500" }] }));
    expect(calls.map((i) => i.state)).toEqual(["degraded"]);
  });

  test("a source halted on an error is down", () => {
    const items = rawItems({ sources: [source({ status: "error" })], groups: [], watches: [], replays: [] }, NOW, withHealth({ state: "failing", tone: "warn", label: "Stopped on error", level: "down" }));
    expect(items.map((i) => i.state)).toEqual(["source"]);
    expect(opsBadge(items).n).toBe(1);
  });

  test("one failing reader is one row, whatever number of watches it blinds, and the source is not listed again", () => {
    const blind = (n: number, missed: number) => watch({ _id: `w${n}`, short_id: `mw-${n}`, name: `Watch ${n}`, threshold: 10, last_error: "no answer", missed, query_kind: "reader", query: "metrics.read" });
    // Five watches read through metrics.read; four are blind, the fifth is past its line and pages on its own.
    const alerting = watch({ _id: "w5", short_id: "mw-5", state: "alert", threshold: 10, last_value: 20, direction: "above", last_error: "no answer" });
    const watches = [blind(1, 2), blind(2, 9), blind(3, 4), blind(4, 3), alerting];
    const reader = { kind: "read" as const, name: "metrics.read", reason: "HTTP 502", count: 96, since: NOW - 7 * H };
    const starves = { reader, watchIds: watches.map((w) => w._id) };
    const items = rawItems({ sources: [source({ provider: "app", name: "union" })], groups: [], watches, replays: [] }, NOW, withHealth({ state: "degraded", tone: "warn", label: "Reader failing", level: "degraded", fix: "calls", starves }));
    expect(items.map((i) => [i.key, i.state])).toEqual([["watch:w5", "alerting"], ["reader:s1:metrics.read", "reader"]]);
    const row = items[1];
    if (row.kind !== "reader") throw new Error("expected the reader row");
    // The blind watches ride the one row, the most missed reads first; it went wrong when the reader started failing.
    expect(row.watches.map((w) => w.short_id)).toEqual(["mw-2", "mw-3", "mw-4", "mw-1"]);
    expect(row.at).toBe(NOW - 7 * H);
    expect(row.severity).toBe(2);
    // One row under Reader failing, never Watch errors or Degraded; it pages nobody.
    const counts = attentionCounts(items);
    expect([counts.reader, counts.erroring, counts.degraded]).toEqual([1, 0, 0]);
    expect(counts.unassigned).toBe(1);
    expect(opsBadge(items).n).toBe(1);
    // A watch whose own query fails (not the reader) stays its own row beside it.
    const own = watch({ _id: "w9", short_id: "mw-9", last_error: "timeout", missed: 3 });
    const mixed = rawItems({ sources: [source({ provider: "app" })], groups: [], watches: [...watches, own], replays: [] }, NOW, withHealth({ state: "degraded", tone: "warn", label: "Reader failing", level: "degraded", fix: "calls", starves }));
    expect(mixed.filter((i) => i.state === "erroring" || i.state === "reader").map((i) => [i.key, i.state])).toEqual([["reader:s1:metrics.read", "reader"], ["watch-error:w9", "erroring"]]);
    // A reader failing while every watch it feeds read fine last time is still the reader's one row, so the strip holds from load to load.
    const fed = watch({ _id: "w7", short_id: "mw-7", query_kind: "reader", query: "metrics.read" });
    const loose = rawItems({ sources: [source({ provider: "app" })], groups: [], watches: [fed], replays: [] }, NOW, withHealth({ state: "degraded", tone: "warn", label: "Reader failing", level: "degraded", fix: "calls", since: NOW - 7 * H, starves: { reader, watchIds: [], feeds: ["w7"] } }));
    expect(loose.map((i) => [i.state, i.at])).toEqual([["reader", NOW - 7 * H]]);
    const quiet = loose[0];
    if (quiet.kind !== "reader") throw new Error("expected the reader row");
    expect([quiet.blind, quiet.watches.map((w) => w._id)]).toEqual([0, ["w7"]]);
  });
});

test("a row is new only when it went wrong after the last visit, and nothing is new on a first visit", async () => {
  const { isNewSince } = await import("./opsHomeModel");
  expect(isNewSince({ at: NOW }, NOW - H)).toBe(true);
  expect(isNewSince({ at: NOW - 2 * H }, NOW - H)).toBe(false);
  expect(isNewSince({ at: NOW }, null)).toBe(false);
});

test("the home and the Issues list read one classifier: each issue tile counts exactly its lane", async () => {
  const { issueLane } = await import("./issuesModel");
  const groups = [
    group({ _id: "a", first_seen: NOW - 2 * H }),
    // Regressed four days ago: past the old 24h home window, still in the 7-day Regressed lane.
    group({ _id: "b", first_seen: NOW - 9 * 24 * H, regressed_at: NOW - 4 * 24 * H }),
    group({ _id: "c", first_seen: NOW - 3 * 24 * H, buckets: buckets(1, 40, 90) }),
    group({ _id: "d", first_seen: NOW - 9 * 24 * H }),
    group({ _id: "e", status: "ignored", first_seen: NOW - 2 * H }),
  ];
  const counts = attentionCounts(attentionItems({ sources: [], groups, watches: [], replays: [] }, NOW));
  const lanes = groups.map((g) => issueLane(g, NOW));
  expect(counts.regressed).toBe(lanes.filter((l) => l === "regressed").length);
  expect(counts.escalating).toBe(lanes.filter((l) => l === "escalating").length);
  expect(counts.new).toBe(lanes.filter((l) => l === "new").length);
  expect([counts.regressed, counts.escalating, counts.new]).toEqual([1, 1, 1]);
});

test("an alerting watch whose issue regressed counts under Regressed too, so the tile equals its lane and the badge sums the tiles", () => {
  const g = group({ _id: "g9", short_id: "eg-9", kind: "metric", first_seen: NOW - 9 * 24 * H, regressed_at: NOW - 2 * H });
  const items = attentionItems({ sources: [], groups: [g], watches: [watch({ state: "alert", group_id: "g9" })], replays: [] }, NOW);
  expect(items.map((i) => [i.key, i.state, i.also])).toEqual([["watch:w1", "alerting", ["regressed"]]]);
  const counts = attentionCounts(items);
  expect([counts.alerting, counts.regressed]).toEqual([1, 1]);
  expect(items.filter((i) => admitsShow(i, "regressed")).length).toBe(1);
  expect(opsBadge(items)).toEqual({ n: 2, words: "1 alerting · 1 regressed" });
});

test("Started is when an item went wrong, not its latest event, so an ongoing spike is new once", async () => {
  const { isNewSince, spikeStart } = await import("./opsHomeModel");
  // Quiet for days, then hot for the last three hours: it started three hours ago however recent its last event.
  const hot = group({ _id: "h", first_seen: NOW - 9 * 24 * H, last_seen: NOW, buckets: [...Array.from({ length: 6 }, (_, d) => ({ hour: NOW - (d + 2) * 24 * H, count: 5 })), ...[2, 1, 0].map((h) => ({ hour: NOW - h * H, count: 60 }))] });
  const [item] = attentionItems({ sources: [], groups: [hot], watches: [], replays: [] }, NOW);
  expect(item.state).toBe("escalating");
  expect(item.at).toBe(spikeStart(hot, NOW));
  expect(item.at).toBeLessThan(NOW - 2 * H + 1);
  expect(isNewSince(item, NOW - H)).toBe(false);
});

test("the filters that page a person lead the strip as one group, so the Overview tab's count is the sum of its first tiles", () => {
  const paging = ATTENTION_FILTERS.filter((f) => f.tone === "bad").map((f) => f.key);
  expect(ATTENTION_FILTERS.slice(0, paging.length).map((f) => f.key)).toEqual(paging);
  // Every red tile counts a state the badge counts: alerting, regressed, escalating, sources down.
  expect(paging.map((k) => (k === "sources" ? "source" : k)).every((k) => BADGE_STATES.has(k as any))).toBe(true);
  expect(paging.length).toBe(BADGE_STATES.size);
});

test("a count of one reads singular", () => {
  const f = (k: string) => ATTENTION_FILTERS.find((x) => x.key === k)!;
  expect(filterWords(f("sources"), 1)).toBe("Source down");
  expect(filterWords(f("sources"), 2)).toBe("Sources down");
  expect(filterWords(f("new"), 1)).toBe("New issue");
  expect(filterWords(f("regressed"), 1)).toBe("Regressed");
});

describe("round 4: words and counts that agree across surfaces", () => {
  test("a filter's label agrees with its number: one replay error, two replay errors", () => {
    const f = ATTENTION_FILTERS.find((x) => x.key === "errors")!;
    expect(filterWords(f, 1)).toBe("Replay error");
    expect(filterWords(f, 2)).toBe("Replay errors");
  });

  test("a watch whose last read failed folds behind the band's Retrying count: never a tile of its own, never with the healthy ones", async () => {
    const { watchBand, watchRetrying } = await import("./opsHomeModel");
    const once = watch({ _id: "once", threshold: undefined, last_error: "timed out", missed: 1, last_value: 5 });
    const twice = watch({ _id: "twice", threshold: 10, last_error: "timed out", missed: 2 });
    const fine = watch({ _id: "fine", threshold: undefined });
    expect([once, twice, fine].map(watchRetrying)).toEqual([true, false, false]);
    expect(watchRetrying({ ...once, status: "paused" })).toBe(false);
    const band = watchBand([once, twice, fine]);
    expect(band.retrying.map((w) => w._id)).toEqual(["once"]);
    expect(band.healthy.map((w) => w._id)).toEqual(["fine"]);
    expect(band.attention.map((w) => w._id)).toEqual(["twice"]);
  });

  test("a replay row's counts are floors when the feed came back full and its oldest replay is inside the day", () => {
    const many = Array.from({ length: 3 }, (_, i) => replay({ _id: `r${i}`, started_at: NOW - (i + 1) * H, counts: { clicks: 0, errors: 1, failed_requests: 400 } }));
    const full = rawItems({ sources: [source()], groups: [], watches: [], replays: many, replaysCapped: true }, NOW, reading);
    expect(full.find((i) => i.kind === "replay")).toMatchObject({ partial: true });
    const whole = rawItems({ sources: [source()], groups: [], watches: [], replays: [...many, replay({ _id: "old", started_at: NOW - 2 * 24 * H })], replaysCapped: true }, NOW, reading);
    expect(whole.find((i) => i.kind === "replay")).not.toHaveProperty("partial");
  });
});

describe("one row per root cause", () => {
  const budget = (id: string, provider: string, job: string, over: Partial<OpsGroup> = {}) => group({
    _id: id, short_id: `eg-${id}`, last_release: "4a6e4134e", first_seen: NOW - 9 * 24 * H, regressed_at: NOW - 3 * H,
    title: `budget context missing: ${provider}/contacts:read-email-only-ask (job=${job}, span=${job}) — wrap the origin in withBudget(...)`, ...over,
  });

  test("issues one parameter apart in the same source and release fold into one row, counted once by its tile and the badge", () => {
    const groups = [budget("618", "openrouter", "none", { count: 400 }), budget("616", "anthropic", "none"), budget("148", "openrouter", "reconcile-linq-events"), budget("149", "bedrock", "reconcile")];
    const items = attentionItems({ sources: [source()], groups, watches: [], replays: [] }, NOW);
    expect(items).toHaveLength(1);
    const it = items[0] as Extract<(typeof items)[number], { kind: "issue" }>;
    expect(it.group._id).toBe("618");
    expect(it.variants?.map((g) => g._id)).toEqual(["618", "616", "149", "148"]);
    expect(attentionCounts(items).regressed).toBe(1);
    expect(opsBadge(items).n).toBe(1);
    expect(homeIssueRefs(items)).toEqual(["eg-618"]);
    expect(foldedTitle(it.variants!.map((g) => g.title))).toBe("budget context missing: … — wrap the origin in withBudget(...)");
  });

  test("another release, another source or a different message stays its own row", () => {
    const groups = [
      budget("1", "openrouter", "none"),
      budget("2", "anthropic", "none", { last_release: "0fab82d62" }),
      budget("3", "bedrock", "none", { source_id: "s2" }),
      group({ _id: "4", short_id: "eg-4", first_seen: NOW - 9 * 24 * H, regressed_at: NOW - 3 * H, last_release: "4a6e4134e", title: "Cannot reach the database: connection refused after 3 tries" }),
    ];
    const items = attentionItems({ sources: [source(), source({ _id: "s2", name: "api" })], groups, watches: [], replays: [] }, NOW);
    expect(items.filter((i) => i.kind === "issue")).toHaveLength(4);
  });

  test("a title's parameters are blanked before comparing: key=value lists, ids and numbers", () => {
    expect(titleShape("timeout after 3000ms (job=a, span=b) on 9f8e7d6c5b4a3f2e")).toEqual(["timeout", "after", "#ms", "(…)", "on", "#"]);
  });
});
