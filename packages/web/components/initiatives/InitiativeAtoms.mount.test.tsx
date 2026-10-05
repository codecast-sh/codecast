// The atoms every goal surface draws
// (docs/architecture/initiatives-projects-role-page.md I5), mounted in jsdom.
// Proves: a metric reads right at every size with no value, one report, a
// value that is not a number and a number to stay under (never "34 of under
// 20"); the chip carries the metric's name; the trend glyph says the
// contract's words; a far target stays off the sparkline's scale; a stored
// day (a target, a milestone) names the same day east and west of UTC and
// turns late by the viewer's own calendar; a source shows a note's words and
// resolves who said it to a face; an update line reads as plain words.
// Run: bun test components/initiatives/InitiativeAtoms.mount.test.tsx
import { test } from "bun:test";
import { realInboxStore, restoreInboxStoreAfterAll } from "../__tests__/mockInboxStore";

restoreInboxStoreAfterAll();
import assert from "node:assert/strict";
import type { OrgTree } from "../org/orgTypes";

async function verifyAtoms() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "CustomEvent", "Event", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  const { act } = React;

  const { ORG_FIXTURE } = await import("../org/orgFixture");
  const tree = ORG_FIXTURE as OrgTree;
  const state: any = { currentUser: { _id: "fixture-user-me", name: "Ashot" }, orgTree: tree };
  const useInboxStore = Object.assign((sel: any) => sel(state), { getState: () => state, setState: () => {} });
  mock.module("../../store/inboxStore", () => ({ ...realInboxStore, useInboxStore, useTrackedStore: () => state }));
  mock.module("../../hooks/useOrgRoles", () => ({ useOrgRoles: () => ({ roles: tree.roles, workspace: tree.workspace, roleBotUserIds: new Set<string>() }) }));
  const realRoster = await import("../../hooks/useTeamRoster");
  mock.module("../../hooks/useTeamRoster", () => ({ ...realRoster, useTeamRosterIdentity: () => [{ _id: "fixture-user-me", name: "Ashot" }, { _id: "fixture-user-sam", name: "Sam" }] }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  const realAssignee = { ...(await import("../identity/AssigneeFace")) };
  mock.module("../identity/AssigneeFace", () => ({ ...realAssignee, AssigneeFace: ({ info }: any) => React.createElement("span", { "data-face": info.kind === "role" ? `role:${info.handle}` : `person:${info.name}` }) }));

  const { createRoot } = await import("react-dom/client");
  const A = await import("./InitiativeAtoms");
  const { metricReading, metricTrend } = await import("@codecast/shared/contracts/initiative");
  const { targetDayStamp, formatShortDate } = await import("@codecast/shared/time");
  const root = createRoot(document.getElementById("root")!);
  const h = React.createElement;
  const show = async (node: React.ReactNode) => { await act(async () => root.render(node)); return document.getElementById("root")!; };
  // The words as read: each run of text, a space between runs (the gaps are CSS).
  const text = (el: Element | null) => {
    const runs: string[] = [];
    const walk = (n: Node) => { if (n.nodeType === 3) runs.push((n.textContent ?? "").trim()); else if ((n as Element).tagName !== "title") n.childNodes.forEach(walk); };
    if (el) walk(el);
    return runs.filter(Boolean).join(" ");
  };

  const DAY = 86_400_000;
  const NOW = Date.UTC(2026, 8, 18, 12);
  const score = (value: string, daysAgo: number) => ({ value, observed_at: NOW - daysAgo * DAY, source: "ct-1" });
  const SIZES = ["tile", "line", "chip"] as const;
  const tile = async (reading: any, size: (typeof SIZES)[number], trend?: any, extra: any = {}) => show(h(A.MetricTile, { reading, trend, now: NOW, size, ...extra }));

  // ── a metric with no value yet: the target is named as a target, at every size ──
  const teams = { key: "teams", name: "Weekly active teams", target: "1,000" };
  for (const size of SIZES) {
    const el = await tile(metricReading(teams), size);
    assert.match(text(el), /target 1,000/, `${size}: an unreported metric names its target`);
    assert.doesNotMatch(text(el), /of 1,000|\/ 1,000/, `${size}: nothing is "of" a target before a value`);
    assert.equal(el.querySelector("[data-metric-standing='unknown']") !== null, true);
    assert.equal(el.querySelector("[data-sparkline]"), null);
    assert.equal(el.querySelector("[data-metric-trend]"), null);
  }
  assert.equal(text((await tile(metricReading(teams), "tile")).querySelector("[data-metric-now]")), "not reported");
  assert.match(text(await tile(metricReading(teams), "tile")), /Not reported yet/);
  assert.equal(text(await tile(metricReading(teams), "chip")), "Weekly active teams target 1,000", "the chip never prints the target where the value goes");

  // ── one report: the number against its target, a bar, no trend and no sparkline yet ──
  const one = metricReading(teams, score("412", 3));
  const oneTrend = metricTrend([score("412", 3)], teams.target);
  let el = await tile(one, "tile", oneTrend);
  assert.equal(text(el.querySelector("[data-metric-now]")), "412");
  assert.equal(text(el.querySelector("[data-metric-target]")), "of 1,000");
  assert.match(text(el), /Behind/);
  assert.match(text(el), /read Sep 15/);
  assert.ok(el.querySelector("[data-metric-bar]"));
  assert.equal(el.querySelector("[data-sparkline]"), null);
  assert.equal(el.querySelector("[data-metric-trend]"), null);
  el = await tile(one, "line", oneTrend);
  assert.match(text(el), /^Weekly active teams 412 of 1,000 Sep 15$/);
  assert.ok(el.querySelector("[data-metric-bar]"), "the line draws the bar until two reports make a sparkline");
  el = await tile(one, "chip", oneTrend);
  assert.equal(text(el), "Weekly active teams 412 / 1,000");

  // ── the chip carries the name, with the whole reading as its title; a column that names it can drop it ──
  const longName = { key: "long", name: "Weekly active teams that opened the review page", target: "40" };
  el = await tile(metricReading(longName, score("12", 1)), "chip");
  assert.equal(text(el.querySelector("[data-metric-name]")), longName.name);
  assert.match(el.querySelector("[data-metric-name]")!.className, /truncate/);
  assert.match(el.querySelector("[data-metric-size='chip']")!.getAttribute("title")!, /^Weekly active teams that opened the review page: 12 of 40, behind/);
  el = await tile(metricReading(longName, score("12", 1)), "chip", undefined, { named: false });
  assert.equal(el.querySelector("[data-metric-name]"), null);
  assert.equal(text(el), "12 / 40");

  // ── a value that is not a number, and a target that is not one ──
  const soon = metricReading(teams, score("soon", 1));
  el = await tile(soon, "tile");
  assert.equal(text(el.querySelector("[data-metric-now]")), "soon");
  assert.match(text(el), /Not a number/);
  assert.equal(el.querySelector("[data-metric-bar]"), null);
  const shipped = metricReading({ key: "ship", name: "Launch", target: "shipped" }, score("3", 1));
  el = await tile(shipped, "tile");
  assert.equal(text(el.querySelector("[data-metric-target]")), "target shipped");
  assert.match(text(el), /No number in the target/);
  assert.doesNotMatch(text(el), /Not a number/);
  assert.match(text(await tile(shipped, "line")), /3, target shipped/);
  assert.equal(text(await tile(shipped, "chip")), "Launch 3 · shipped");
  for (const size of SIZES) assert.doesNotMatch(text(await tile(shipped, size)), /of shipped|\/ shipped/, `${size}: a target that is not a number never gets "of"`);

  // ── a number to stay under reads right at every size ──
  for (const target of ["under 20", "< 20", "at most 20"]) {
    const review = metricReading({ key: "review", name: "Review minutes", target }, score("34", 1));
    assert.equal(review.standing, "behind", target);
    assert.equal(text((await tile(review, "tile")).querySelector("[data-metric-target]")), `target ${target}`);
    assert.match(text(await tile(review, "line")), new RegExp(`34, target ${target}`));
    assert.equal(text(await tile(review, "chip")), `Review minutes 34 · ${target}`);
    for (const size of SIZES) assert.doesNotMatch(text(await tile(review, size)), /34 of|34\s*\//, `${size}: never "34 of ${target}"`);
  }

  // ── the trend glyph says the contract's words: direction and number over the same span ──
  const fell = metricTrend([score("100", 9), score("200", 5), score("190", 1)], "1000");
  el = await show(h(A.TrendGlyph, { trend: fell }));
  assert.equal(el.querySelector("[data-metric-trend]")!.getAttribute("aria-label"), "Up from 100, toward the target");
  assert.doesNotMatch(el.querySelector("[data-metric-trend]")!.getAttribute("aria-label")!, /since the last report/);
  el = await show(h(A.TrendGlyph, { trend: metricTrend([score("30", 9), score("34", 1)], "under 20") }));
  assert.equal(el.querySelector("[data-metric-trend]")!.getAttribute("aria-label"), "Up from 30, away from the target");
  assert.equal(el.querySelector("[data-metric-toward]")!.getAttribute("data-metric-toward"), "no");
  el = await show(h(A.TrendGlyph, { trend: metricTrend([score("40", 9), score("40", 1)], "50") }));
  assert.equal(el.querySelector("[data-metric-trend]")!.getAttribute("aria-label"), "Flat");
  el = await show(h(A.TrendGlyph, { trend: oneTrend }));
  assert.equal(el.querySelector("[data-metric-trend]"), null, "nothing before two reports");

  // ── the sparkline: a target far outside the series stays off the scale, so the trend can be seen ──
  const ys = (root: Element) => root.querySelector("polyline")!.getAttribute("points")!.split(" ").map((p) => Number(p.split(",")[1]));
  el = await tile(metricReading(teams, score("412", 1)), "tile", metricTrend([score("380", 9), score("395", 5), score("412", 1)], teams.target));
  assert.ok(el.querySelector("[data-sparkline]"));
  assert.equal(el.querySelector("[data-sparkline] line"), null, "no rule for a target far away");
  assert.deepEqual([Math.max(...ys(el)), Math.min(...ys(el))], [18, 2], "the series draws at full height");
  el = await tile(metricReading({ ...teams, target: "450" }, score("412", 1)), "tile", metricTrend([score("380", 9), score("395", 5), score("412", 1)], "450"));
  assert.ok(el.querySelector("[data-sparkline] line"), "a target in range is ruled");
  assert.equal(Math.min(...ys(el)) > 2, true, "and the series sits under it");

  // ── MetricReadingLine is the line form with no history ──
  el = await show(h(A.MetricReadingLine, { reading: one, now: NOW }));
  const viaReadingLine = el.innerHTML;
  assert.equal(el.querySelector("[data-metric='teams']")!.getAttribute("data-metric-size"), "line");
  assert.ok(el.querySelector("[data-metric-bar]"));
  assert.equal((await tile(one, "line")).innerHTML, viaReadingLine, "one drawing of a metric line");

  // ── a stored day names the same day everywhere, and is late by the viewer's own calendar ──
  const zone = process.env.TZ;
  try {
    const day = targetDayStamp("2026-10-30")!;
    for (const tz of ["Europe/Berlin", "Asia/Tokyo", "America/New_York"]) {
      process.env.TZ = tz;
      el = await show(h(A.TargetDate, { ts: day, now: NOW }));
      assert.equal(text(el), "Oct 30", `${tz}: the target reads as its own day`);
      assert.equal(el.querySelector("[data-initiative-target]")!.getAttribute("data-initiative-target"), "ahead");
      el = await show(h(A.NextMilestoneChip, { milestone: { key: "beta", title: "Private beta open", date: day }, now: NOW }));
      assert.equal(text(el), "Private beta open Oct 30", `${tz}: so does a milestone's day`);
      // Late in the evening of the day itself, where the viewer is: still on time. The next morning: late.
      const evening = new Date(2026, 9, 30, 22).getTime();
      const morning = new Date(2026, 9, 31, 8).getTime();
      assert.equal((await show(h(A.TargetDate, { ts: day, now: evening }))).querySelector("[data-initiative-target]")!.getAttribute("data-initiative-target"), "ahead", tz);
      assert.equal((await show(h(A.TargetDate, { ts: day, now: morning }))).querySelector("[data-initiative-target]")!.getAttribute("data-initiative-target"), "late", tz);
      assert.equal((await show(h(A.TargetDate, { ts: day, now: morning, done: true }))).querySelector("[data-initiative-target]")!.getAttribute("data-initiative-target"), "ahead", "a finished goal is never late");
      assert.equal((await show(h(A.NextMilestoneChip, { milestone: { key: "beta", title: "Private beta open", date: day }, now: evening }))).querySelector("[data-initiative-milestone]")!.getAttribute("data-initiative-milestone"), "next", tz);
      assert.equal((await show(h(A.NextMilestoneChip, { milestone: { key: "beta", title: "Private beta open", date: day }, now: morning }))).querySelector("[data-initiative-milestone]")!.getAttribute("data-initiative-milestone"), "late", tz);
    }
    // A project's deadline is the end of the viewer's own day: `local` reads it where they are.
    process.env.TZ = "America/New_York";
    const localEnd = new Date(2026, 9, 30, 23, 59, 59).getTime();
    assert.equal(text(await show(h(A.TargetDate, { ts: localEnd, now: NOW, local: true }))), "Oct 30");
    assert.equal((await show(h(A.TargetDate, { ts: localEnd, now: localEnd + 1000, local: true }))).querySelector("[data-initiative-target]")!.getAttribute("data-initiative-target"), "late");
    // A moment stays local time, through the shared formatter.
    assert.equal(A.shortDate(day, NOW), formatShortDate(day, NOW));
  } finally {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  }

  // ── the next milestone: none, and all reached ──
  assert.equal(text(await show(h(A.NextMilestoneChip, { milestone: null, now: NOW }))), "");
  assert.equal(text(await show(h(A.NextMilestoneChip, { milestone: null, now: NOW, counts: { done: 0, total: 0 } }))), "");
  assert.equal(text(await show(h(A.NextMilestoneChip, { milestone: null, now: NOW, counts: { done: 1, total: 1 } }))), "Its milestone is reached");
  el = await show(h(A.NextMilestoneChip, { milestone: null, now: NOW, counts: { done: 3, total: 3 } }));
  assert.equal(text(el), "All 3 milestones reached");
  assert.equal(el.querySelector("[data-initiative-milestone]")!.getAttribute("data-initiative-milestone"), "all-reached");
  el = await show(h(A.NextMilestoneChip, { milestone: { key: "undated", title: "A person reads one page" }, now: NOW, counts: { done: 1, total: 3 } }));
  assert.equal(text(el), "A person reads one page");
  assert.equal(el.querySelector("[data-initiative-milestone]")!.getAttribute("data-initiative-milestone"), "next", "no day, never late");

  // ── a source: a note shows its words; who said it wears a face; a link opens ──
  const long = "We agreed on the Monday standup that brokers go first and everyone else waits for the second wave";
  el = await show(h(A.SourceLink, { source: { kind: "note", quote: "on the Monday standup" }, now: NOW }));
  assert.equal(text(el), "on the Monday standup", "never the bare word Note");
  assert.equal(el.querySelector("a"), null);
  el = await show(h(A.SourceLink, { source: { kind: "note", quote: long, by: "Sam", at: NOW - 3 * DAY }, now: NOW }));
  const label = el.querySelector("[data-intent-source-label]")!;
  assert.equal(label.getAttribute("title"), long, "the whole text is the title");
  assert.match(label.className, /truncate/);
  assert.ok(el.querySelector("[data-initiative-by='face'] [data-face='person:Sam']"), "a name the roster knows wears its face");
  assert.match(text(el), /Sam Sep 15$/);
  el = await show(h(A.SourceLink, { source: { kind: "chat", ref: "m2", quote: "ship it" }, now: NOW }));
  assert.equal(el.querySelector("[data-intent-source-label]")!.getAttribute("title"), "ship it", "an unlinked source still gives its words");
  el = await show(h(A.SourceLink, { source: { kind: "task", ref: "ct-12", quote: "said so", by: "@growth", at: NOW - DAY }, now: NOW }));
  assert.equal(el.querySelector("a")!.getAttribute("href"), "/tasks/ct-12");
  assert.equal(el.querySelector("a")!.getAttribute("title"), "said so");
  assert.ok(el.querySelector("[data-face='role:growth']"), "an @handle that is a role wears the role's face");
  el = await show(h(A.SourceLink, { source: { kind: "task", ref: "ct-12", by: "A stranger" }, now: NOW }));
  assert.equal(text(el.querySelector("[data-initiative-by='text']")), "A stranger", "a name nobody here has stays words");
  el = await show(h(A.SourceLink, { source: { kind: "task", ref: "ct-12", by: "Sam", at: NOW }, now: NOW, bare: true }));
  assert.equal(text(el), "ct-12", "bare is the address alone");
  el = await show(h(A.SourceLink, { source: { kind: "link", ref: "https://www.example.com/a" }, now: NOW }));
  assert.equal(el.querySelector("a")!.getAttribute("target"), "_blank");
  assert.equal(text(el), "example.com");

  // ── the latest update as one plain line ──
  el = await show(h(A.UpdateLine, { update: { health: "at_risk", at: NOW - 2 * DAY, body: "\n## Week 38\nShipped `score_history` and [the scope view](https://x.dev/a_b).\n\nMore below." }, now: NOW }));
  assert.equal(el.querySelector("[data-initiative-update-line]")!.getAttribute("data-initiative-update-line"), "at_risk");
  assert.match(text(el), /^At risk 2d Week 38$/);
  el = await show(h(A.UpdateLine, { update: { health: "on_track", at: NOW - DAY, body: "Shipped `score_history` and [the scope view](https://x.dev/a_b)." }, now: NOW }));
  assert.match(text(el), /Shipped score_history and the scope view\.$/, "underscores stay and a link reads as its words");
  assert.equal(el.querySelector("[data-initiative-update-line]")!.getAttribute("title"), "Shipped score_history and the scope view.");
  assert.equal(text(await show(h(A.UpdateLine, { update: null, now: NOW }))), "");

  await act(async () => root.unmount());
}

test("the goal atoms mount: metrics at every size, trend words, the sparkline's scale, days in every timezone, sources and the update line", async () => {
  await verifyAtoms();
}, 600_000);
