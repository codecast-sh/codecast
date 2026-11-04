import { describe, expect, test } from "bun:test";
import {
  DEFAULT_QUERY,
  issueTotals,
  withTotals,
  facetOptions,
  filterIssues,
  fixPlan,
  fixActionLabel,
  fixStage,
  healthStrip,
  lifeMarks,
  openIssueCount,
  usersCounted,
  yTicks,
  issueQueryParams,
  issueState,
  layoutChart,
  leadFrame,
  parseIssueQuery,
  rangeIds,
  regressedIn,
  replayOffset,
  sampleFacets,
  stackRows,
  statusCounts,
  trendOf,
  chartRangeFor,
  dailySeries,
  fixClose,
  issueActivity,
  issueLane,
  occurrencesSince,
  regressedAt,
  taskMatchesIssue,
  thinMarks,
  attentionScore,
  exceptionValue,
  facetRows,
  failuresIn,
  laneAdmits,
  laneCount,
  latestRelease,
  LATEST_RELEASE,
  releaseOptions,
  releaseTimes,
  resolverOf,
  resolverWords,
  sampleUsers,
  withPicked,
  type FixTask,
  type IssueCtx,
} from "./issuesModel";
import type { OpsEvent, OpsGroup, OpsSample } from "./opsTypes";

const HOUR = 3600_000;
const DAY_MS = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 3, 12, 30);
const THIS_HOUR = Date.UTC(2026, 10, 3, 12);

let n = 0;
const g = (over: Partial<OpsGroup> = {}): OpsGroup => ({
  _id: `g${++n}`,
  workspace: "team:t",
  source_id: "s1",
  short_id: `eg-${n}`,
  kind: "error",
  fingerprint: "fp",
  title: "TypeError: x is undefined",
  status: "open",
  first_seen: NOW - 48 * HOUR,
  last_seen: NOW - HOUR,
  count: 10,
  buckets: [],
  updated_at: NOW,
  ...over,
});
const ctx: IssueCtx = { taskStatus: () => undefined };

describe("issue state", () => {
  test("regressed is open with a regression newer than its last resolve", () => {
    expect(issueState(g({ regressed_at: NOW - HOUR, resolved_at: NOW - 2 * HOUR }))).toBe("regressed");
    expect(issueState(g({ regressed_at: NOW - 3 * HOUR, resolved_at: NOW - 2 * HOUR }))).toBe("open");
    expect(issueState(g({ status: "resolved", regressed_at: NOW - HOUR }))).toBe("resolved");
    expect(issueState(g({ status: "muted" }))).toBe("ignored");
    expect(issueState(g({ kind: "check", meta: { ok: true } }))).toBe("ok");
  });

  test("the release a regression came back in is the stamped one, else its transition's, never the last release seen", () => {
    const row = g({ last_release: "v9", regressed_at: NOW });
    const ev: OpsEvent = { _id: "e", workspace: "team:t", source: "sdk", kind: "error_regressed", title: "", group_id: row._id, data: { transition: "regressed", release: "v7" }, created_at: NOW };
    const older: OpsEvent = { ...ev, _id: "e0", data: { transition: "regressed", release: "v3" }, created_at: NOW - 9 * DAY_MS };
    expect(regressedIn(row, [older, ev])).toBe("v7");
    expect(regressedIn(row, [older])).toBeNull();
    expect(regressedIn(row, [])).toBeNull();
    expect(regressedIn({ ...row, regressed_in: "v8" }, [ev])).toBe("v8");
  });
});

describe("fix stage", () => {
  test("reads the task's category and a recorded fix session", () => {
    expect(fixStage({ status: "open" }, undefined)).toBe("none");
    expect(fixStage({ status: "open", signal_task_id: "t" }, "open")).toBe("filed");
    expect(fixStage({ status: "open", signal_task_id: "t" }, "in_progress")).toBe("fixing");
    expect(fixStage({ status: "open", fix_conversation_id: "c" }, undefined)).toBe("fixing");
    expect(fixStage({ status: "open", signal_task_id: "t" }, "in_review")).toBe("review");
    expect(fixStage({ status: "open", signal_task_id: "t" }, "done")).toBe("closed");
    expect(fixStage({ status: "resolved", fix_conversation_id: "c", resolved_at: NOW - HOUR }, undefined)).toBe("closed");
    expect(fixStage({ status: "open", signal_task_id: "t" }, "dropped")).toBe("dropped");
    expect(fixStage({ status: "open", signal_task_id: "t", fix_conversation_id: "c" }, "dropped")).toBe("dropped");
  });

  test("a resolve with no fix behind it is not a fix: the stage stays the task's, and firing again is not recurring", () => {
    // A bulk resolve 11 days ago on a group whose problem task is still open.
    const bulk = { status: "open" as const, signal_task_id: "t", resolved_at: NOW - 11 * DAY_MS, last_seen: NOW - HOUR, resolved_via: "person" as const };
    expect(fixClose(bulk, "open")).toBeNull();
    expect(fixStage(bulk, "open")).toBe("filed");
    expect(fixStage({ ...bulk, signal_task_id: undefined }, undefined)).toBe("none");
    // A metric that recovered on its own and crossed again.
    expect(fixStage({ status: "open", kind: "metric", signal_task_id: "t", resolved_at: NOW - DAY_MS, last_seen: NOW, meta: { ok: false } }, "open")).toBe("filed");
    // A resolve after a fix session started on the issue is the fix closing, and firing after it did not hold.
    const afterFix = { status: "open" as const, fix_conversation_id: "c", fix_started_at: NOW - 3 * DAY_MS, resolved_at: NOW - 2 * DAY_MS, last_seen: NOW - HOUR };
    expect(fixClose(afterFix, undefined)).toMatchObject({ how: "resolved", at: NOW - 2 * DAY_MS });
    expect(fixStage(afterFix, undefined)).toBe("recurring");
    // A resolve from before the session started closes nothing.
    expect(fixClose({ ...afterFix, fix_started_at: NOW - DAY_MS }, undefined)).toBeNull();
    // A task that landed a commit and fired since did not hold.
    expect(fixStage({ status: "open", signal_task_id: "t", last_seen: NOW }, { status: "done", landed: { sha: "abc", at: NOW - DAY_MS } })).toBe("recurring");
  });
});

describe("who resolved it", () => {
  test("the server's stamp first, then a recovery at the resolve, then the vendor, else nobody", () => {
    expect(resolverOf({ resolved_at: NOW, resolved_via: "person", resolved_by: "u1" })).toEqual({ via: "person", by: "u1" });
    expect(resolverOf({ kind: "metric", resolved_at: NOW, last_transition: "metric_recovered", last_transition_at: NOW + 1000 })).toEqual({ via: "recovered" });
    const m = g({ kind: "metric", resolved_at: NOW - DAY_MS, last_transition: "metric_alert", last_transition_at: NOW });
    const rec: OpsEvent = { _id: "r", workspace: "team:t", source: "posthog", kind: "metric_recovered", title: "", group_id: m._id, data: { transition: "metric_recovered" }, created_at: NOW - DAY_MS + 30_000 };
    expect(resolverOf(m, [rec])).toEqual({ via: "recovered" });
    expect(resolverOf(m, [])).toEqual({ via: null });
    expect(resolverOf({ resolved_at: NOW, external: { provider: "sentry", id: "1" } })).toEqual({ via: "vendor" });
    expect(resolverOf({ resolved_at: NOW })).toEqual({ via: null });
    expect(resolverWords({ via: null }, null)).toBe("resolved");
    expect(resolverWords({ via: "person", by: "u" }, null)).toBe("resolved by a person");
    expect(resolverWords({ via: "person", by: "u" }, "you")).toBe("resolved by you");
    expect(resolverWords({ via: "recovered" }, null)).toBe("recovered on its own");
    expect(resolverWords({ via: "vendor" }, null, "sentry")).toBe("resolved in Sentry");
  });
});

