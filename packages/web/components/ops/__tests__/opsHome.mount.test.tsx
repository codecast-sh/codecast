// The Ops home, mounted: with no source it is the connect step and nothing
// reads healthy; with sources it leads with what is wrong, worst first, each
// count a filter; with nothing wrong it is one quiet line, and every source's
// health sits under it.
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/ops" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { OpsHomeView } = await import("../OpsHome");
const { sourceActivity, sourceHealth } = await import("../sourceHealth");
const { attentionItems, itemsForSource, opsBadge } = await import("../opsHomeModel");
type Data = Parameters<typeof OpsHomeView>[0]["data"];

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const NOW = Date.UTC(2026, 10, 3, 12);
const H = 3600_000;
const READY = { ready: true, error: undefined, refused: false, retry: () => {} } as any;

const source = (over: Record<string, unknown> = {}) => ({
  _id: "s1", short_id: "src-1", workspace: "team:t", owner_user_id: "u", provider: "sdk", name: "web", keyed: true,
  promote: [], status: "active", last_event_at: NOW - 60_000, events_today: 40, groups_open: 2, created_at: NOW - 30 * 24 * H, updated_at: NOW, ...over,
}) as any;
const group = (over: Record<string, unknown> = {}) => ({
  _id: "g1", workspace: "team:t", source_id: "s1", short_id: "eg-1", kind: "error", fingerprint: "f", title: "TypeError: x is undefined",
  status: "open", first_seen: NOW - 2 * H, last_seen: NOW - H, count: 3, buckets: [], updated_at: NOW, ...over,
}) as any;
const watch = (over: Record<string, unknown> = {}) => ({
  _id: "w1", workspace: "team:t", source_id: "s1", short_id: "mw-1", name: "Signups", query_kind: "series", query: "q", threshold: 10,
  direction: "below", interval_ms: 300_000, status: "active", points: [], state: "ok", last_value: 4, last_at: NOW,
  source_name: "web", source_short_id: "src-1", updated_at: NOW, ...over,
}) as any;

/** The one health reading (sourceHealth.ts), as the shell computes it. */
function healthOf(data: Data) {
  const trail = { groups: data.groups, replays: data.replays, watches: data.watches };
  return new Map(data.sources.map((s: any) => [s._id, sourceHealth(s, sourceActivity(s, trail, NOW), { now: NOW, watches: data.watches })]));
}

async function mount(data: Data, show: any = null, snoozes?: any, sourceRef: string | null = null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter><OpsHomeView data={data} sourcesFeed={READY} now={NOW} source={sourceRef} show={show} health={healthOf(data)} snoozes={snoozes} /></MemoryRouter>);
  });
  return { container, done: () => { root.unmount(); container.remove(); } };
}

const empty: Data = { sources: [], groups: [], watches: [], replays: [] };

test("with no source it is the connect step, with a tile per kind and nothing green", async () => {
  const { container, done } = await mount(empty);
  expect(container.querySelector("[data-ops-first-run]")).not.toBeNull();
  expect([...container.querySelectorAll("[data-ops-connect]")].map((t) => t.getAttribute("data-ops-connect"))).toEqual(["posthog", "sentry", "app", "github", "sdk"]);
  expect(container.querySelector('[data-ops-connect="github"]')!.getAttribute("href")).toBe("/settings/integrations#app-github");
  expect(container.querySelector("[data-ops-clear]")).toBeNull();
  done();
});

test("what is wrong leads, worst first, and each count is a filter", async () => {
  const { container, done } = await mount({ ...empty, sources: [source()], groups: [group()], watches: [watch({ state: "alert" })] });
  const refs = [...container.querySelectorAll("[data-ops-item]")].map((r) => r.getAttribute("data-ops-item"));
  expect(refs).toEqual(["mw-1", "eg-1"]);
  const count = (k: string) => container.querySelector(`[data-ops-count="${k}"]`)!;
  expect(count("alerting").textContent).toBe("1Alerting");
  expect(count("alerting").getAttribute("href")).toBe("/ops?show=alerting");
  // A paging tile that holds nothing is not drawn; a calmer one that holds nothing is a count, never a link to an empty list.
  expect(container.querySelector('[data-ops-count="regressed"]')).toBeNull();
  expect(count("firing").getAttribute("data-tone")).toBe("zero");
  expect(count("firing").getAttribute("href")).toBeNull();
  done();
});

