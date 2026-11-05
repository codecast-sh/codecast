import { describe, expect, test } from "bun:test";
import { REPLAY_REST_NO_MORE, type ReplayEvent } from "@codecast/shared/contracts/replay";
import {
  failureReasons,
  restHold,
  restHoldText,
  stageProblemText,
  REST_STALL_MS,
  restDue,
  restState,
  importedUntil,
  compactCount,
  railRowAt,
  restLine,
  restQueued,
  restTrend,
  etaText,
  recordingLive,
  replayPagePath,
  shortBrowser,
  withRemoteAssets,
  playerImportedUntil,
  captureEndFrom,
  vendorUrlAt,
  isReplayFiltered,
  momentRef,
  onReplayClock,
  parseReplayQuery,
  peopleSortFor,
  previewAt,
  spanText,
  replayFixLedger,
  replayLengthText,
  replayQueryParams,
  totalText,
} from "./replayModel";
import {
  activityBins,
  describeEvent,
  selectorName,
  pagePathParts,
  eventHas,
  foldRail,
  netGrade,
  netPath,
  railRunKey,
  railAdmits,
  actionDetail,
  netParts,
  issueTitleParts,
  railCounts,
  allKindCounts,
  ALL_KINDS_HIDDEN_BY_DEFAULT,
  skipTarget,
  stepTo,
  isUserAction,
  endpointOf,
  issueMoments,
} from "./replayRail";
import { isFailure } from "@codecast/shared/replay";
import type { OpsReplay } from "./opsTypes";
import { importBar } from "./ReplayImport";

const q = (s: string) => {
  const p = new URLSearchParams(s);
  return parseReplayQuery((k) => p.get(k));
};

describe("the list's address", () => {
  test("reads back what it writes, and drops what it does not know", () => {
    const query = q("q=ada&has=errors,rage,bogus&dur=gt5m&date=7d&sort=longest&group=person");
    expect(query).toEqual({ q: "ada", person: undefined, has: ["errors", "rage"], dur: "gt5m", date: "7d", sort: "longest", group: "person", people_sort: undefined, identified: undefined });
    expect(replayQueryParams(query)).toEqual({ q: "ada", person: null, has: "errors,rage", dur: "gt5m", date: "7d", sort: "longest", group: "person", psort: null, ident: null, active: null, issue: null, browser: null, os: null, device: null, country: null });
    const env = q("browser=Chrome&country=US");
    expect(env).toMatchObject({ browser: "Chrome", country: "US" });
    expect(isReplayFiltered(env)).toBe(true);
    expect(replayQueryParams(env)).toMatchObject({ browser: "Chrome", country: "US", os: null });
    expect(replayQueryParams(q("group=person&psort=failures&ident=1"))).toMatchObject({ psort: "failures", ident: "1" });
    expect(q("psort=loudest").people_sort).toBeUndefined();
    expect(q("dur=forever&sort=random")).toMatchObject({ dur: undefined, sort: "newest" });
  });

  test("the active default and an issue round-trip; the default is not a filter", () => {
    expect(q("active=30s&issue=eg-12")).toMatchObject({ active: "30s", issue: "eg-12" });
    expect(replayQueryParams(q("active=5s"))).toMatchObject({ active: null });
    expect(replayQueryParams(q("active=any"))).toMatchObject({ active: "any" });
    expect(isReplayFiltered(q("active=5s"))).toBe(false);
    expect(isReplayFiltered(q("active=any"))).toBe(false);
    expect(isReplayFiltered(q("active=1m"))).toBe(true);
    expect(isReplayFiltered(q("issue=eg-12"))).toBe(true);
  });

  test("the defaults leave the address clean", () => {
    expect(replayQueryParams(q(""))).toEqual({ q: null, person: null, has: null, dur: null, date: null, sort: null, group: null, psort: null, ident: null, active: null, issue: null, browser: null, os: null, device: null, country: null });
    expect(isReplayFiltered(q("sort=oldest&group=person"))).toBe(false);
    expect(isReplayFiltered(q("has=failed"))).toBe(true);
  });
});

describe("the people fold", () => {
  test("sorts the most hit first when the list is narrowed to failures, else the most recent", () => {
    expect(peopleSortFor(q("group=person"))).toBe("recent");
    expect(peopleSortFor(q("group=person&has=failed"))).toBe("failures");
    expect(peopleSortFor(q("group=person&has=rage"))).toBe("recent");
    expect(peopleSortFor(q("group=person&has=errors&psort=time"))).toBe("time");
  });
});