describe("lanes that decay", () => {
  test("a regression leaves Needs attention once quiet, or once it is a week old, and keeps its state", () => {
    const fresh = g({ regressed_at: NOW - HOUR, resolved_at: NOW - 2 * DAY_MS, last_seen: NOW - HOUR });
    const silent = g({ regressed_at: NOW - 6 * DAY_MS, resolved_at: NOW - 7 * DAY_MS, last_seen: NOW - 5 * DAY_MS });
    const old = g({ regressed_at: NOW - 9 * DAY_MS, resolved_at: NOW - 10 * DAY_MS, last_seen: NOW - HOUR, first_seen: NOW - 20 * DAY_MS });
    expect(issueLane(fresh, NOW)).toBe("regressed");
    expect(issueLane(silent, NOW)).toBe("quiet");
    expect(issueLane(old, NOW)).toBe("ongoing");
    expect(issueState(silent)).toBe("regressed");
    const counts = statusCounts([fresh, silent, old], DEFAULT_QUERY, ctx, NOW);
    expect(counts.attention).toBe(1);
    expect(laneCount(counts, "all")).toBe(3);
  });

  test("a check or metric that failed three times in a week is flapping, not regressed", () => {
    const m = g({ kind: "metric", meta: { ok: false }, resolved_at: NOW - 3 * HOUR, last_transition: "metric_alert", last_transition_at: NOW - HOUR, failed_at: [NOW - 5 * DAY_MS, NOW - 2 * DAY_MS, NOW - HOUR] });
    expect(issueState(m)).toBe("regressed");
    expect(failuresIn(m, [], NOW)).toBe(3);
    expect(issueLane(m, NOW)).toBe("flapping");
    expect(laneAdmits("attention", issueLane(m, NOW))).toBe(false);
    // Older failures fall out of the week; the transitions this device holds count too.
    const two = { ...m, failed_at: [NOW - 9 * DAY_MS, NOW - HOUR] };
    expect(issueLane(two, NOW)).toBe("regressed");
    const ev = (at: number): OpsEvent => ({ _id: `f${at}`, workspace: "team:t", source: "posthog", kind: "metric_alert", title: "", group_id: m._id, data: { transition: "metric_alert" }, created_at: at });
    expect(failuresIn(two, [ev(NOW - 3 * DAY_MS), ev(NOW - 2 * DAY_MS), ev(NOW - DAY_MS)], NOW)).toBe(3);
    expect(failuresIn(g(), [ev(NOW)], NOW)).toBe(0);
  });

  test("Needs attention on its default sort puts a loud recent fatal above a quiet old warning", () => {
    const warn = g({ level: "warning", first_seen: NOW - 2 * HOUR, last_seen: NOW - 20 * HOUR });
    const fatal = g({ level: "fatal", first_seen: NOW - 3 * HOUR, last_seen: NOW - 30 * 60_000, buckets: [{ hour: THIS_HOUR, count: 40 }] });
    const rows = filterIssues([warn, fatal], DEFAULT_QUERY, ctx, NOW);
    expect(rows.map((r) => r._id)).toEqual([fatal._id, warn._id]);
    expect(attentionScore(fatal, NOW, "new")).toBeGreaterThan(attentionScore(warn, NOW, "new"));
  });
});

describe("facets count what picking them would show", () => {
  test("each facet counts over the rest of the query, and a picked value stays at zero", () => {
    const a = g({ level: "error", last_release: "r1", source_id: "s1" });
    const b = g({ level: "warning", last_release: "r2", source_id: "s1" });
    const c = g({ level: "error", last_release: "r2", source_id: "s2" });
    const q = { ...DEFAULT_QUERY, lane: "all" as const, facets: { release: "r2" } };
    const one = { ...ctx, sourceId: "s1" };
    expect(facetOptions(facetRows([a, b, c], q, one, NOW, "level"), "level", one)).toEqual([{ value: "warning", count: 1 }]);
    expect(facetOptions(facetRows([a, b, c], q, one, NOW, "release"), "release", one).map((o) => o.value).sort()).toEqual(["r1", "r2"]);
    expect(facetRows([a, b, c], q, one, NOW, "source").map((r) => r._id)).toEqual([b._id, c._id]);
    expect(withPicked([{ value: "x", count: 2 }], "y", (value) => ({ value, count: 0 }))).toEqual([{ value: "y", count: 0 }, { value: "x", count: 2 }]);
  });

  test("releases order newest first by their deploy, else when first seen in; latest resolves through the context", () => {
    const a = g({ first_release: "old", last_release: "old", first_seen: NOW - 10 * DAY_MS });
    const b = g({ first_release: "mid", last_release: "new", first_seen: NOW - 5 * DAY_MS, last_seen: NOW - HOUR });
    const deploy: OpsEvent = { _id: "d", workspace: "team:t", source: "sdk", source_id: "s1", kind: "deploy", title: "", data: { release: "new" }, created_at: NOW - 2 * DAY_MS } as OpsEvent;
    const times = releaseTimes([a, b], [deploy]);
    expect(times.get("new")).toBe(NOW - 2 * DAY_MS);
    expect(times.get("mid")).toBe(NOW - 5 * DAY_MS);
    expect(releaseOptions([{ value: "old", count: 5 }, { value: "new", count: 1 }, { value: "mid", count: 1 }], times).map((o) => o.value)).toEqual(["new", "mid", "old"]);
    const latest = latestRelease(times, ["old", "new", "mid"]);
    expect(latest).toBe("new");
    const q = { ...DEFAULT_QUERY, lane: "all" as const, facets: { release: LATEST_RELEASE } };
    expect(filterIssues([a, b], q, { ...ctx, latestRelease: latest }, NOW)).toEqual([b]);
    expect(filterIssues([a, b], q, ctx, NOW)).toEqual([]);
  });
});

describe("what went wrong, under the title", () => {
  test("the first error in the context, else the sample's own message, never the title again", () => {
    const title = "sendkit-ramp: 1 provider write(s) failed";
    const cause = 'The "string" argument must be of type string. Received an instance of Date';
    expect(exceptionValue({ context_json: JSON.stringify({ errors: [cause] }) }, title)).toBe(cause);
    expect(exceptionValue({ context_json: JSON.stringify({ errors: [{ name: "TypeError", message: cause }] }) }, title)).toBe(`TypeError: ${cause}`);
    expect(exceptionValue({ message: "boom at write" }, title)).toBe("boom at write");
    expect(exceptionValue({ message: title }, title)).toBeNull();
    expect(exceptionValue({ context_json: "not json" }, title)).toBeNull();
    expect(sampleUsers([{ user: { email: "a@x" } }, { user: { email: "a@x" } }, { user: { id: "2" } }, {}])).toBe(2);
  });
});