test("a filter narrows the list and its count links back to everything", async () => {
  const { container, done } = await mount({ ...empty, sources: [source()], groups: [group()], watches: [watch({ state: "alert" })] }, "new");
  expect([...container.querySelectorAll("[data-ops-item]")].map((r) => r.getAttribute("data-ops-item"))).toEqual(["eg-1"]);
  expect(container.querySelector('[data-ops-count="new"]')!.getAttribute("href")).toBe("/ops");
  done();
});

test("nothing wrong is one quiet line, and a source down is listed with its fix", async () => {
  const clear = await mount({ ...empty, sources: [source()] });
  expect(clear.container.querySelector("[data-ops-clear]")!.textContent).toContain("All clear");
  expect(clear.container.querySelector('[data-ops-source-row="web"]')).not.toBeNull();
  clear.done();
  const down = await mount({ ...empty, sources: [source({ status: "error", last_error: "401 from Sentry" })] });
  const row = down.container.querySelector('[data-ops-item="src-1"]')!;
  expect(row.textContent).toContain("401 from Sentry");
  // A 401 is a lost connection: the row's one act is the fix its health names.
  expect(row.querySelector('[data-ops-fix="reconnect"]')).not.toBeNull();
  down.done();
});

test("the source table's 24h is the sum of its groups' occurrences in the window and its replays, never the door's day counter", async () => {
  const groups = [
    group({ count: 2000, first_seen: NOW - 20 * H, last_seen: NOW - 2 * 60_000, buckets: [{ hour: NOW - H, count: 74 }, { hour: NOW - 6 * H, count: 300 }, { hour: NOW - 40 * H, count: 900 }] }),
    group({ _id: "g2", short_id: "eg-2", status: "resolved", first_seen: NOW - 30 * H, buckets: [{ hour: NOW - 2 * H, count: 6 }] }),
  ];
  const replays = [{ _id: "r1", short_id: "rp-1", workspace: "team:t", source_id: "s1", source_name: "web", provider: "posthog", external_id: "x", url: null, user: null, started_at: NOW - 3 * H, duration_ms: 1000, counts: { clicks: 1, errors: 0, failed_requests: 0 }, group_ids: [], chunks: 1, has_timeline: false, imported_at: NOW, updated_at: NOW }] as any;
  const { container, done } = await mount({ ...empty, sources: [source({ last_event_at: undefined, events_today: 1 })], groups, replays });
  const row = container.querySelector('[data-ops-source-row="web"]')!;
  expect(row.querySelector('[data-col="state"]')!.textContent).toContain("Flowing");
  expect(row.querySelector("[data-ops-24h]")!.textContent).toBe(String(74 + 300 + 6 + 1));
  // Open is the Issues tab's own count of the source's open groups, not the server's counter (groups_open: 2).
  const cells = [...row.querySelectorAll("td")].map((td) => td.textContent);
  expect(cells[4]).toBe("1");
  expect(container.querySelector("thead")!.textContent).toContain("24h");
  done();
});

test("facts lead with the number that says how bad, and Events and Users sit in their own columns", async () => {
  const g = group({ count: 1893, users: 41, culprit: "app/routes/checkout.tsx in submit", last_release: "v2.4.1" });
  const { container, done } = await mount({ ...empty, sources: [source()], groups: [g] });
  const row = container.querySelector('[data-ops-item="eg-1"]')!;
  const facts = [...row.querySelectorAll(".ops-home-fact")].map((f) => [f.textContent, f.getAttribute("data-rank")]);
  expect(facts[0]).toEqual(["1,893 events", "1"]);
  expect(facts.find((f) => f[0]?.includes("checkout"))?.[1]).toBe("3");
  expect(row.querySelector('[data-col="events"]')!.textContent).toBe("1,893");
  expect(row.querySelector('[data-col="users"]')!.textContent).toBe("41");
  // Every row carries the same three action slots, so they line up.
  expect([...row.querySelectorAll(".ops-home-slot")].map((s) => s.getAttribute("data-slot"))).toEqual(["task", "primary", "more"]);
  done();
});