describe("the replay clock", () => {
  // rp-5132: the stream's t counts from a stray rrweb event 40:49 before the first thing that happened.
  const raw: ReplayEvent[] = [
    { t: 2_449_300, type: "nav", url: "https://app.test/worker" },
    { t: 2_457_200, type: "click", label: "Open tips", selector: "button" },
    { t: 3_317_800, type: "network", method: "GET", url: "https://app.test/api/x", status: 502, ms: 20 },
  ];
  test("counts from the first event, the zero the player, the timeline and the row length share", () => {
    const on = onReplayClock(raw);
    expect(on.map((e) => e.t)).toEqual([0, 7_900, 868_500]);
    // The row's duration is last minus first (replays.summarize): the clock ends where the row says.
    const duration = raw[raw.length - 1].t - raw[0].t;
    expect(on[on.length - 1].t).toBe(duration);
    for (const e of on) expect(e.t).toBeLessThanOrEqual(duration);
  });
  test("leaves a stream that already starts at zero alone", () => {
    const zero = [{ ...raw[0], t: 0 }];
    expect(onReplayClock(zero)).toBe(zero);
    expect(onReplayClock([])).toEqual([]);
  });
});

describe("a length", () => {
  const base = { duration_ms: null, has_timeline: true, chunks: 1, provider: "sdk" as const, imported_at: null, converter_version: null, vendor_refresh_after: null };
  test("is the length, or says why there is none; never a question mark", () => {
    expect(replayLengthText({ ...base, duration_ms: 75_000 })).toEqual({ text: "1:15.0", known: true });
    expect(replayLengthText({ ...base, has_timeline: false })).toEqual({ text: "assembling", known: false });
    expect(replayLengthText({ ...base, provider: "posthog" as any, chunks: 0 })).toEqual({ text: "not imported", known: false });
    expect(replayLengthText(base)).toEqual({ text: "no length", known: false });
  });
});

