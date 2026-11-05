import { expect, test } from "bun:test";
import { attentionCounts, attentionItems, fixLedger, homeIssueRefs, opsBadge, watchBand } from "./opsHomeModel";
import { escalationFactor, foldIssueRows, foldWeight } from "./issuesModel";
import type { SourceHealth } from "./sourceHealth";
import type { OpsGroup, OpsSource, OpsWatch } from "./opsTypes";

const NOW = Date.UTC(2026, 10, 3, 12);
const H = 3600_000;

const source = (over: Partial<OpsSource> = {}): OpsSource => ({
  _id: "s1", short_id: "src-1", workspace: "team:t", owner_user_id: "u", provider: "app", name: "union", keyed: true,
  promote: [], status: "active", last_event_at: NOW - 60_000, created_at: NOW - 30 * 24 * H, updated_at: NOW, ...over,
});
const group = (over: Partial<OpsGroup> = {}): OpsGroup => ({
  _id: "g1", workspace: "team:t", source_id: "s1", short_id: "eg-1", kind: "error", fingerprint: "f", title: "TypeError",
  status: "open", first_seen: NOW - 2 * H, last_seen: NOW - H, count: 3, buckets: [], updated_at: NOW, ...over,
});
const watch = (over: Partial<OpsWatch> = {}): OpsWatch => ({
  _id: "w1", workspace: "team:t", source_id: "s1", short_id: "mw-1", name: "Signups", query_kind: "series", query: "q",
  direction: "above", interval_ms: 300_000, status: "active", points: [], state: "ok", last_value: 1, last_at: NOW,
  source_name: "union", source_short_id: "src-1", updated_at: NOW, ...over,
});
const checkFailing = { state: "failing", tone: "warn", label: "Invariants check failing", level: "degraded", fix: "watches", problems: [{ kind: "check", name: "Invariants", line: "Invariants: over 256 KB" }], lastAt: NOW, days: [] } as unknown as SourceHealth;

test("a failing app check pages under its own tile, so Alerting is the metric watches alone, as the band and the Metrics tab count them", () => {
  const alerting = watch({ _id: "w-alert", short_id: "mw-8", state: "alert", threshold: 15, last_value: 132 });
  const items = attentionItems({ sources: [source()], groups: [], watches: [alerting], replays: [] }, NOW, () => checkFailing);
  const counts = attentionCounts(items);
  expect([counts.alerting, counts.check]).toEqual([1, 1]);
  expect(watchBand([alerting]).counts.alert).toBe(1);
  // Both page: the badge is their sum, in the tiles' own words.
  expect(opsBadge(items)).toEqual({ n: 2, words: "1 alerting · 1 check failing" });
});

test("one reader timing out folds its watches behind the band's Retrying count: no tile per watch", () => {
  const timedOut = Array.from({ length: 6 }, (_, i) => watch({ _id: `r${i}`, short_id: `mw-${i}`, last_error: "timed out", missed: 1, threshold: 10, last_value: 3 }));
  const alert = watch({ _id: "a", state: "alert", threshold: 15, last_value: 132 });
  const band = watchBand([...timedOut, alert]);
  expect(band.attention.map((w) => w._id)).toEqual(["a"]);
  expect(band.counts.retrying).toBe(6);
  expect(band.counts.ok).toBe(0);
});

test("the list header's issue count is every issue the rows hold, variants included: the stepper's 'of N' and the Issues lane", () => {
  const titles = ["anthropic", "bedrock", "openrouter"].map((p) => `budget context missing: ${p}/create_match:reverse_grade (job=x, span=y) — wrap the origin in withBudget(...)`);
  const groups = titles.map((title, i) => group({ _id: `g${i}`, short_id: `eg-${i}`, title, count: 60, first_seen: NOW - H, last_release: "r1" }));
  const items = attentionItems({ sources: [source({ provider: "sdk" })], groups, watches: [], replays: [] }, NOW, () => undefined);
  expect(items).toHaveLength(1);
  expect(homeIssueRefs(items, NOW)).toHaveLength(3);
});

test("the fold is one rule for every surface: clusters keep their first row's order, the heaviest leads", () => {
  const t = (p: string) => `budget context missing: ${p}/contacts:read (job=a, span=b) — wrap the origin in withBudget(...)`;
  const rows = [
    group({ _id: "other", title: "TypeError: x is undefined in the parser module today" }),
    group({ _id: "light", title: t("bedrock"), count: 5, first_seen: NOW - 30 * 24 * H }),
    group({ _id: "heavy", title: t("anthropic"), count: 50, first_seen: NOW - 30 * 24 * H }),
    // Another release is another cause, even with the same message.
    group({ _id: "later", title: t("openrouter"), last_release: "r2" }),
  ];
  const out = foldIssueRows(rows, (g) => g, (g) => foldWeight(g, NOW));
  expect(out.map((c) => c.map((g) => g._id))).toEqual([["other"], ["heavy", "light"], ["later"]]);
});

test("the escalation factor reads the same on the issue page and the home's pill", () => {
  expect(escalationFactor({ factor: 2.13 })).toBe("2.1×");
  expect(escalationFactor({ factor: 12.4 })).toBe("12×");
  expect(escalationFactor({ factor: 1.2 })).toBe("");
  expect(escalationFactor({ factor: null })).toBe("");
});

test("a folded fix names every issue it seeds and the variants' tasks it merges into the one it works", () => {
  const l = fixLedger("eg-1431", "budget context missing: …", "/src/union", "ct-74131", { seeds: ["eg-1431", "eg-1430", "eg-1432"], merges: ["ct-74130", "ct-74129"] });
  expect(l.rows).toContainEqual({ k: "Seeded with", v: "eg-1431, eg-1430, eg-1432" });
  expect(l.rows).toContainEqual({ k: "Merges into it", v: "ct-74130, ct-74129" });
  expect(l.figures).toContainEqual({ value: "2", label: "tasks merged" });
  // Unbound, nothing merges.
  expect(fixLedger("eg-1", "x", undefined, null, { merges: ["ct-1"] }).rows.some((r) => r.k === "Merges into it")).toBe(false);
});