test("a snoozed item leaves the list and its counts, and the Snoozed filter lists it with Wake", async () => {
  const data = { ...empty, sources: [source()], groups: [group()] };
  const snoozes = { "issue:g1": { until: NOW + H, state: "new", volume: 3, at: NOW } };
  const live = await mount(data, null, snoozes);
  expect(live.container.querySelector('[data-ops-item="eg-1"]')).toBeNull();
  expect(live.container.querySelector('[data-ops-count="new"] b')!.textContent).toBe("0");
  expect(live.container.querySelector('[data-ops-count="snoozed"] b')!.textContent).toBe("1");
  live.done();
  const list = await mount(data, "snoozed", snoozes);
  const row = list.container.querySelector('[data-ops-item="eg-1"]')!;
  expect(row.querySelector("[data-ops-wake]")).not.toBeNull();
  expect(row.textContent).toContain("back in 1h");
  list.done();
});

test("a linked task shows as its id, status and owner, and an open unassigned task says so and starts a fix, never continues one", async () => {
  const data = { ...empty, sources: [source()], groups: [group({ signal_task_id: "t1" })], taskOf: () => ({ short_id: "ct-9", status: "open", assignee: null }) };
  const { container, done } = await mount(data);
  const row = container.querySelector('[data-ops-item="eg-1"]')!;
  const chip = row.querySelector("[data-ops-task]")!;
  // Nobody on it leaves the face's slot empty (the Nobody on it tile counts it once); the tooltip still says so.
  expect(chip.textContent).toBe("ct-9");
  expect(chip.querySelector(".ops-home-task-none")).not.toBeNull();
  expect(chip.getAttribute("title")).toContain("nobody on it");
  expect(chip.textContent).not.toContain("TypeError");
  expect(row.textContent).toContain("Start fix");
  expect(row.textContent).not.toContain("Continue fix");
  expect(container.querySelector('[data-ops-count="unassigned"] b')!.textContent).toBe("1");
  done();
});

const key = (k: string, opts: KeyboardEventInit = {}) => act(async () => {
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
});

test("j and k move a cursor down the list, x selects (shift for a range), and a selection swaps the head for its bulk acts", async () => {
  const groups = [group(), group({ _id: "g2", short_id: "eg-2" }), group({ _id: "g3", short_id: "eg-3" })];
  const { container, done } = await mount({ ...empty, sources: [source()], groups });
  const cursor = () => container.querySelector('.ops-home-row[data-cursor="true"]')?.getAttribute("data-ops-item") ?? null;
  expect(cursor()).toBeNull();
  await key("j");
  expect(cursor()).toBe("eg-1");
  await key("j");
  await key("j");
  await key("j");
  expect(cursor()).toBe("eg-3");
  await key("k");
  expect(cursor()).toBe("eg-2");
  await key("x");
  expect(container.querySelector("[data-ops-bulk]")!.getAttribute("data-ops-bulk")).toBe("1");
  expect(container.querySelector(".ops-home-head")).toBeNull();
  await key("j");
  await key("x", { shiftKey: true });
  expect([...container.querySelectorAll('.ops-home-row[data-selected="true"]')].map((r) => r.getAttribute("data-ops-item"))).toEqual(["eg-2", "eg-3"]);
  expect(container.querySelector("[data-ops-bulk-resolve]")!.textContent).toContain("Resolve 2");
  // The bulk acts name their keys as key caps.
  expect(container.querySelector("[data-ops-bulk-resolve] kbd")!.textContent).toBe("e");
  await key("Escape");
  expect(container.querySelector("[data-ops-bulk]")).toBeNull();
  done();
});

test("a watch that cannot read is a watch error row with Retry, its source stays off the list, and its tile appears", async () => {
  const blind = watch({ last_error: "no answer in 15s", missed: 3 });
  const { container, done } = await mount({ ...empty, sources: [source()], watches: [blind] });
  const row = container.querySelector('[data-ops-item="mw-1"]')!;
  expect(row.getAttribute("data-state")).toBe("erroring");
  expect(row.textContent).toContain("no answer in 15s");
  expect(row.querySelector("[data-ops-retry]")).not.toBeNull();
  expect(container.querySelector('[data-ops-item="src-1"]')).toBeNull();
  expect(container.querySelector('[data-ops-count="erroring"]')!.textContent).toBe("1Watch error");
  expect(container.querySelector('[data-ops-count="sources"]')).toBeNull();
  done();
});