describe("the event rail", () => {
  const events: ReplayEvent[] = [
    { t: 0, type: "nav", url: "https://shop.example.com/cart?id=", title: "Cart" },
    { t: 1, type: "click", label: "", selector: "[rrweb-id=9]" },
    { t: 2, type: "click", label: "", selector: "button.pay" },
    { t: 3, type: "network", method: "GET", url: "https://shop.example.com/api/a", status: 200, ms: 3_000 },
    { t: 4, type: "network", method: "GET", url: "https://shop.example.com/api/b", status: 0, ms: 12 },
    { t: 5, type: "console", level: "warn", message: "slow" },
    { t: 6, type: "view", outline: "Cart" },
  ];
  test("counts each kind; outlines are not events, and All leaves out requests that answered", () => {
    expect(railCounts(events)).toEqual({ all: 5, clicks: 2, nav: 1, console: 1, network: 2, errors: 0 });
  });
  test("All leaves out scrolls by default and the recorder's own console lines always; each kind toggles", () => {
    const noisy: ReplayEvent[] = [
      ...events,
      { t: 7, type: "scroll", y: 300, of: 1100 },
      { t: 8, type: "scroll", y: 900, of: 1700 },
      { t: 9, type: "console", level: "warn", message: "[SessionRecording] Too many mutations on node 12" },
      { t: 10, type: "console", level: "error", message: "[PostHog.js] rate limited" },
    ];
    expect(allKindCounts(noisy)).toEqual({ actions: 2, pages: 1, errors: 0, warnings: 1, requests: 1, marks: 0, scrolls: 2 });
    const hidden = new Set(ALL_KINDS_HIDDEN_BY_DEFAULT);
    expect(railCounts(noisy, hidden).all).toBe(5);
    expect(railCounts(noisy).all).toBe(7);
    expect(railCounts(noisy, new Set(["actions", "scrolls"] as const)).all).toBe(3);
    expect(railCounts(noisy).console).toBe(1);
    expect(isFailure(noisy[noisy.length - 1])).toBe(false);
  });
  test("a total of time reads in hours and minutes", () => {
    expect(spanText(462_423_000)).toBe("128h 27m");
    expect(spanText(725_000)).toBe("12m 5s");
    expect(spanText(40_400)).toBe("40s");
  });
  test("an icon-only click reads as its icon and place", () => {
    expect(describeEvent({ t: 0, type: "click", label: "", role: "button", selector: "button.p-1", context: "x icon in Release this call" })).toBe("button x icon in Release this call");
  });
  test("n/p and [/] step to the next and previous match, never the current one", () => {
    const at = events.map((e) => ({ ...e, t: e.t * 1000 }));
    expect(stepTo(at, 0, 1, (e) => isFailure(e))?.t).toBe(4000);
    expect(stepTo(at, 4000, 1, (e) => isFailure(e))).toBeNull();
    expect(stepTo(at, 4000, -1, isUserAction)?.t).toBe(2000);
    expect(stepTo(at, 0, -1, isUserAction)).toBeNull();
  });
  test("a hidden endpoint is its method and path", () => {
    expect(endpointOf(events[3] as Extract<ReplayEvent, { type: "network" }>)).toBe("GET /api/a");
  });
  test("a slow request is not a failed one", () => {
    expect(netGrade(events[3])).toBe("slow");
    expect(netGrade(events[4])).toBe("failed");
  });
  test("a click with no name reads as its selector in words, or as lost", () => {
    expect(describeEvent(events[1])).toBe("an element since removed");
    expect(describeEvent(events[2])).toBe("button pay");
    expect(describeEvent(events[0])).toBe("/cart?id= · Cart");
  });
  test("a selector names its element by test id, id, form name or a class that says what it is, else by the classes it has, never \"unlabeled\"", () => {
    expect(selectorName("button.flex-shrink-0.p-1", "button")).toBe("button .flex-shrink-0.p-1");
    expect(selectorName("button.flex-shrink-0.rounded-md")).toBe("button .flex-shrink-0.rounded-md");
    expect(selectorName("div.px-2.text-sm")).toBe("element .px-2.text-sm");
    expect(selectorName("button")).toBe("button");
    expect(selectorName('[data-testid="checkout-submit"]')).toBe("element checkout submit");
    expect(selectorName("input#searchBox")).toBe("input search box");
    expect(selectorName('select[name="country"]')).toBe("select country");
    expect(selectorName("a.nav-link.mt-2")).toBe("link nav link");
    expect(describeEvent({ t: 0, type: "click", label: "", role: "button", selector: "button.flex-shrink-0.w-8" })).toBe("button .flex-shrink-0.w-8");
    expect(describeEvent({ t: 0, type: "click", label: "Save", role: "button", selector: "button.x" })).toBe("button Save");
  });
  test("the filter reads urls and statuses too", () => {
    expect(eventHas(events[3], "api/a")).toBe(true);
    expect(eventHas(events[4], "api/a")).toBe(false);
  });
  test("activity counts what the person did", () => {
    const bins = activityBins(events, 10, 5);
    expect(bins[0]).toBe(1);
    expect(bins[3]).toBe(0);
  });
  test("a skip lands at the end of the idle range it is in", () => {
    const ranges = [{ from: 1_000, to: 9_000 }];
    expect(skipTarget(ranges, 500)).toBeNull();
    expect(skipTarget(ranges, 2_000)).toBe(9_000);
    expect(skipTarget(ranges, 8_990)).toBeNull();
  });
  test("a request reads as its path without the query keys that carry nothing", () => {
    expect(netPath("https://x.test/api/electric/shape/calls?cursor=&handle=&live=&params%5B1%5D=&where=")).toBe("/api/electric/shape/calls");
    expect(netPath("https://x.test/a?keep=1&drop=")).toBe("/a?keep=1");
    expect(describeEvent({ t: 0, type: "network", method: "GET", url: "https://x.test/s/calls?cursor=", status: 0, ms: 8_200 })).toBe("GET /s/calls");
  });
  test("a burst of the same failed request folds into one run; anything between breaks it", () => {
    const fail = (t: number, path = "/s/calls"): ReplayEvent => ({ t, type: "network", method: "GET", url: `https://x.test${path}?cursor=`, status: 0, ms: 8_000 });
    const rows = [fail(0), fail(10), fail(20, "/s/transcripts"), fail(30), fail(40), { t: 50, type: "click", label: "Go", selector: "b" } as ReplayEvent, fail(60), fail(9_000)].map((e, i) => [e, i] as const);
    const runs = foldRail(rows);
    expect(runs.map((r) => r.members.length)).toEqual([2, 1, 2, 1, 1, 1]);
    expect(runs[0].lead[1]).toBe(0);
    // A different status is a different row.
    expect(railRunKey({ ...fail(0), status: 502 } as ReplayEvent)).not.toBe(railRunKey(fail(0)));
    expect(railRunKey({ t: 0, type: "nav", url: "https://x.test/a" } as ReplayEvent)).toBeNull();
  });
  test("clicks on one element with the same text fold into one run; another target breaks it", () => {
    const click = (t: number, selector = "button.cta", text = "Great, Union will"): ReplayEvent => ({ t, type: "click", label: "", selector, text } as ReplayEvent);
    const rows = [click(0), click(700), click(1_400), click(2_000), click(2_600, "a.back", "Back"), click(3_000)].map((e, i) => [e, i] as const);
    expect(foldRail(rows).map((r) => r.members.length)).toEqual([4, 1, 1]);
  });
  test("a moment is a reference that plays in a message", () => {
    expect(momentRef("rp-12", 83_400)).toBe("rp-12@1:23");
  });
});

