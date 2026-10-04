// The intent record's pure half (initiatives-projects-role-page.md I5): reading
// a source the way people write one, the next milestone, and a metric's trend.
import { describe, expect, test } from "bun:test";
import {
  appendScoreHistory,
  INITIATIVE_RECORD_MAX,
  INITIATIVE_SCORE_HISTORY_MAX,
  intentSourceKey,
  intentSourceLabel,
  intentSourceLine,
  mergeIntentSources,
  metricTrend,
  milestoneCounts,
  nextMilestone,
  openQuestions,
  orderedMilestones,
  parseIntentSource,
  recordEntryKey,
  trendWords,
  type InitiativeScore,
} from "./initiative";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 4);
const score = (value: string, daysAgo: number): InitiativeScore => ({ value, observed_at: NOW - daysAgo * DAY, source: "https://x.test/board" });

describe("parseIntentSource", () => {
  test("reads each address as its kind", () => {
    expect(parseIntentSource("call:k57abc#14")).toEqual({ kind: "call", ref: "k57abc#14" });
    expect(parseIntentSource("call:k57abc:14")).toEqual({ kind: "call", ref: "k57abc#14" });
    expect(parseIntentSource("chat:m9x2")).toEqual({ kind: "chat", ref: "m9x2" });
    expect(parseIntentSource("doc:abc123")).toEqual({ kind: "doc", ref: "abc123" });
    expect(parseIntentSource("jx7c6zk:142")).toEqual({ kind: "session", ref: "jx7c6zk:142" });
    expect(parseIntentSource("jx7c6zk")).toEqual({ kind: "session", ref: "jx7c6zk" });
    expect(parseIntentSource("CT-12")).toEqual({ kind: "task", ref: "ct-12" });
    expect(parseIntentSource("pl-88")).toEqual({ kind: "plan", ref: "pl-88" });
    expect(parseIntentSource("https://example.com/board?x=1")).toEqual({ kind: "link", ref: "https://example.com/board?x=1" });
  });

  test("an address followed by words keeps the words as the quote", () => {
    expect(parseIntentSource('call:k57abc#14 "our goal is $250 or less per introduction"')).toEqual({ kind: "call", ref: "k57abc#14", quote: "our goal is $250 or less per introduction" });
    expect(parseIntentSource("jx7c6zk:142: ship to brokers first")).toEqual({ kind: "session", ref: "jx7c6zk:142", quote: "ship to brokers first" });
  });

  test("plain words are a note, and a seven letter word is not a session", () => {
    expect(parseIntentSource("Ashot said the top goal is brokers")).toEqual({ kind: "note", quote: "Ashot said the top goal is brokers" });
    expect(parseIntentSource("because")).toEqual({ kind: "note", quote: "because" });
    expect(parseIntentSource("1234567")).toEqual({ kind: "note", quote: "1234567" });
  });

  test("who, when and an explicit quote ride along", () => {
    expect(parseIntentSource("ct-12", { by: "Ashot", at: NOW, quote: "do this first" })).toEqual({ kind: "task", ref: "ct-12", quote: "do this first", by: "Ashot", at: NOW });
  });

  test("empty text is an empty note, which a merge drops", () => {
    expect(parseIntentSource("")).toEqual({ kind: "note" });
    expect(mergeIntentSources([], [parseIntentSource("")])).toEqual([]);
  });
});

describe("sources", () => {
  test("the same address is one source, whatever its case or quote", () => {
    const a = parseIntentSource("ct-12 first");
    const merged = mergeIntentSources([a], [parseIntentSource("CT-12 again"), parseIntentSource("pl-3")]);
    expect(merged.map(intentSourceKey)).toEqual(["task:ct-12", "plan:pl-3"]);
    expect(merged[0].quote).toBe("first");
  });

  test("a merge stops at the list's limit", () => {
    const many = Array.from({ length: INITIATIVE_RECORD_MAX.sources + 5 }, (_, i) => parseIntentSource(`ct-${i + 1}`));
    expect(mergeIntentSources([], many)).toHaveLength(INITIATIVE_RECORD_MAX.sources);
  });

  test("labels and lines read plainly", () => {
    expect(intentSourceLabel({ kind: "call", ref: "k57abc#14" })).toBe("Call, line 14");
    expect(intentSourceLabel({ kind: "call", ref: "k57abc" })).toBe("Call");
    expect(intentSourceLabel({ kind: "session", ref: "jx7c6zk:142" })).toBe("Session jx7c6zk, line 142");
    expect(intentSourceLabel({ kind: "link", ref: "https://www.example.com/a" })).toBe("example.com");
    expect(intentSourceLabel({ kind: "task", ref: "ct-12" })).toBe("ct-12");
    expect(intentSourceLabel({ kind: "note", quote: "x" })).toBe("Note");
    expect(intentSourceLine({ kind: "call", ref: "k57abc#14", by: "Ashot", at: NOW - 3 * DAY, quote: "brokers first" }, NOW)).toBe('Ashot, call:k57abc#14, 3 days ago: "brokers first"');
    expect(intentSourceLine({ kind: "note", quote: "brokers first" }, NOW)).toBe('"brokers first"');
  });
});