test("replays hitting one issue are one row that names its source, its replays and its people, and opens on the issue", async () => {
  const old = group({ _id: "g9", short_id: "eg-9", title: "GET /api/users/:id answers 403", first_seen: NOW - 9 * 24 * H });
  const rp = (id: string, user: string) => ({ _id: id, short_id: `rp-${id}`, workspace: "team:t", source_id: "s1", source_name: "web", provider: "posthog", external_id: id, url: null, user: { id: user }, started_at: NOW - H, duration_ms: 1000, counts: { clicks: 1, errors: 2, failed_requests: 0 }, group_ids: ["g9"], chunks: 1, has_timeline: false, imported_at: NOW, updated_at: NOW }) as any;
  const { container, done } = await mount({ ...empty, sources: [source()], groups: [old], replays: [rp("1", "ada"), rp("2", "bo"), rp("3", "ada")] });
  const rows = container.querySelectorAll('[data-state="errors"].ops-home-row');
  expect(rows.length).toBe(1);
  const row = rows[0];
  expect(row.getAttribute("data-ops-item")).toBe("eg-9");
  expect(row.textContent).toContain("3 replays in 24h, 2 people");
  expect(row.querySelector('[data-ops-src="web"]')).not.toBeNull();
  expect(row.querySelector(".ops-home-title")!.getAttribute("href")).toBe("/ops/issues/eg-9");
  done();
});

test("rows that went wrong after the last visit are marked, and the head counts them", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const data = { ...empty, sources: [source()], groups: [group(), group({ _id: "g2", short_id: "eg-2", first_seen: NOW - 10 * H })] };
  await act(async () => {
    root.render(<MemoryRouter><OpsHomeView data={data} sourcesFeed={READY} now={NOW} source={null} show={null} health={healthOf(data)} seenAt={NOW - 5 * H} /></MemoryRouter>);
  });
  expect([...container.querySelectorAll("[data-ops-new]")].map((d) => d.closest("[data-ops-item]")!.getAttribute("data-ops-item"))).toEqual(["eg-1"]);
  expect(container.querySelector("[data-ops-new-count]")!.textContent).toBe("1 new");
  root.unmount();
  container.remove();
});

test("the band leaves out the watches the list already shows, its alerting count filters the list, and the OK count opens the healthy ones", async () => {
  const warn = watch({ _id: "w3", short_id: "mw-3", name: "Close", threshold: 10, last_value: 10.5 });
  const { container, done } = await mount({ ...empty, sources: [source()], watches: [watch({ state: "alert" }), watch({ _id: "w2", short_id: "mw-2", name: "Calm", last_value: 50 }), warn] });
  const tiles = () => [...container.querySelectorAll("[data-ops-band-watch]")].map((t) => t.getAttribute("data-ops-band-watch"));
  // mw-1 is alerting, so it is a row of the list; the band does not draw it a second time.
  expect(container.querySelector('[data-ops-item="mw-1"]')).not.toBeNull();
  expect(tiles()).not.toContain("mw-1");
  const alert = container.querySelector('[data-ops-band-count="alert"]')!;
  expect(alert.querySelector("b")!.textContent).toBe("1");
  expect(alert.getAttribute("href")).toBe("/ops?show=alerting");
  const ok = container.querySelector<HTMLButtonElement>("[data-ops-band-ok]")!;
  expect(ok.getAttribute("aria-expanded")).toBe("false");
  await act(async () => ok.click());
  expect(tiles()).toContain("mw-2");
  expect(tiles()).not.toContain("mw-1");
  expect(ok.getAttribute("aria-expanded")).toBe("true");
  done();
});