describe("the fix review", () => {
  const facts = { replay: "rp-5", path: "/checkout", failure: "TypeError", issues: ["eg-1"], project: "shop", task: null, running: 0, prompt: "a\nb\na", showPrompt: false, togglePrompt: () => {} };
  test("names what starts, where, and what it is recorded on", () => {
    const l = replayFixLedger(facts);
    expect(l.subject).toBe("rp-5 · /checkout");
    expect(l.alert).toBeUndefined();
    expect(l.rows.find((r) => r.k === "Recorded on")?.v).toBe("eg-1");
    expect(l.rows.find((r) => r.k === "Seeded with")?.list).toBeUndefined();
    expect(replayFixLedger({ ...facts, showPrompt: true }).rows.find((r) => r.k === "Seeded with")?.list).toEqual(["a", "b"]);
  });
  test("offers the folders it may start in when there is a choice, and flags a folder not from the source", () => {
    const one = replayFixLedger({ ...facts, folders: ["shop"], fromSource: false });
    expect(one.pick).toBeUndefined();
    expect(one.rows.find((r) => r.k === "Folder")?.tone).toBe("warn");
    const many = replayFixLedger({ ...facts, folders: ["shop", "union-mobile"], fromSource: true });
    expect(many.pick).toEqual({ k: "Folder", options: ["shop", "union-mobile"], value: "shop" });
    expect(many.rows.find((r) => r.k === "Folder")).toBeUndefined();
  });
  test("warns when a fix already runs, or when nothing records it", () => {
    expect(replayFixLedger({ ...facts, running: 1 }).alert).toBe("A fix is already running on its issue");
    expect(replayFixLedger({ ...facts, issues: [] }).rows.find((r) => r.k === "Recorded on")?.tone).toBe("warn");
  });
});

describe("the import bar", () => {
  test("splits what was listed into new, already here and failed", () => {
    expect(importBar({ listed: 10, imported: 5, skipped: 3, failed: 2 })).toEqual({ imported: 0.5, skipped: 0.3, failed: 0.2 });
    expect(importBar({ listed: 0, imported: 0, skipped: 0, failed: 0 })).toEqual({ imported: 0, skipped: 0, failed: 0 });
  });
});

describe("a total", () => {
  test("a capped zero says where it looked; a capped count says at least", () => {
    expect(totalText(0, true, 2000)).toBe("No recordings in the newest 2,000");
    expect(totalText(36, true, 2000)).toBe("36+ recordings");
    expect(totalText(1, false, 2000)).toBe("1 recording");
    // A floor reads as the tab badge reads it (floorShown): rounded down to the hundred.
    expect(totalText(1360, true, 2000, "person", "people")).toBe("1,300+ people");
    expect(totalText(1495, true, 2000)).toBe("1,400+ recordings");
  });
});

describe("issue moments", () => {
  test("a linked issue seeks to where it first happens in the recording", () => {
    const events: ReplayEvent[] = [
      { t: 0, type: "nav", url: "https://shop.example.com/cart" },
      { t: 7_900, type: "network", method: "POST", url: "https://shop.example.com/api/pay", status: 500, ms: 20 },
      { t: 9_000, type: "network", method: "POST", url: "https://shop.example.com/api/pay", status: 500, ms: 20 },
    ];
    const at = issueMoments(events, "https://shop.example.com/cart", [
      { _id: "g1", title: "nothing like it", fingerprint: "zz" },
      { _id: "g2", title: "unrelated" },
    ]);
    expect(at.size).toBe(0);
    const [issue] = (require("@codecast/shared/replay") as typeof import("@codecast/shared/replay")).replayIssues(events, "https://shop.example.com/cart", 0);
    const hit = issueMoments(events, "https://shop.example.com/cart", [{ _id: "g3", title: "x", fingerprint: `union:request:${issue.fp}` }]);
    expect(hit.get("g3")).toBe(7_900);
  });
});