describe("the query in the address", () => {
  test("round-trips, and defaults write nothing", () => {
    const q = { ...DEFAULT_QUERY, lane: "regressed" as const, q: "checkout", sort: "users" as const, facets: { level: "fatal", type: "rage_click", release: "1.2,3" } };
    const params = issueQueryParams(q);
    expect(parseIssueQuery((k) => (params as any)[k] ?? null)).toEqual(q);
    expect(Object.values(issueQueryParams(DEFAULT_QUERY)).every((v) => v === null)).toBe(true);
  });

  test("unknown values fall back to the defaults", () => {
    const q = parseIssueQuery((k) => ({ status: "weird", sort: "nope", show: "bogus:1,level:%E0" } as any)[k] ?? null);
    expect(q.status).toBe("open");
    expect(q.sort).toBe("urgency");
    expect(q.facets).toEqual({});
  });
});

describe("filter, sort and count", () => {
  test("regressed rows lead under Urgency, a column sort orders strictly by its key; counts ignore the status", () => {
    const busy = g({ count: 500, users: 40 });
    const back = g({ count: 2, users: 1, regressed_at: NOW - HOUR });
    const fresh = g({ count: 1, first_seen: NOW - HOUR, last_seen: NOW - HOUR });
    const done = g({ status: "resolved" });
    const rows = [busy, back, done];
    expect(filterIssues(rows, { ...DEFAULT_QUERY, lane: "all" }, ctx, NOW).map((r) => r._id)).toEqual([back._id, busy._id]);
    expect(filterIssues(rows, { ...DEFAULT_QUERY, lane: "all", sort: "events" }, ctx, NOW).map((r) => r._id)).toEqual([busy._id, back._id]);
    // A one-event New issue never sits above a high-impact one when sorting by Users or Events, in Open or All.
    expect(filterIssues([fresh, back, busy], { ...DEFAULT_QUERY, lane: "all", sort: "users" }, ctx, NOW)[0]._id).toBe(busy._id);
    expect(filterIssues([fresh, back, busy, done], { ...DEFAULT_QUERY, status: "all", sort: "events" }, ctx, NOW)[0]._id).toBe(busy._id);
    expect(filterIssues(rows, { ...DEFAULT_QUERY, lane: "regressed" }, ctx, NOW).map((r) => r._id)).toEqual([back._id]);
    expect(statusCounts(rows, DEFAULT_QUERY, ctx, NOW)).toEqual({ open: 2, regressed: 1, resolved: 1, ignored: 0, all: 3, attention: 1, escalating: 0, new: 0, firing: 0, flapping: 0, ongoing: 1, quiet: 0 });
  });

  test("search matches every word across title, culprit and id; facets narrow", () => {
    const a = g({ title: "Checkout failed", culprit: "cart.ts", level: "fatal", last_release: "1.2" });
    const b = g({ title: "Login failed", level: "error" });
    const all = { ...DEFAULT_QUERY, lane: "all" as const };
    expect(filterIssues([a, b], { ...all, q: "failed cart" }, ctx, NOW)).toEqual([a]);
    expect(filterIssues([a, b], { ...all, facets: { level: "error" } }, ctx, NOW)).toEqual([b]);
    expect(filterIssues([a, b], { ...all, facets: { release: "1.2" } }, ctx, NOW)).toEqual([a]);
    expect(facetOptions([a, b, g({ level: "fatal" })], "level", ctx)).toEqual([{ value: "fatal", count: 2 }, { value: "error", count: 1 }]);
  });

  test("the Level facet offers severities only; anything else a source calls a level is a type", () => {
    const rows = [g({ level: "error" }), g({ level: "rage_click" }), g({ level: "request" }), g({ level: "none" }), g()];
    expect(facetOptions(rows, "level", ctx).map((o) => o.value)).toEqual(["error"]);
    expect(facetOptions(rows, "type", ctx).map((o) => o.value)).toEqual(["rage_click", "request"]);
    expect(filterIssues(rows, { ...DEFAULT_QUERY, lane: "all", facets: { type: "rage_click" } }, ctx, NOW)).toEqual([rows[1]]);
  });

  test("trend compares the last day with the one before", () => {
    const row = g({ buckets: [{ hour: THIS_HOUR, count: 9 }, { hour: THIS_HOUR - 30 * HOUR, count: 4 }] });
    expect(trendOf(row, NOW)).toEqual({ recent: 9, prior: 4, delta: 5 });
  });

  test("a shift-click range spans the anchor and the target in list order", () => {
    expect(rangeIds(["a", "b", "c", "d"], "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeIds(["a", "b"], null, "b")).toEqual(["b"]);
  });
});

describe("the occurrence chart", () => {
  test("places bars, ticks and the group's own marks and its source's deploys", () => {
    const row = g({ buckets: [{ hour: THIS_HOUR, count: 3 }] });
    const events: OpsEvent[] = [
      { _id: "1", workspace: "team:t", source: "sdk", kind: "deploy", title: "", source_id: "s1", data: { release: "v2" }, created_at: NOW - 6 * HOUR },
      { _id: "2", workspace: "team:t", source: "sdk", kind: "deploy", title: "", source_id: "other", created_at: NOW - 5 * HOUR },
      { _id: "3", workspace: "team:t", source: "sdk", kind: "error_regressed", title: "", group_id: row._id, data: { transition: "regressed" }, created_at: NOW - 2 * HOUR },
    ];
    const l = layoutChart(row, events, NOW, 24);
    expect(l.bars).toHaveLength(24);
    expect(l.bars[23]).toEqual({ at: THIS_HOUR, count: 3 });
    expect(l.max).toBe(3);
    // The deploy before the regression is the one it came back in: a full line.
    expect(l.marks.map((m) => m.tone)).toEqual(["release", "regressed"]);
    expect(l.deployTicks).toEqual([]);
    expect(l.lastDeploy).toBe(NOW - 6 * HOUR);
    expect(l.ticks.every((t) => t.x >= 0 && t.x <= 1)).toBe(true);
  });
});

describe("samples", () => {
  const s = (over: Partial<OpsSample>): OpsSample => ({ _id: String(++n), group_id: "g", source_id: "s1", at: NOW, ...over });

  test("the tag breakdown counts each key's values with their share, preferred keys first", () => {
    const facets = sampleFacets([
      s({ environment: "prod", tags_json: JSON.stringify({ browser: "Chrome", zz: "1" }) }),
      s({ environment: "prod", tags_json: JSON.stringify({ browser: "Safari" }) }),
      s({ environment: "staging", tags_json: JSON.stringify({ browser: "Chrome" }) }),
    ]);
    expect(facets.map((f) => f.key)).toEqual(["browser", "environment", "zz"]);
    expect(facets[0].values[0]).toEqual({ value: "Chrome", count: 2, share: 2 / 3 });
  });

  test("a sample's moment in its replay is clamped into the recording", () => {
    expect(replayOffset(NOW, { started_at: NOW - 137_000, duration_ms: 223_000 })).toBe(137_000);
    expect(replayOffset(NOW, { started_at: NOW - 500_000, duration_ms: 223_000 })).toBe(223_000);
    expect(replayOffset(NOW, { started_at: NOW + 5000, duration_ms: 1000 })).toBe(0);
    expect(replayOffset(NOW, null)).toBeNull();
  });
});

describe("stack rows", () => {
  test("library runs fold in place, the product's frames stay one by one", () => {
    const stack = [
      "TypeError: x is undefined",
      "    at render (/app/src/cart.ts:12:5)",
      "    at a (/app/node_modules/react/index.js:1:1)",
      "    at b (/app/node_modules/react/index.js:2:1)",
      "    at main (/app/dist/server.js:201456:20)",
      "    at c (node:internal/x:1:1)",
    ].join("\n");
    const rows = stackRows(stack);
    expect(rows.map((r) => r.type)).toEqual(["message", "frame", "library", "frame", "frame"]);
    const lib = rows[2];
    expect(lib.type === "library" && lib.frames.length).toBe(2);
    const main = rows[3];
    expect(main.type === "frame" && main.minified && main.line === 201456 && main.col === 20).toBe(true);
    expect(leadFrame(rows)).toBe(0);
  });
});

describe("the fix review", () => {
  const { issueFixLedger, folderName } = require("./issueFix") as typeof import("./issueFix");
  const base = { refs: ["eg-1"], title: "Checkout failed", project: "shop", task: "ct-9", running: 0, prompt: "Investigate\n\nRead eg-1", showPrompt: false, togglePrompt: () => {} };

  test("names the folder, the task it binds to and the issue, and starts one session", () => {
    const l = issueFixLedger(base);
    expect(l.subject).toBe("eg-1 · Checkout failed");
    expect(l.figures[0]).toEqual({ value: "1", label: "session starts now" });
    const rows = Object.fromEntries(l.rows.map((r) => [r.k, r.v]));
    expect(rows.Folder).toBe("shop");
    expect(rows["Works on"]).toBe("ct-9");
    expect(l.rows.find((r) => r.k === "Seeded with")?.list).toBeUndefined();
    expect(l.alert).toBeUndefined();
  });

  test("shows the prompt on demand, warns on a running fix, and reads a selection", () => {
    expect(issueFixLedger({ ...base, showPrompt: true }).rows.find((r) => r.k === "Seeded with")?.list).toEqual(["Investigate", "Read eg-1"]);
    expect(issueFixLedger({ ...base, running: 1 }).alert).toBe("A fix is already running on it");
    const many = issueFixLedger({ ...base, refs: ["eg-1", "eg-2", "eg-3", "eg-4"], task: null, project: null, running: 2 });
    expect(many.subject).toBe("4 issues · eg-1, eg-2, eg-3…");
    expect(many.alert).toBe("2 already have a fix running");
    expect(many.rows.find((r) => r.k === "Folder")?.tone).toBe("warn");
  });

  test("a folder reads as its project's title, else its last part", () => {
    expect(folderName("/src/shop/", "Shop")).toBe("Shop");
    expect(folderName("/src/shop/", null)).toBe("shop");
    expect(folderName(undefined)).toBeNull();
  });
});

describe("issue nav", () => {
  const nav = require("./issueNav") as typeof import("./issueNav");
  test("walks the remembered list, else the fallback", () => {
    nav.rememberIssueList(["eg-3", "eg-1", "eg-2"], "/flows?view=signals&sig=issues&status=regressed");
    expect(nav.issueStep("eg-1", 1, [])).toBe("eg-2");
    expect(nav.issueStep("eg-3", -1, [])).toBeNull();
    expect(nav.issueStep("eg-9", 1, ["eg-9", "eg-8"])).toBe("eg-8");
    expect(nav.issueListBack()).toContain("status=regressed");
  });
});

describe("the fix plan", () => {
  test("an awake session on the task is the fix in progress; another agent is only offered beside it", () => {
    expect(fixPlan({}, "filed", [{ id: "c1", awake: false, known: true }, { id: "c2", awake: true, known: true }])).toEqual({ live: "c2", primary: "open", canStartAnother: true });
  });
  test("sessions on a task that are not running do not read as a fix", () => {
    expect(fixPlan({}, "review", [{ id: "c1", awake: false, known: true }])).toEqual({ live: null, primary: "start", canStartAnother: false });
  });
  test("the session started from the issue counts unless this device sees it settled", () => {
    expect(fixPlan({ fix_conversation_id: "c9" }, "fixing", []).live).toBe("c9");
    expect(fixPlan({ fix_conversation_id: "c9" }, "fixing", [{ id: "c9", awake: false, known: true }])).toEqual({ live: "c9", primary: "continue", canStartAnother: true });
  });
  test("a stopped fix session is continued, never started beside, on every surface's label", () => {
    expect(fixActionLabel("continue", "ct-1", false)).toBe("Continue fix");
    expect(fixPlan({ fix_conversation_id: "c9", status: "resolved" }, "fixing", [{ id: "c9", awake: false, known: true }]).primary).toBeNull();
  });
  test("a dropped problem leads with refile, a shipped one with nothing", () => {
    expect(fixPlan({}, "dropped", []).primary).toBe("refile");
    expect(fixPlan({ fix_conversation_id: "c" }, "shipped", []).primary).toBeNull();
  });
});

describe("counts the badge and the list share", () => {
  test("open counts open, regressed and checks currently fine, narrowed to a source", () => {
    const rows = [g(), g({ regressed_at: NOW, resolved_at: NOW - HOUR }), g({ kind: "check", meta: { ok: true } }), g({ status: "resolved" }), g({ status: "ignored" }), g({ source_id: "s2" })];
    expect(openIssueCount(rows, null)).toBe(4);
    expect(openIssueCount(rows, "s1")).toBe(3);
    expect(openIssueCount(rows, null)).toBe(statusCounts(rows, DEFAULT_QUERY, ctx).open);
  });
  test("users are counted only when some row has people", () => {
    expect(usersCounted([g(), g({ users: 0 })])).toBe(false);
    expect(usersCounted([g(), g({ users: 2 })])).toBe(true);
  });
});

describe("the y axis", () => {
  test("whole numbers, each once", () => {
    expect(yTicks(1).ticks.map((t) => t.value)).toEqual([1, 0]);
    expect(yTicks(0).ticks.map((t) => t.value)).toEqual([1, 0]);
    expect(yTicks(2).ticks.map((t) => t.value)).toEqual([2, 1, 0]);
    expect(yTicks(3).ticks.map((t) => t.value)).toEqual([3, 0]);
    expect(yTicks(7)).toEqual({ top: 10, ticks: [{ value: 10, y: 0 }, { value: 5, y: 0.5 }, { value: 0, y: 1 }] });
    expect(yTicks(130).top).toBe(200);
  });
});

describe("a check's state over time", () => {
  const ev = (row: OpsGroup, transition: string, at: number): OpsEvent => ({ _id: `${transition}${at}`, workspace: "team:t", source: "github", kind: transition, title: "", group_id: row._id, data: { transition: transition as any }, created_at: at });
  test("spans from flips, the current reading at the end, nothing before first seen", () => {
    const row = g({ kind: "check", first_seen: NOW - 20 * HOUR, meta: { ok: false } });
    const s = healthStrip(row, [ev(row, "check_failed", NOW - 20 * HOUR), ev(row, "check_recovered", NOW - 10 * HOUR), ev(row, "check_failed", NOW - 4 * HOUR)], NOW, 24);
    expect(s.spans.map((x) => x.state)).toEqual(["none", "failing", "passing", "failing"]);
    expect(s.failingSince).toBe(NOW - 4 * HOUR);
    expect(s.lastPass).toBe(NOW - 10 * HOUR);
    expect(s.failures).toBe(2);
    expect(Math.round(s.failingShare * 100)).toBe(70);
  });
  test("with no flips read, a failing check has failed since it was first seen", () => {
    const row = g({ kind: "check", first_seen: NOW - 30 * HOUR, meta: { ok: false } });
    const s = healthStrip(row, [], NOW, 24);
    expect(s.spans).toEqual([{ from: NOW - 24 * HOUR, to: NOW, state: "failing" }]);
    expect(s.failingSince).toBe(row.first_seen);
    expect(s.lastPass).toBeNull();
  });
  test("a passing check reads passing to now", () => {
    const row = g({ kind: "check", first_seen: NOW - 30 * HOUR, meta: { ok: true } });
    const s = healthStrip(row, [ev(row, "check_recovered", NOW - 2 * HOUR)], NOW, 24);
    expect(s.spans.map((x) => x.state)).toEqual(["failing", "passing"]);
    expect(s.failingSince).toBeNull();
  });
});

describe("an issue's life", () => {
  test("starts at first seen in its release and carries its flips and deploys", () => {
    const row = g({ first_seen: NOW - 10 * 24 * HOUR, first_release: "v1" });
    const events: OpsEvent[] = [
      { _id: "d", workspace: "team:t", source: "sdk", kind: "deploy", title: "", source_id: "s1", data: { release: "v2" }, created_at: NOW - 5 * 24 * HOUR },
      { _id: "r", workspace: "team:t", source: "sdk", kind: "error_resolved", title: "", group_id: row._id, data: { transition: "resolved" }, created_at: NOW - 4 * 24 * HOUR },
    ];
    const life = lifeMarks(row, events, NOW);
    expect(life.clipped).toBe(false);
    expect(life.marks.map((m) => m.label)).toEqual(["first seen in v1", "v2", "resolved"]);
    expect(life.marks[0].x).toBe(0);
    expect(lifeMarks(g({ first_seen: NOW - 200 * 24 * HOUR }), [], NOW).clipped).toBe(true);
  });
});

describe("regressions of checks and metrics", () => {
  test("a check failing again after its recovery is regressed, dated by the failure", () => {
    const back = g({ kind: "check", status: "open", meta: { ok: false }, resolved_at: NOW - 8 * DAY_MS, last_transition: "check_failed", last_transition_at: NOW - 4 * DAY_MS });
    expect(issueState(back)).toBe("regressed");
    expect(regressedAt(back)).toBe(NOW - 4 * DAY_MS);
    // Never recovered: open, not regressed. Passing now: watched.
    expect(issueState(g({ kind: "check", meta: { ok: false }, last_transition: "check_failed", last_transition_at: NOW - DAY_MS }))).toBe("open");
    expect(issueState(g({ kind: "check", meta: { ok: true }, resolved_at: NOW - DAY_MS }))).toBe("ok");
  });
});

describe("the fix read against the occurrences", () => {
  const task = (over: Partial<FixTask>): FixTask => ({ status: "done", ...over });
  test("a landed fix that stayed quiet shipped; one that fired after it is recurring", () => {
    const landed = task({ landed: { sha: "9f2c1a0aa", at: NOW - 3 * DAY_MS } });
    expect(fixStage(g({ signal_task_id: "t", last_seen: NOW - 4 * DAY_MS }), landed)).toBe("shipped");
    expect(fixStage(g({ signal_task_id: "t", last_seen: NOW - HOUR }), landed)).toBe("recurring");
    expect(fixClose(g({ signal_task_id: "t" }), landed)).toEqual({ how: "landed", at: NOW - 3 * DAY_MS, sha: "9f2c1a0aa", url: undefined });
  });
  test("closed with no change is closed, not shipped; a dissolved task is dropped whatever its status", () => {
    expect(fixStage(g({ signal_task_id: "t", last_seen: NOW - 5 * DAY_MS }), task({ closed_at: NOW - 4 * DAY_MS }))).toBe("closed");
    expect(fixStage(g({ signal_task_id: "t" }), task({ closed_at: NOW - 4 * DAY_MS, cause: { dissolved: { at: NOW - 4 * DAY_MS } } }))).toBe("dropped");
  });
  test("a check resolved by its fix and failing again is recurring", () => {
    const check = g({ kind: "check", signal_task_id: "t", meta: { ok: false }, resolved_at: NOW - 8 * DAY_MS, last_seen: NOW - HOUR });
    expect(fixStage(check, task({ closed_at: NOW - 8 * DAY_MS }))).toBe("recurring");
    expect(fixPlan(check, "recurring", []).primary).toBe("followup");
  });
  test("an open issue whose fix held leads with resolve", () => {
    expect(fixPlan({ status: "open" }, "shipped", []).primary).toBe("resolve");
    expect(fixPlan({ status: "resolved" }, "shipped", []).primary).toBeNull();
  });
  test("occurrences since a moment come from the hours while they reach, then the days, else unknown", () => {
    const row = g({ last_seen: NOW - HOUR, buckets: [{ hour: THIS_HOUR - 2 * HOUR, count: 4 }, { hour: THIS_HOUR - 30 * HOUR, count: 7 }], days: [{ day: Date.UTC(2026, 9, 30), count: 20 }] });
    expect(occurrencesSince(row, THIS_HOUR - 5 * HOUR, NOW)).toEqual({ n: 4, exact: true });
    expect(occurrencesSince(row, NOW - 5 * DAY_MS, NOW)).toEqual({ n: null, exact: false });
    expect(occurrencesSince(row, Date.UTC(2026, 9, 30), NOW)).toEqual({ n: 20, exact: true });
    // A moment inside a day that held some: that day is left out and the rest is a floor.
    expect(occurrencesSince(row, Date.UTC(2026, 9, 30, 6), NOW)).toEqual({ n: 1, exact: false });
    expect(occurrencesSince(row, NOW, NOW)).toEqual({ n: 0, exact: true });
  });
  test("a task filed for another quoted thing does not match the issue", () => {
    expect(taskMatchesIssue('Rage click on button "What counts as a transaction?" on /pricing', 'Rage click on button "What if the introduction leads nowhere?" on /pricing')).toBe(false);
    expect(taskMatchesIssue("[signal] TypeError: x is undefined in cart.ts", "TypeError: x is undefined")).toBe(true);
    expect(taskMatchesIssue("E2E Tests failing on union-mobile main", "E2E Tests on union-mobile main")).toBe(true);
    expect(taskMatchesIssue("Checkout button does nothing", "Database pool exhausted")).toBe(false);
  });
});

describe("lanes", () => {
  test("new, escalating, ongoing and quiet; attention gathers the first three with regressed", () => {
    const fresh = g({ first_seen: NOW - 2 * HOUR });
    const hot = g({ first_seen: NOW - 10 * DAY_MS, buckets: [{ hour: THIS_HOUR, count: 30 }, { hour: THIS_HOUR - 40 * HOUR, count: 2 }] });
    const steady = g({ first_seen: NOW - 10 * DAY_MS, last_seen: NOW - DAY_MS });
    const asleep = g({ first_seen: NOW - 20 * DAY_MS, last_seen: NOW - 5 * DAY_MS });
    expect([fresh, hot, steady, asleep].map((r) => issueLane(r, NOW))).toEqual(["new", "escalating", "ongoing", "quiet"]);
    expect(issueLane(g({ status: "resolved" }), NOW)).toBeNull();
    const counts = statusCounts([fresh, hot, steady, asleep], DEFAULT_QUERY, ctx, NOW);
    expect([counts.attention, counts.new, counts.escalating, counts.ongoing, counts.quiet, counts.open]).toEqual([2, 1, 1, 1, 1, 4]);
    expect(filterIssues([asleep, steady, fresh, hot], DEFAULT_QUERY, ctx, NOW)).toEqual([hot, fresh]);
  });
  test("an old link's status=regressed opens the regressed lane", () => {
    const q = parseIssueQuery((k) => (k === "status" ? "regressed" : null));
    expect([q.status, q.lane]).toEqual(["open", "regressed"]);
  });
});

describe("the chart over days", () => {
  test("opens on the narrowest window holding the last occurrence", () => {
    expect(chartRangeFor(g({ last_seen: NOW - HOUR }), NOW)).toBe("24h");
    expect(chartRangeFor(g({ last_seen: NOW - 5 * DAY_MS }), NOW)).toBe("7d");
    expect(chartRangeFor(g({ last_seen: NOW - 20 * DAY_MS }), NOW)).toBe("30d");
    expect(chartRangeFor(g({ last_seen: NOW - 200 * DAY_MS }), NOW)).toBe("90d");
  });
  test("daily bars take the days and the hours, and days before the counts reach back are unknown", () => {
    const today = Date.UTC(2026, 10, 3);
    const row = g({ first_seen: NOW - 30 * DAY_MS, buckets: [{ hour: THIS_HOUR, count: 2 }], days: [{ day: today - 2 * DAY_MS, count: 5 }] });
    const bars = dailySeries(row, NOW, 7);
    expect(bars.map((b) => b.count)).toEqual([0, 0, 0, 0, 5, 0, 2]);
    expect(bars.map((b) => !!b.unknown)).toEqual([true, true, true, false, false, false, false]);
    const l = layoutChart(row, [], NOW, 7 * 24, { at: today - DAY_MS, label: "fix 9f2c1a0" });
    expect(l.bars).toHaveLength(7);
    expect(l.total).toBe(7);
    expect(l.marks.map((m) => m.tone)).toEqual(["fix"]);
  });
  test("marks too close to read both keep one label, a transition over a deploy", () => {
    const thinned = thinMarks([
      { x: 0.5, at: 1, label: "46fd25fd7", tone: "release" },
      { x: 0.52, at: 2, label: "238fc50", tone: "release" },
      { x: 0.55, at: 3, label: "regressed", tone: "regressed" },
      { x: 0.9, at: 4, label: "v3", tone: "release" },
    ]);
    expect(thinned.map((m) => m.label)).toEqual(["", "", "regressed", "v3"]);
  });
});

describe("tags and activity", () => {
  const s = (over: Partial<OpsSample>): OpsSample => ({ _id: String(++n), group_id: "g", source_id: "s1", at: NOW, ...over });
  test("a tag whose every sample differs reads as a count of distinct values", () => {
    const facets = sampleFacets([1, 2, 3, 4, 5].map((i) => s({ url: `https://ci.example.com/run/${i}`, environment: "prod" })));
    const url = facets.find((f) => f.key === "url")!;
    expect([url.spread, url.distinct]).toEqual([true, 5]);
    expect(facets.find((f) => f.key === "environment")!.spread).toBe(false);
  });
  test("a regression's implied resolve, the fix session and the task's close join the transitions", () => {
    const row = g({ first_seen: NOW - 20 * DAY_MS, resolved_at: NOW - 11 * DAY_MS, fix_conversation_id: "c1", fix_started_at: NOW - 12 * DAY_MS });
    const ev: OpsEvent = { _id: "e", workspace: "team:t", source: "sdk", kind: "error_regressed", title: "", group_id: row._id, data: { transition: "regressed" }, created_at: NOW - 2 * DAY_MS };
    const items = issueActivity(row, [ev], { status: "done", short_id: "ct-1", landed: { sha: "abc1234ff", at: NOW - 11.5 * DAY_MS } });
    expect(items.map((i) => i.what)).toEqual(["regressed", "resolved", "fix landed", "fix session started", "first seen"]);
  });
});

describe("triage and its undo", () => {
  const { triageStep } = require("./issueUndo") as typeof import("./issueUndo");
  test("keeps each changed row's status and resolve stamps, and names what changed", () => {
    const a = g({ short_id: "eg-1", regressed_at: NOW - HOUR, resolved_at: NOW - DAY_MS, resolved_in: "v2" });
    const b = g({ short_id: "eg-2", status: "resolved" });
    expect(triageStep([a, b], "resolved")).toEqual({ status: "resolved", label: "eg-1 resolved", rows: [{ id: a._id, status: "open", resolved_at: NOW - DAY_MS, resolved_in: "v2" }] });
    expect(triageStep([a, g()], "ignored")!.label).toBe("2 issues ignored");
    expect(triageStep([b], "resolved")).toBeNull();
  });
});

describe("round 5: flapping, owners, activity, what broke it", () => {
  const {
    isFlapping,
    queryAdmits,
    ciRuns,
    ciBreak,
    suspectSha,
    commitMessageParts,
    issueOwner,
  } = require("./issuesModel") as typeof import("./issuesModel");

  test("a monitor that recovered on its own still counts as flapping, and the lane holds it", () => {
    const flapper = g({ kind: "metric", status: "resolved", meta: { ok: true }, resolved_at: NOW - HOUR, failed_at: [NOW - 3 * DAY_MS, NOW - 2 * DAY_MS, NOW - DAY_MS, NOW - 2 * HOUR] });
    expect(isFlapping(flapper, failuresIn(flapper, [], NOW))).toBe(true);
    expect(isFlapping({ ...flapper, status: "muted" }, 4)).toBe(false);
    expect(issueLane(flapper, NOW)).toBeNull();
    const counts = statusCounts([flapper, g()], DEFAULT_QUERY, ctx, NOW);
    expect(counts.flapping).toBe(1);
    expect(counts.resolved).toBe(1);
    expect(queryAdmits({ status: "open", lane: "flapping" }, flapper, NOW)).toBe(true);
    expect(queryAdmits({ status: "open", lane: "all" }, flapper, NOW)).toBe(false);
  });

  test("Mine keeps the issues whose problem task the viewer answers for", () => {
    const mine = g({ signal_task_id: "t1" });
    const theirs = g({ signal_task_id: "t2" });
    const tasks: Record<string, FixTask> = { t1: { status: "open", assignee: "u1" }, t2: { status: "open", assignee: "u2" } };
    const c: IssueCtx = { taskStatus: (id) => tasks[id], me: "u1" };
    expect(issueOwner(mine, c)).toBe("u1");
    const q = { ...DEFAULT_QUERY, lane: "all" as const, mine: true };
    expect(filterIssues([mine, theirs, g()], q, c, NOW)).toEqual([mine]);
    expect(issueQueryParams(q).show).toBe("mine:1");
    expect(parseIssueQuery((k) => (k === "show" ? "level:error,mine:1" : null))).toMatchObject({ mine: true, facets: { level: "error" } });
  });

  test("a settled issue's Fix card leads with nothing", () => {
    expect(fixPlan({ status: "resolved" }, "none", []).primary).toBeNull();
    expect(fixPlan({ status: "resolved" }, "dropped", []).primary).toBeNull();
    expect(fixPlan({ status: "open" }, "dropped", []).primary).toBe("refile");
  });

  test("repeated steps fold with a count, and the latest resolve names its resolver", () => {
    const row = g({ resolved_at: NOW - DAY_MS, resolved_via: "person", resolved_by: "u1" });
    const ev = (at: number, transition: string, release?: string): OpsEvent => ({ _id: `${at}${transition}`, workspace: "team:t", source: "sdk", kind: "error", title: "", group_id: row._id, data: { transition, release }, created_at: at });
    const items = issueActivity(row, [ev(NOW - HOUR, "spike", "83b1328"), ev(NOW - HOUR + 1000, "spike", "83b1328"), ev(NOW - DAY_MS, "resolved")], null);
    expect(items[0]).toMatchObject({ what: "spiked", n: 2, release: "83b1328" });
    expect(items[1]).toMatchObject({ what: "resolved", resolver: { via: "person", by: "u1" } });
  });

  test("CI runs read their commit, and the break sits between the last pass and the first failure", () => {
    const run = (at: number, conclusion: string, sha: string) => ({ at, message: `E2E Tests ${conclusion} at ${sha.slice(0, 7)}`, context_json: JSON.stringify({ sha, run_id: String(at) }) });
    const runs = ciRuns([run(NOW - 3 * HOUR, "failure", "ccc0000aaa"), run(NOW - HOUR, "failure", "ddd0000aaa"), run(NOW - 5 * HOUR, "success", "bbb0000aaa"), run(NOW - 9 * HOUR, "failure", "aaa0000aaa")]);
    expect(runs.map((r) => r.ok)).toEqual([false, false, true, false]);
    const brk = ciBreak(runs)!;
    expect([brk.firstFail.sha, brk.lastPass?.sha]).toEqual(["ccc0000aaa", "bbb0000aaa"]);
    expect(ciBreak([runs[2]])).toBeNull();
  });

  test("the suspect is the release a regression came back in, else where it was first seen", () => {
    expect(suspectSha({ first_release: "d1ee1d165", status: "open", regressed_at: NOW, resolved_at: NOW - DAY_MS, regressed_in: "83B1328" })).toEqual({ sha: "83b1328", why: "regressed" });
    expect(suspectSha({ first_release: "d1ee1d165" })).toEqual({ sha: "d1ee1d165", why: "first" });
    expect(suspectSha({ first_release: "1.4.2" })).toBeNull();
  });

  test("a commit message's task and pull request ids split out", () => {
    expect(commitMessageParts("feat(calls): x (ct-75168) (#3966)\nbody")).toEqual([
      { t: "text", v: "feat(calls): x (" },
      { t: "task", v: "ct-75168" },
      { t: "text", v: ")" },
    ]);
    // The pull request a pill beside the subject names is left out of it, so its parentheses never wrap a pill.
    expect(commitMessageParts("fix(ci): main reds after the batch (#3839)")).toEqual([{ t: "text", v: "fix(ci): main reds after the batch" }]);
    const { squashPr } = require("./issuesModel") as typeof import("./issuesModel");
    expect(squashPr("fix(ci): main reds (#3839)\nbody")).toBe(3839);
    expect(squashPr("fix: see #12 for why")).toBeNull();
  });
});

describe("round 6: what broke a check, one fix verdict, readings, what drives an alert", () => {
  const { ciRuns, ciBreak, creditedTask, stripTicks, readingRows, foldReadings, metricContributors } = require("./issuesModel") as typeof import("./issuesModel");
  const run = (at: number, conclusion: string, sha: string, branch = "main") => ({ at, message: `E2E Tests ${conclusion} at ${sha.slice(0, 7)}`, url: `https://x/${at}`, context_json: JSON.stringify({ sha, run_id: String(at), branch }) });

  test("the suspect is the run that flipped the check, on the newest run's branch, never an older sample", () => {
    const runs = ciRuns([run(NOW - HOUR, "failure", "ddd0000aaa"), run(NOW - 4 * DAY_MS, "failure", "ccc0000aaa"), run(NOW - 5 * DAY_MS, "failure", "bbb0000aaa"), run(NOW - 27 * DAY_MS, "failure", "f920953aaa", "desk/polish")]);
    const brk = ciBreak(runs, { failingSince: NOW - 4 * DAY_MS })!;
    expect(brk.branch).toBe("main");
    expect(brk.firstFail?.sha).toBe("ccc0000aaa");
    // The flip was not kept and no pass is on record: unknown, not the oldest sample.
    const lost = ciBreak(runs, { failingSince: NOW - 9 * DAY_MS })!;
    expect(lost.firstFail).toBeNull();
    expect(lost.lastPass).toBeNull();
  });

  test("a recorded last pass names the last green, and finds the first red only when the kept runs reach back past it", () => {
    const runs = ciRuns([run(NOW - HOUR, "failure", "ddd0000aaa"), run(NOW - 3 * HOUR, "failure", "ccc0000aaa"), run(NOW - 9 * HOUR, "failure", "aaa0000aaa")]);
    const brk = ciBreak(runs, { lastOk: { at: NOW - 5 * HOUR, sha: "bbb0000aaa", branch: "main" } })!;
    expect([brk.firstFail?.sha, brk.lastPass?.sha]).toEqual(["ccc0000aaa", "bbb0000aaa"]);
    const short = ciBreak(runs.slice(0, 2), { lastOk: { at: NOW - 5 * HOUR, sha: "bbb0000aaa" } })!;
    expect(short.firstFail).toBeNull();
    expect(short.lastPass?.sha).toBe("bbb0000aaa");
  });

  test("an app check's words are not CI runs", () => {
    expect(ciRuns([{ at: NOW, message: "OpenRouter credit $209, 3.3 days left" }, { at: NOW, message: "Orphan calls found" }])).toEqual([]);
  });

  test("last green is the flip that ended the passing run, not the recovery before it", () => {
    const row = g({ kind: "check", first_seen: NOW - 9 * DAY_MS, meta: { ok: false } });
    const ev = (transition: string, at: number): OpsEvent => ({ _id: `${transition}${at}`, workspace: "team:t", source: "app", kind: transition, title: "", group_id: row._id, data: { transition: transition as any }, created_at: at });
    const s = healthStrip(row, [ev("check_failed", NOW - 7 * DAY_MS), ev("check_recovered", NOW - 5 * DAY_MS), ev("check_failed", NOW - 14 * HOUR)], NOW, 24 * 7);
    expect(s.failingSince).toBe(NOW - 14 * HOUR);
    expect(s.lastPass).toBe(NOW - 5 * DAY_MS);
    expect(s.lastGreen).toBe(NOW - 14 * HOUR);
    expect(s.failures).toBe(2);
    expect(healthStrip({ ...row, meta: { ok: false, last_ok_at: NOW - 15 * HOUR } }, [ev("check_failed", NOW - 14 * HOUR)], NOW, 24).lastGreen).toBe(NOW - 15 * HOUR);
  });

  test("strip ticks sit on midnights a day apart across a week", () => {
    const start = NOW - 7 * DAY_MS;
    const ticks = stripTicks(start, NOW, 24 * 7);
    expect(ticks.length).toBeGreaterThanOrEqual(6);
    for (const t of ticks) expect(new Date(t.at).getHours()).toBe(0);
    const gaps = ticks.slice(1).map((t, i) => Math.round((t.x - ticks[i].x) * 1000));
    expect(new Set(gaps).size).toBeLessThanOrEqual(2);
  });

  test("a task filed for another title is credited with nothing, and a commit on a task in review closes nothing", () => {
    const group = g({ title: "OpenRouter Credit Runway", signal_task_id: "t", status: "open", resolved_at: NOW - 5 * DAY_MS, kind: "check", meta: { ok: false } });
    const other: FixTask = { title: "Broker candidate_score_ready trigger fires while a circuit is open", status: "in_review", landed: { sha: "9d6ae645d", at: NOW - 8 * DAY_MS } };
    expect(creditedTask(group, other)).toBeUndefined();
    expect(fixStage(group, creditedTask(group, other))).toBe("filed");
    const own: FixTask = { ...other, title: "OpenRouter credit runway below a day" };
    expect(creditedTask(group, own)).toBe(own);
    expect(fixClose(group, own)).toBeNull();
    expect(fixStage(group, own)).toBe("review");
    expect(fixClose(group, { ...own, status: "done" })).toMatchObject({ how: "landed", sha: "9d6ae645d" });
  });

  test("metric readings carry their value against the line, and alike readings fold", () => {
    const s = (at: number, v: number) => ({ _id: `s${at}`, at, message: `Exceptions (24h) = ${v} (alerts above 15)` });
    const rows = readingRows({ kind: "metric", title: "Exceptions (24h) above 15" }, [s(NOW - 2 * HOUR, 112), s(NOW - HOUR, 112), s(NOW, 9)], { threshold: 15, direction: "above" });
    expect(rows.map((r) => [r.value, r.failing])).toEqual([[9, false], [112, true], [112, true]]);
    expect(foldReadings(rows).map((r) => r.n)).toEqual([1, 2]);
    const check = readingRows({ kind: "check", title: "Credit" }, [{ _id: "a", at: NOW, message: "credit $209, 3.3 days at $63/day" }]);
    expect(check[0]).toMatchObject({ text: "credit $209, 3.3 days at $63/day", failing: true, value: null });
  });

  test("an alert's contributors carry shares only from its own source; other sources are context", () => {
    const alert = g({ kind: "metric", source_id: "ph" });
    const hot = g({ source_id: "ph", last_seen: NOW - HOUR, buckets: [{ hour: THIS_HOUR - 2 * HOUR, count: 30 }] });
    const warm = g({ source_id: "ph", last_seen: NOW - HOUR, buckets: [{ hour: THIS_HOUR - 3 * HOUR, count: 10 }] });
    const elsewhere = g({ source_id: "other", last_seen: NOW - HOUR, buckets: [{ hour: THIS_HOUR - 2 * HOUR, count: 99 }] });
    const old = g({ source_id: "ph", last_seen: NOW - 3 * DAY_MS });
    const out = metricContributors(alert, [alert, hot, warm, elsewhere, old], NOW - DAY_MS, NOW);
    expect(out.rows.map((r) => [r.group._id, r.n])).toEqual([[hot._id, 30], [warm._id, 10]]);
    expect(out.rows[0].share).toBe(0.75);
    expect(out.others.map((r) => [r.group._id, r.share])).toEqual([[elsewhere._id, 0]]);
    const lone = metricContributors(g({ kind: "metric", source_id: "none" }), [elsewhere], NOW - DAY_MS, NOW);
    expect(lone.rows).toEqual([]);
    expect(lone.total).toBe(0);
  });

  test("a HogQL count splits by what it counted, each part a share of the value and matched to its issue", () => {
    const { hogqlBreakdown, breakdownRows } = require("./issuesModel") as typeof import("./issuesModel");
    const q = hogqlBreakdown("select count() from events where event = '$exception' and timestamp > now() - interval 1 day");
    expect(q).toContain("JSONExtractString(properties.$exception_values, 1)");
    expect(q).toContain("where event = '$exception' and timestamp > now() - interval 1 day group by k order by n desc limit 8");
    expect(hogqlBreakdown("select count() from events where event = 'signup'")).toContain("select event as k");
    expect(hogqlBreakdown("select count() from events where 1 group by event")).toBeNull();
    expect(hogqlBreakdown("select avg(x) from events where 1")).toBeNull();
    const named = g({ kind: "error", title: "Error: ResizeObserver loop completed with undelivered notifications." });
    const rows = breakdownRows([["Error: ResizeObserver loop completed with undelivered notifications.", 81], ["TypeError: x is undefined", 27], ["bad"]], [named]);
    expect(rows.map((r) => [r.n, r.share, r.group?._id ?? null])).toEqual([[81, 0.75, named._id], [27, 0.25, null]]);
  });

  test("a task filed for another issue is its own stage, never Filed", () => {
    const { taskFixStage } = require("./issuesModel") as typeof import("./issuesModel");
    const group = g({ kind: "check", title: "E2E Tests on union-ai/union-mobile main", signal_task_id: "t1" });
    const other = { title: "landing-units job fails on cockpitWave3", status: "done", cause: { dissolved: { at: NOW - DAY_MS } } };
    expect(taskFixStage(group, other)).toBe("other");
    expect(taskFixStage({ ...group, fix_conversation_id: "c1" }, other)).toBe("fixing");
    expect(taskFixStage(group, { title: "E2E Tests failing on union-mobile main", status: "in_review" })).toBe("review");
    expect(taskFixStage(group, "in_review")).toBe("review");
  });
});

describe("the fix's sessions", () => {
  const { orderFixSessions } = require("./issuesModel") as typeof import("./issuesModel");
  test("working and shipped lead, then newest; the rest fold", () => {
    const s = [
      { id: "a", awake: false, known: true, at: NOW - 3 * DAY_MS },
      { id: "b", awake: false, known: true, at: NOW - 2 * DAY_MS },
      { id: "c", awake: true, known: true, at: NOW - HOUR },
      { id: "d", awake: false, known: true, at: NOW - 6 * DAY_MS },
    ];
    const out = orderFixSessions(s, "d");
    expect(out.ordered.map((x) => x.id)).toEqual(["c", "d", "b", "a"]);
    expect(out.lead.map((x) => x.id)).toEqual(["c", "d"]);
    expect(orderFixSessions(s, null).lead.map((x) => x.id)).toEqual(["c", "b"]);
  });
});

describe("issueTotals", () => {
  const rows = [g({ status: "open" }), g({ status: "open", source_id: "s2" }), g({ status: "resolved" }), g({ status: "muted" })];
  test("the store's rows while the open feeder is not full", () => {
    expect(issueTotals(rows, [], null, false)).toEqual({ open: 2, resolved: 1, ignored: 1, all: 4, exact: true });
  });
  test("a floor past a full feeder until every source is counted", () => {
    const t = issueTotals(rows, [{ _id: "s1", groups_open: 9, group_counts: { open: 9, resolved: 3, ignored: 1 } }, { _id: "s2", groups_open: 4 }], null, true);
    expect(t.exact).toBe(false);
    expect(t.open).toBe(2);
  });
  test("the sources' counts once counted; their live open count wins over the recount", () => {
    const sources = [{ _id: "s1", groups_open: 10, group_counts: { open: 9, resolved: 3, ignored: 1 } }, { _id: "s2", groups_open: 4, group_counts: { open: 4, resolved: 0, ignored: 0 } }];
    expect(issueTotals(rows, sources, null, true)).toEqual({ open: 14, resolved: 3, ignored: 1, all: 18, exact: true });
    expect(issueTotals(rows, sources, "s2", true)).toEqual({ open: 4, resolved: 0, ignored: 0, all: 4, exact: true });
  });
});

describe("withTotals", () => {
  const counts = statusCounts([g({ last_seen: NOW - 5 * DAY_MS })], DEFAULT_QUERY, ctx, NOW);
  const totals = { open: 5, resolved: 2, ignored: 0, all: 7, exact: true };
  test("open issues past the window count as quiet when even the oldest held is quiet", () => {
    const out = withTotals(counts, totals, NOW - 5 * DAY_MS, NOW);
    expect(out.open).toBe(5);
    expect(out.quiet).toBe(counts.quiet + 4);
    expect(out.resolved).toBe(2);
    expect(out.all).toBe(7);
  });
  test("and stay out of the lanes when the oldest held is still recent", () => {
    expect(withTotals(counts, totals, NOW - HOUR, NOW).quiet).toBe(counts.quiet);
  });
});