test("an app with a failing reader and a failing check is one row naming both, whose act is Start fix, with Open app beside it", async () => {
  const fed = watch({ query_kind: "reader", query: 'metrics.read {"key":"x"}', state: "ok" });
  const data = { ...empty, sources: [source({ provider: "app", name: "union", watch_state: [{ key: "check:invariants", polled_at: NOW, last_error: "the response is over 256 KB" }] })], watches: [fed] };
  const failures = [{ kind: "read" as const, name: "metrics.read", reason: "Timed out", reasons: [{ reason: "Timed out", count: 98 }], count: 98, since: NOW - 5 * H }];
  const trail = { groups: [], replays: [], watches: data.watches };
  const s = data.sources[0];
  const health = new Map([["s1", sourceHealth(s, sourceActivity(s, trail, NOW), { now: NOW, watches: data.watches, appFailures: failures, checkName: () => "Invariants" })]]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter><OpsHomeView data={data} sourcesFeed={READY} now={NOW} source={null} show={null} health={health} /></MemoryRouter>);
  });
  const row = container.querySelector('[data-ops-item="src-1"]')!;
  expect(row.querySelector(".ops-home-title")!.textContent).toBe("union: Invariants check failing · 1 call failing");
  const facts = row.querySelector(".ops-home-line2")!.textContent!;
  expect(facts).toContain("metrics.read times out, 98× in the last 5h");
  expect(facts).toContain("Invariants: the response is over 256 KB");
  expect(row.querySelector("[data-ops-source-fix]")!.textContent).toBe("Start fix");
  // The band leaves out the states no watch is in.
  expect([...container.querySelectorAll("[data-ops-band-count]")].map((n) => n.getAttribute("data-ops-band-count"))).toEqual(["ok"]);
  await act(async () => root.unmount());
  container.remove();
});

test("one failing reader is one row naming its blind watches, its fix once, and its source is not listed again", async () => {
  const blind = (n: number) => watch({ _id: `w${n}`, short_id: `mw-${n}`, name: `Watch ${n}`, last_error: "no answer", missed: 3, query_kind: "reader", query: "metrics.read" });
  const watches = [blind(1), blind(2), blind(3), blind(4)];
  const data = { ...empty, sources: [source({ provider: "app", name: "union" })], watches };
  const reader = { kind: "read" as const, name: "metrics.read", reason: "HTTP 502", count: 96, since: NOW - 7 * H };
  const base = healthOf(data).get("s1")!;
  const health = new Map([["s1", { ...base, state: "degraded", tone: "warn", label: "Reader failing", level: "degraded", fix: "calls", reason: "metrics.read fails", starves: { reader, watchIds: watches.map((w: any) => w._id) } } as any]]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<MemoryRouter><OpsHomeView data={data} sourcesFeed={READY} now={NOW} source={null} show={null} health={health} /></MemoryRouter>);
  });
  const rows = [...container.querySelectorAll(".ops-home-row")];
  expect(rows.map((r) => r.getAttribute("data-ops-item"))).toEqual(["src-1"]);
  const row = rows[0];
  expect(row.querySelector(".ops-home-title")!.textContent).toBe("union metrics.read failing");
  expect(row.textContent).toContain("4 watches blind");
  // The reason leads the line, the blind count follows it; one row under Reader failing, never Watch errors.
  expect(row.querySelector(".ops-home-line2")!.textContent).toBe("reader failingmetrics.read returns HTTP 502, 96× in the last 7h4 watches blind");
  expect(container.querySelector('[data-ops-count="reader"]')!.textContent).toBe("1Reader failing");
  expect(container.querySelector('[data-ops-count="erroring"]')).toBeNull();
  expect(row.querySelector("[data-ops-started]")!.getAttribute("title")).toContain("Failing since");
  expect(container.querySelector('[data-ops-count="degraded"]')).toBeNull();
  // A watch row has no events and no people: its cells are blank, not a column of dashes.
  expect(row.querySelector('[data-col="events"]')!.textContent).toBe("");
  // The count opens the blind watches under the row, each to its own page.
  expect(row.querySelector("[data-ops-blind-list]")).toBeNull();
  await act(async () => row.querySelector<HTMLButtonElement>("[data-ops-blind]")!.click());
  expect([...row.querySelectorAll("[data-ops-blind-watch]")].map((a) => a.getAttribute("href"))).toEqual(["/ops/metrics/mw-1", "/ops/metrics/mw-2", "/ops/metrics/mw-3", "/ops/metrics/mw-4"]);
  // The band draws none of them again: they are on the list. Its summary counts them as Blind, opening the reader's row, never as Erroring.
  expect(container.querySelector("[data-ops-band-watch]")).toBeNull();
  expect(container.querySelector('[data-ops-band-count="reader"]')!.textContent).toBe("4Blind");
  expect(container.querySelector('[data-ops-band-count="reader"]')!.getAttribute("href")).toBe("/ops?show=reader");
  expect(container.querySelector('[data-ops-band-count="error"]')).toBeNull();
  await act(async () => root.unmount());
  container.remove();
});