describe("how far an imported copy reaches", () => {
  test("a copy well short of the recording stops where it ends; a near miss is two clocks, not a cut", () => {
    // rp-5132: PostHog says 1:45:49, the copy ends at 14:28.5.
    expect(importedUntil(868_500, 6_349_000)).toBe(868_500);
    expect(importedUntil(295_000, 299_000)).toBeNull();
    expect(importedUntil(9 * 60_000, 10 * 60_000)).toBeNull();
    expect(importedUntil(null, 6_349_000)).toBeNull();
    expect(importedUntil(868_500, null)).toBeNull();
  });
  test("the player waits for the capture's own end before calling a page left open cut short", () => {
    const row = { captured_ms: null, duration_ms: 300_000, dom_chunks: 2, provider: "posthog" as const };
    expect(playerImportedUntil(row, 60_000, 0)).toBeNull();
    expect(playerImportedUntil(row, 60_000, 299_000)).toBeNull();
    expect(playerImportedUntil({ ...row, duration_ms: 6_349_000 }, 60_000, 868_500)).toBe(868_500);
    expect(playerImportedUntil({ ...row, duration_ms: 6_349_000, captured_ms: 868_500 }, 60_000, 0)).toBe(868_500);
    expect(playerImportedUntil({ ...row, provider: "sdk" as const, duration_ms: 6_349_000 }, 60_000, 868_500)).toBeNull();
  });
  test("a stored reach decides; the player's end can never wipe it", () => {
    // rp-5132 as the player saw it: the stored reach is 14:28, the player's clock runs the row's 1:45:49.
    const row = { captured_ms: 868_522, duration_ms: 6_349_000, dom_chunks: 3, provider: "posthog" as const };
    expect(playerImportedUntil(row, 868_000, 6_349_000)).toBe(868_522);
    expect(playerImportedUntil(row, 900_000, 0)).toBe(900_000);
  });
  test("the player's length is the capture's end only when it is not the row's length echoed back", () => {
    expect(captureEndFrom({ duration_ms: 6_349_000 }, 6_349_000)).toBe(0);
    expect(captureEndFrom({ duration_ms: 6_349_000, capture_end_ms: 868_522 }, 6_349_000)).toBe(868_522);
    expect(captureEndFrom({ duration_ms: 32_000 }, null)).toBe(32_000);
    expect(captureEndFrom({ duration_ms: 299_970 }, 30_000)).toBe(299_970);
  });
  test("the vendor's player opens at the asked second", () => {
    expect(vendorUrlAt("https://us.posthog.com/project/1/replay/abc", 3_600_400)).toBe("https://us.posthog.com/project/1/replay/abc?t=3600");
    expect(vendorUrlAt("https://acme.sentry.io/replays/abc/?x=1", 61_000)).toBe("https://acme.sentry.io/replays/abc/?x=1&t=61");
    expect(vendorUrlAt("not a url", 1000)).toBe("not a url");
  });
  test("Errors lists exceptions and console errors; failed requests stay in Network", () => {
    const failed: ReplayEvent = { t: 1, type: "network", method: "GET", url: "/api", status: 500, ms: 10 };
    const thrown: ReplayEvent = { t: 2, type: "error", message: "boom" };
    const logged: ReplayEvent = { t: 3, type: "console", level: "error", message: "bad" };
    expect(railAdmits("errors", failed)).toBe(false);
    expect(railAdmits("network", failed)).toBe(true);
    expect(railAdmits("errors", thrown)).toBe(true);
    expect(railAdmits("errors", logged)).toBe(true);
  });
  test("fields touched without typing read as focus and fold into one run", () => {
    const f = (t: number, label: string): ReplayEvent => ({ t, type: "input", label, selector: "input", length: 0, redacted: true });
    expect(describeEvent(f(0, "Email"))).toBe("Email");
    const rows = [f(8500, "Name"), f(8510, "Role"), f(8520, "Email"), f(8530, "Phone")].map((e, i) => [e, i] as const);
    expect(foldRail(rows)).toHaveLength(1);
    expect(railRunKey({ t: 0, type: "input", label: "Name", selector: "input", length: 3, redacted: true })).toBeNull();
  });
  test("an action's detail names its locator, context and position", () => {
    const d = actionDetail({ t: 0, type: "click", label: "", role: "button", selector: "button.p-1", context: "x icon in Release this call", x: 412.4, y: 88 });
    expect(d.map((r) => r.term)).toEqual(["Role", "Context", "Element", "At"]);
    expect(d.find((r) => r.term === "At")?.value).toBe("412, 88 px");
    expect(actionDetail({ t: 0, type: "click", label: "", selector: "[rrweb-id=4]" }).find((r) => r.term === "Element")?.value).toMatch(/not in the capture/);
  });
  test("a preview opens where the person first did something", () => {
    expect(previewAt({ strip: "000300" }, 60_000)).toBe(29_000);
    // Activity from the first slice, or none known: past the loading splash, not 0:00.
    expect(previewAt({ strip: "300000" }, 60_000)).toBe(2_500);
    expect(previewAt({ strip: "000000" }, 60_000)).toBe(2_500);
    expect(previewAt(null, 60_000)).toBe(2_500);
    expect(previewAt(null, 10_000)).toBe(1_000);
    expect(previewAt(null, null)).toBe(0);
    // A failure leads: three seconds before the first one.
    expect(previewAt({ strip: "300000", marks: [500, 200] }, 60_000)).toBe(9_000);
  });
});