describe("milestones and questions", () => {
  const milestones = [
    { key: "ga", title: "General release" },
    { key: "beta", title: "Private beta", date: NOW + 20 * DAY },
    { key: "alpha", title: "Alpha", date: NOW - 10 * DAY, done_at: NOW - 9 * DAY },
    { key: "pilot", title: "Pilot", date: NOW + 5 * DAY },
  ];

  test("dated milestones read by day, undated ones last as written", () => {
    expect(orderedMilestones(milestones).map((m) => m.key)).toEqual(["alpha", "pilot", "beta", "ga"]);
  });

  test("the next milestone is the first one not reached", () => {
    expect(nextMilestone({ milestones })?.key).toBe("pilot");
    expect(nextMilestone({ milestones: milestones.map((m) => ({ ...m, done_at: NOW })) })).toBeNull();
    expect(nextMilestone({})).toBeNull();
    expect(milestoneCounts({ milestones })).toEqual({ done: 1, total: 4 });
  });

  test("an answered question is closed", () => {
    const questions = [{ key: "a", text: "Per seat?", at: NOW }, { key: "b", text: "Which market?", at: NOW, answer: "Brokers", answered_at: NOW }];
    expect(openQuestions({ questions }).map((q) => q.key)).toEqual(["a"]);
  });

  test("a new entry's key is a slug, numbered on a clash", () => {
    expect(recordEntryKey("Private beta open!", [])).toBe("private_beta_open");
    expect(recordEntryKey("Private beta open", ["private_beta_open", "private_beta_open_2"])).toBe("private_beta_open_3");
    expect(recordEntryKey("???", [])).toBe("entry");
  });
});

describe("score history and trend", () => {
  test("history stays oldest first, capped, and one report per moment", () => {
    let h = appendScoreHistory(undefined, "teams", score("300", 14));
    h = appendScoreHistory(h, "teams", score("412", 0));
    h = appendScoreHistory(h, "teams", score("380", 7));
    h = appendScoreHistory(h, "teams", score("415", 0));
    expect(h.teams.map((s) => s.value)).toEqual(["300", "380", "415"]);
    for (let i = 1; i <= INITIATIVE_SCORE_HISTORY_MAX + 10; i++) h = appendScoreHistory(h, "teams", score(String(i), -i));
    expect(h.teams).toHaveLength(INITIATIVE_SCORE_HISTORY_MAX);
    expect(h.teams[h.teams.length - 1].value).toBe(String(INITIATIVE_SCORE_HISTORY_MAX + 10));
  });

  test("a rising number is toward a reach target and away from a stay under one", () => {
    const history = [score("300", 14), score("380", 7), score("412", 0)];
    const reach = metricTrend(history, "1,000");
    expect(reach.direction).toBe("up");
    expect(reach.toward).toBe(true);
    expect(reach.delta).toBe(32);
    expect(reach.series.map((p) => p.n)).toEqual([300, 380, 412]);
    expect(metricTrend(history, "under 200").toward).toBe(false);
    expect(trendWords(reach)).toBe("up from 300, toward the target");
  });

  test("a falling number is toward a stay under target", () => {
    const t = metricTrend([score("$310", 7), score("$262", 0)], "$250 or less");
    expect(t.direction).toBe("down");
    expect(t.toward).toBe(true);
  });

  test("one report, or none, is no trend; equal reports are flat", () => {
    expect(metricTrend([score("5", 0)], "10").direction).toBe("unknown");
    expect(metricTrend(undefined, "10").direction).toBe("unknown");
    expect(trendWords(metricTrend(undefined, "10"))).toBe("");
    const flat = metricTrend([score("5", 7), score("5", 0)], "10");
    expect(flat.direction).toBe("flat");
    expect(flat.toward).toBeNull();
  });

  test("values that are not numbers are skipped, not read as zero", () => {
    const t = metricTrend([score("unknown", 14), score("4", 7), score("6", 0)], "10");
    expect(t.series.map((p) => p.n)).toEqual([4, 6]);
    expect(t.direction).toBe("up");
  });
});