test("a filter on shows as a token beside the count that clears it, and the empty filter offers the same token", async () => {
  const { container, done } = await mount({ ...empty, sources: [source()], groups: [group()] }, "new");
  const token = container.querySelector(".ops-home-head [data-ops-filter-token]")!;
  // The token wears its tile's own words and number.
  expect(token.textContent).toContain("New issue");
  expect(token.getAttribute("href")).toBe("/ops");
  expect(container.querySelector('[data-ops-count="new"]')!.getAttribute("data-on")).toBe("true");
  done();
  const none = await mount({ ...empty, sources: [source()] }, "regressed");
  expect(none.container.querySelector("[data-ops-clear] [data-ops-filter-token]")!.getAttribute("href")).toBe("/ops");
  none.done();
});

test("a band with every watch fine is its count line alone", async () => {
  const { container, done } = await mount({ ...empty, sources: [source()], watches: [watch({ _id: "w2", short_id: "mw-2", name: "Calm", last_value: 50 })] });
  expect(container.querySelector("[data-ops-band]")).not.toBeNull();
  expect(container.querySelector("[data-ops-band-watch]")).toBeNull();
  done();
});

test("the Events column counts events on every row and Users draws a dash when nobody is known", async () => {
  const old = group({ _id: "g9", short_id: "eg-9", first_seen: NOW - 9 * 24 * H, count: 40 });
  const rp = { _id: "r1", short_id: "rp-1", workspace: "team:t", source_id: "s1", source_name: "web", provider: "posthog", external_id: "r1", url: null, user: { id: "ada" }, started_at: NOW - H, duration_ms: 1000, counts: { clicks: 1, errors: 15, failed_requests: 0 }, group_ids: ["g9"], chunks: 1, has_timeline: false, imported_at: NOW, updated_at: NOW } as any;
  const { container, done } = await mount({ ...empty, sources: [source()], groups: [old, group()], replays: [rp] });
  const cell = (ref: string, col: string) => container.querySelector(`[data-ops-item="${ref}"] [data-col="${col}"]`)!.textContent;
  expect(cell("eg-9", "events")).toBe("40");
  expect(cell("eg-1", "events")).toBe("3");
  expect(cell("eg-1", "users")).toBe("–");
  done();
});

test("inside one source the list leads with its new issues (the Open issues panel leaves them out), and a stopped source has no All clear line", async () => {
  const data = { ...empty, sources: [source()], groups: [group({ first_seen: NOW - H })] };
  const scoped = await mount(data, null, undefined, "web");
  expect(scoped.container.querySelector('[data-ops-item="eg-1"]')).not.toBeNull();
  expect(scoped.container.querySelector("[data-ops-clear]")).toBeNull();
  expect(scoped.container.querySelector('[data-ops-count="new"]')!.textContent).toContain("1");
  scoped.done();
  const tile = await mount(data, "new", undefined, "web");
  expect(tile.container.querySelector('[data-ops-item="eg-1"]')).not.toBeNull();
  tile.done();
  const stopped = await mount({ ...empty, sources: [source({ last_event_at: NOW - 18 * 24 * H, events_today: 0 })] }, null, undefined, "web");
  expect(stopped.container.textContent).not.toContain("All clear");
  stopped.done();
});

test("inside one source the list holds every item the Overview tab's badge counts, and the red tiles add up to it", async () => {
  const data = { ...empty, sources: [source({ status: "error", last_error: "boom" })], groups: [group()], watches: [watch({ state: "alert" })] };
  const health = healthOf(data);
  const badge = opsBadge(itemsForSource(attentionItems(data, NOW, (s) => health.get(s._id)), "s1")).n;
  const { container, done } = await mount(data, null, undefined, "web");
  const refs = [...container.querySelectorAll("[data-ops-item]")].map((r) => r.getAttribute("data-ops-item"));
  // The alerting watch pages a person and the new issue needs a look: both listed, under the header that already says the source is down.
  expect(refs).toContain("mw-1");
  expect(refs).not.toContain("src-1");
  expect(refs).toContain("eg-1");
  const paging = [...container.querySelectorAll('.ops-home-tilegroup[data-paging="true"] [data-ops-count]')].reduce((n, t) => n + Number(t.querySelector("b")!.textContent), 0);
  expect(paging).toBe(badge);
  expect(badge).toBeGreaterThan(0);
  done();
});