describe("reading the rest of a long recording", () => {
  const now = 2_000_000_000_000;
  const cut = { provider: "posthog" as const, captured_ms: 868_000, duration_ms: 6_349_000, vendor_refresh_after: null, import_rest: null };
  const chain = (over: Partial<NonNullable<OpsReplay["import_rest"]>> = {}) => ({ next_blob: 60, blobs: 240, retry_at: null, error: null, updated_at: now - 5_000, ...over });

  test("restState: reading, waiting on the rate limit, or stopped, with the share read", () => {
    expect(restState({ import_rest: null }, now)).toBeNull();
    expect(restState({ import_rest: chain(), captured_ms: 15 * 60_000, duration_ms: 60 * 60_000 }, now)).toEqual({ state: "reading", share: 0.25, error: null });
    // Every blob the vendor listed is read, yet the recording runs on: the vendor is still writing it, so it reads caught up, never 100%.
    expect(restState({ import_rest: chain({ next_blob: 8, blobs: 8 }), captured_ms: 33 * 60_000, duration_ms: 58 * 60_000 }, now)).toMatchObject({ state: "reading", caught_up: true });
    expect(restState({ import_rest: chain({ next_blob: 8, blobs: 8 }), captured_ms: 33 * 60_000, duration_ms: 58 * 60_000 }, now)!.share).toBeCloseTo(33 / 58);
    expect(restState({ import_rest: chain({ retry_at: now + 30_000 }) }, now)?.state).toBe("waiting");
    expect(restState({ import_rest: chain({ error: "PostHog answered 404" }) }, now)).toMatchObject({ state: "stopped", error: "PostHog answered 404" });
    expect(restState({ import_rest: chain({ updated_at: now - REST_STALL_MS - 1 }) }, now)).toMatchObject({ state: "stopped", since: now - REST_STALL_MS - 1 });
  });

  test("restDue: a cut PostHog copy with nothing reading its rest", () => {
    expect(restDue(cut, now)).toBe(true);
    expect(restDue({ ...cut, import_rest: chain() }, now)).toBe(false);
    expect(restDue({ ...cut, import_rest: chain({ error: "x" }) }, now)).toBe(true);
    expect(restDue({ ...cut, vendor_refresh_after: now + 1 }, now)).toBe(false);
    expect(restDue({ ...cut, provider: "sentry" as const }, now)).toBe(false);
    expect(restDue({ ...cut, captured_ms: 6_340_000 }, now)).toBe(false);
  });
});

describe("netParts", () => {
  test("keeps the last segment whole, two when the last is an id", () => {
    expect(netParts("GET", "https://x.io/api/electric/v1/shape/calls?cursor=&live=")).toEqual({ method: "GET", head: "/api/electric/v1/shape", tail: "/calls" });
    expect(netParts("POST", "https://x.io/api/users/451079698")).toEqual({ method: "POST", head: "/api", tail: "/users/451079698" });
    expect(netParts("GET", "https://x.io/api/rpc/dU5yHTxrrNEVqh4Eu2")).toEqual({ method: "GET", head: "/api", tail: "/rpc/dU5yHTxrrNEVqh4Eu2" });
    expect(netParts("GET", "https://x.io/health")).toEqual({ method: "GET", head: "", tail: "/health" });
  });
});

describe("issueTitleParts", () => {
  test("keeps a path's last segment as the tail", () => {
    expect(issueTitleParts("GET /api/users/claim failed with 500")).toEqual({ head: "GET /api/users", tail: "/claim failed with 500" });
    expect(issueTitleParts("TypeError: cannot read x of undefined")).toEqual({ head: "TypeError: cannot read x of undefined", tail: "" });
  });
});

describe("rest of a long recording", () => {
  test("the page offers to read the rest exactly when the server would", () => {
    const now = 1_000_000_000;
    const cut = { provider: "posthog" as const, captured_ms: 600_000, duration_ms: 3_600_000, imported_at: now - 1, import_rest: null, vendor_refresh_after: null };
    expect(restDue(cut, now)).toBe(true);
    // A short gap is an idle tail the vendor counts, not a missing part: the server does not read it, so neither is it offered.
    expect(restDue({ ...cut, captured_ms: 3_590_000 }, now)).toBe(false);
    expect(restDue({ ...cut, vendor_refresh_after: now + 60_000 }, now)).toBe(false);
  });

  test("a hold says what stops it and when it is tried again", () => {
    const now = new Date(2026, 10, 4, 12, 0).getTime();
    expect(restHold({ vendor_refresh_after: now - 1, vendor_refresh_why: "realtime" }, now)).toBeNull();
    const h = restHold({ vendor_refresh_after: now + 10 * 60_000, vendor_refresh_why: "realtime" }, now)!;
    expect(restHoldText(h, "PostHog", now)).toMatch(/^PostHog is still recording · read at /);
    expect(restHoldText({ ...h, why: "rate_limit" }, "PostHog", now)).toMatch(/^PostHog rate limit · retry /);
    expect(restHoldText({ ...h, why: "gone" }, "PostHog", now)).toBe("gone from PostHog");
  });

  test("the stage names a cause, never the engine's wording", () => {
    expect(stageProblemText("The recording could not be read: the recording is larger than a capture may be")).toBe("This stretch is too large to load");
    expect(stageProblemText("Something odd.")).toBe("Something odd");
  });

  test("failures that share a reason are said once", () => {
    expect(failureReasons([{ id: "a", error: "429" }, { id: "b", error: "429" }, { id: "c", error: "gone" }]).map((r) => [r.plain, r.ids])).toEqual([["Rate limited by the vendor", ["a", "b"]], ["gone", ["c"]]]);
    // The out-of-memory death reads as what it means; the raw words stay on the group.
    const oom = "the import died: JavaScript execution ran out of memory (maximum memory usage: 64 MB): request stream size was 0 bytes";
    const [r] = failureReasons([{ id: "x", error: oom }]);
    expect([r.plain, r.error]).toEqual(["Too large to read in one pass", oom]);
  });
});

describe("the rail's current row", () => {
  // All hides scrolls: the clock at 30:00 sits on a scroll, and the row it marks is the click before it.
  const rows = [[{ t: 1_000 }, 0], [{ t: 1_200_000 }, 3], [{ t: 1_700_000 }, 7]] as const;
  test("the last row the tab shows at or before the clock, never the hidden event the clock is on", () => {
    expect(railRowAt(rows, 1_800_000, new Map())).toBe(7);
    expect(railRowAt(rows, 1_200_000, new Map())).toBe(3);
    expect(railRowAt(rows, 500, new Map())).toBe(-1);
    expect(railRowAt([], 9, new Map())).toBe(-1);
  });
  test("inside a folded run, its lead", () => {
    expect(railRowAt(rows, 1_800_000, new Map([[7, 3]]))).toBe(3);
  });
});

describe("where reading the rest stands, in one set of words", () => {
  const now = 1_793_000_000_000;
  test("reading, waiting, held, stopped", () => {
    expect(restLine({ state: "reading", share: 0.38, error: null }, null, false, "PostHog", now)).toMatchObject({ text: "reading now", tone: "busy", share: 0.38 });
    // Never "caught up" while the copy is short of the recording.
    expect(restLine({ state: "reading", share: 0.57, error: null, caught_up: true, live: true }, null, false, "PostHog", now).text).toBe("reading · PostHog still recording");
    expect(restLine({ state: "reading", share: 0.57, error: null, caught_up: true }, null, false, "PostHog", now).text).toBe("reading now");
    // Gone quiet with no word: stalled since its last step, not "reading".
    expect(restLine({ state: "stopped", share: 0.9, error: null, since: now - 3 * 3_600_000 }, null, false, "PostHog", now).text).toMatch(/^stalled since /);
    expect(restLine(null, null, false, "PostHog", now, { pos: 4, reading: "rp-9" }).text).toBe("queued · #4");
    expect(restLine(null, null, false, "PostHog", now, { pos: null, reading: null }).text).toBe("queued");
    expect(restLine(null, null, true, "PostHog", now).text).toBe("starting import");
    // A chain that failed and is held until a retry says both: where it stopped and when it is tried again.
    const held = restLine({ state: "stopped", share: 0.79, error: "The page state where the last part ended could not be rebuilt" }, { why: "failed", until: now + 3_600_000 }, false, "PostHog", now);
    expect(held.text).toMatch(/^stopped · retry /);
    expect(held.title).toContain("could not be rebuilt");
    expect(restLine({ state: "stopped", share: 0.79, error: "x" }, null, false, "PostHog", now)).toMatchObject({ text: "stopped", tone: "stopped", title: "x" });
    expect(restLine(null, { why: "gone", until: now + 1 }, false, "PostHog", now).text).toBe("gone from PostHog");
    expect(restLine(null, null, false, "PostHog", now).tone).toBe("idle");
  });
});

describe("list cells", () => {
  test("counts compact past 999, browsers lose their vendor's name", () => {
    expect([compactCount(442), compactCount(1_141), compactCount(12_400)]).toEqual(["442", "1.1k", "12k"]);
    expect([shortBrowser("Microsoft Edge"), shortBrowser("Chrome"), shortBrowser("Mobile Safari")]).toEqual(["Edge", "Chrome", "Safari"]);
  });
  test("a player link asks for remote assets on this view only", () => {
    expect(withRemoteAssets("https://replay.codecast.sh/p/CAP?t=5&controls=0")).toBe("https://replay.codecast.sh/p/CAP?t=5&controls=0&assets=remote");
    expect(withRemoteAssets("not a link")).toBe("not a link");
  });
});

describe("the page a recording is named by", () => {
  test("its start address, else the first page it visited, never its own id", () => {
    expect(replayPagePath({ url: "https://x.test/book/1", shape: null })).toBe("/book/1");
    expect(replayPagePath({ url: null, shape: { paths: ["/home", "/pay"] } as any })).toBe("/home");
    expect(replayPagePath({ url: null, shape: null })).toBe("");
  });

  test("a path cut for a narrow cell keeps its last segment", () => {
    expect(pagePathParts("/book/54333ea0")).toEqual({ head: "/book", tail: "/54333ea0" });
    expect(pagePathParts("/book/")).toEqual({ head: "/book/", tail: "" });
    expect(pagePathParts("/")).toEqual({ head: "/", tail: "" });
  });
});

describe("the rest backlog", () => {
  const now = 2_000_000_000_000;
  test("a cut copy nothing reads waits in the sweep's queue at its place", () => {
    const r = { short_id: "rp-7", provider: "posthog" as const, captured_ms: 60_000, duration_ms: 3_600_000, import_rest: null, vendor_refresh_after: null, imported_at: now - 1 } as any;
    const source = { replay_rest: { cut: 3, unknown: 0, at: now, queue: ["rp-1", "rp-7"], reading: "rp-0" } };
    expect(restQueued(r, source, now)).toEqual({ pos: 2, reading: "rp-0" });
    expect(restQueued(r, { replay_rest: { cut: 3, unknown: 0, at: now } }, now)).toEqual({ pos: null, reading: null });
    // A whole copy, or one held after a failure, is not queued.
    expect(restQueued({ ...r, captured_ms: 3_600_000 }, source, now)).toBeUndefined();
    expect(restQueued({ ...r, vendor_refresh_after: now + 1 }, source, now)).toBeUndefined();
  });
  test("a chain the import line does not name waits its turn, and only the named one reads", () => {
    const chainRow = { short_id: "rp-5393", provider: "posthog" as const, captured_ms: 600_000, duration_ms: 2_000_000, started_at: now - 7 * 3_600_000, imported_at: now - 1, vendor_refresh_after: null, import_rest: { next_blob: 4, blobs: 4, retry_at: null, error: null, updated_at: now - 5_000 } } as any;
    const source = { replay_rest: { cut: 3, unknown: 0, at: now, queue: ["rp-1"], reading: "rp-5468" } };
    const other = restState(chainRow, now, "rp-5468");
    expect(other).toMatchObject({ state: "reading", elsewhere: "rp-5468" });
    expect(restLine(other, null, false, "PostHog", now, restQueued(chainRow, source, now))).toMatchObject({ text: "queued", tone: "idle" });
    // Named, ended hours ago, every listed part read: it reads, and never says PostHog is still recording.
    expect(restLine(restState(chainRow, now, "rp-5393"), null, false, "PostHog", now).text).toBe("reading now");
    // Still recording only while the recording's last moment is recent.
    const live = { ...chainRow, started_at: now - chainRow.duration_ms - 60_000 };
    expect(restLine(restState(live, now, "rp-5393"), null, false, "PostHog", now).text).toBe("reading · PostHog still recording");
    expect([recordingLive(live, now), recordingLive(chainRow, now)]).toEqual([true, false]);
  });
  test("PostHog answering no more of an ended recording reads as its copy ending there", () => {
    const row = { short_id: "rp-5460", captured_ms: 93_000, duration_ms: 303_000, started_at: now - 2 * 3_600_000, import_rest: { next_blob: 3, blobs: 3, retry_at: null, error: REPLAY_REST_NO_MORE, updated_at: now - 5_000 } } as any;
    const line = restLine(restState(row, now), { why: "failed", until: now + 3_600_000 }, false, "PostHog", now);
    expect(line.text).toMatch(/^PostHog has no more · retry /);
    expect(line.tone).toBe("held");
  });
  test("the trend compares the live count with the recount before the last", () => {
    expect(restTrend({ cut: 863, unknown: 0, at: now, prev: { cut: 875, at: now - 3_600_000 } }, now)).toMatchObject({ text: "−12/h", tone: "down" });
    // Falling, it says how long until none is cut at that rate; rising or flat it cannot.
    expect(etaText(restTrend({ cut: 863, unknown: 0, at: now, prev: { cut: 875, at: now - 3_600_000 } }, now)!.eta_ms!)).toBe("3d");
    expect(restTrend({ cut: 880, unknown: 0, at: now, prev: { cut: 875, at: now - 3_600_000 } }, now)?.eta_ms).toBeUndefined();
    expect([etaText(30 * 60_000), etaText(5 * 3_600_000), etaText(72 * 3_600_000)]).toEqual(["<1h", "5h", "3d"]);
    expect(restTrend({ cut: 863, unknown: 0, at: now, prev: { cut: 875, at: now - 1_800_000 } }, now)?.text).toBe("−24/h");
    expect(restTrend({ cut: 875, unknown: 0, at: now, prev: { cut: 875, at: now - 3_600_000 } }, now)?.tone).toBe("flat");
    expect(restTrend({ cut: 875, unknown: 0, at: now }, now)).toBeNull();
  });
});

describe("where a replay link opens", () => {
  test("?t is seconds; an older link's ms is taken only when the seconds run past the recording", async () => {
    const { startTime } = await import("./replayPlayerModel");
    const H = 3_600_000;
    // ?t=7200 on an eight hour recording: two hours in.
    expect(startTime(7_200_000, 7200, 8 * H)).toBe(7_200_000);
    // ?t=7200 on a one minute recording can only have been ms.
    expect(startTime(7_200_000, 7200, 60_000)).toBe(7200);
    expect(startTime(83_200, undefined, 60_000)).toBe(83_200);
    expect(startTime(null, undefined, 60_000)).toBe(null);
  });
});
