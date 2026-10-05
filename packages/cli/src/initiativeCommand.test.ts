import { describe, expect, test } from "bun:test";
import { targetDayStamp } from "@codecast/shared/time";
import { metricReadings, metricTrends } from "@codecast/shared/contracts/initiative";
import {
  decisionLine,
  initiativeLine,
  initiativeShowLines,
  metricRecordLine,
  milestoneLine,
  nextMilestoneLine,
  parseInitiativeHealth,
  parseInitiativeStatus,
  parseMilestoneArg,
  pickRecordEntry,
  progressText,
  questionLines,
  readSourceArg,
  recordEntries,
  recordEntryLines,
  recordWriteLines,
  scopeSentence,
  sourceLine,
} from "./initiativeCommand";

const c = { green: "", yellow: "", red: "", cyan: "", dim: "", bold: "", reset: "" };

describe("cast initiative: reading what a person types", () => {
  test("a health in any spelling", () => {
    for (const t of ["on_track", "on-track", "On Track", "ontrack"]) expect(parseInitiativeHealth(t)).toBe("on_track");
    expect(parseInitiativeHealth("at risk")).toBe("at_risk");
    expect(parseInitiativeHealth("fine")).toBeNull();
  });
  test("a status", () => {
    expect(parseInitiativeStatus("Active")).toBe("active");
    expect(parseInitiativeStatus("done")).toBeNull();
  });
});

describe("cast initiative ls", () => {
  test("one line carries status, owner, projects, progress, health with its date and the target", () => {
    const line = initiativeLine(c, {
      short_id: "in-3", title: "Win enterprise", status: "active", health: "at_risk", health_at: new Date(2026, 8, 18, 23, 59).getTime(),
      owner_label: "@growth", projects: [{}, {}], task_counts: { total: 8, done: 2 }, target_date: targetDayStamp("2026-12-01"),
    });
    expect(line).toBe("  ◉ in-3 Win enterprise At risk (2026-09-18) Active | @growth | 2 projects | 2/8 done (25%) | target 2026-12-01");
  });
  test("no owner and no update are said plainly", () => {
    const line = initiativeLine(c, { short_id: "in-1", title: "T", status: "proposed", health: "none", project_ids: [] });
    expect(line).toContain("No update");
    expect(line).toContain("no owner");
    expect(progressText({ total: 0, done: 0 })).toBe("no tasks");
  });
});

describe("the owner role's scope, in one sentence", () => {
  const titleOf = (id: string) => ({ p: "Growth", q: "Billing" }[id] ?? id);
  test("nothing happened", () => {
    expect(scopeSentence("@growth", null, titleOf)).toBeNull();
    expect(scopeSentence("@growth", { added: [], listed: ["p"], skipped: [] }, titleOf)).toBeNull();
    expect(scopeSentence("@growth", { added: [], listed: [], skipped: [{ project_id: "p", reason: "whole_workspace" }] }, titleOf)).toBeNull();
  });
  test("a token call is told the scope is a person's to widen", () => {
    const s = scopeSentence("@growth", { added: [], listed: [], skipped: [{ project_id: "q", reason: "human_only" }] }, titleOf);
    expect(s).toBe("Billing was not added to its scope: a scope changes from the role page in the browser, never from a token call.");
  });
  test("what was added, what was not and why, and who was taken over", () => {
    const s = scopeSentence("@growth", {
      added: ["p"], listed: [], skipped: [{ project_id: "q", reason: "not_admin" }], took_over: "@growth took over 2 sessions.",
    }, titleOf);
    expect(s).toBe("@growth now has Growth in its scope. Billing was not added to its scope: only an admin of the role may change its scope. @growth took over 2 sessions.");
  });
});

// ── The intent record (I5) ───────────────────────────────────────────────────

const DAY = 86_400_000;
// Noon, so a moment a few days back is the same calendar day in every timezone the suite runs in.
const NOW = new Date(2026, 9, 4, 12).getTime();
const day = (text: string) => targetDayStamp(text)!;
const ago = (days: number) => NOW - days * DAY;

// A goal with every part of its record written.
const FULL = {
  short_id: "in-3", title: "Win the private network", status: "active", health: "at_risk", health_at: ago(2),
  owner_label: "@growth", priority: "p1", target_date: day("2026-12-31"), labels: ["growth"],
  parent: { short_id: "in-1", title: "Reach 1k teams" },
  description: "Brokers first, then lenders.",
  why: "Introductions are the product.\nWithout them nothing else matters.",
  done_when: "A broker pays for a second month.",
  metrics: [{ key: "cost_per_intro", name: "Cost per intro", target: "< $250" }, { key: "weekly_active_teams", name: "Weekly active teams", target: "1000" }],
  scoreboard: { weekly_active_teams: { value: "412", observed_at: ago(1), source: "https://x.test/board" } },
  score_history: { weekly_active_teams: [
    { value: "380", observed_at: ago(8), source: "https://x.test/board" },
    { value: "412", observed_at: ago(1), source: "https://x.test/board" },
  ] },
  // Written out of order: the dated ones read by day, the undated one last.
  milestones: [
    { key: "ga", title: "General availability" },
    { key: "private_beta_open", title: "Private beta open", date: day("2026-11-01"), source: { kind: "call", ref: "cl-42:14" } },
    { key: "design_partner_signed", title: "Design partner signed", date: day("2026-09-20"), done_at: ago(13) },
    { key: "pricing_page_live", title: "Pricing page live", date: day("2026-09-28") },
  ],
  questions: [
    { key: "which_market_first", text: "Which market first?", at: ago(10), by: "@growth", answer: "Brokers", answered_at: ago(6) },
    { key: "do_we_price_per_seat", text: "Do we price per seat?", at: ago(4), by: "@ashot", source: { kind: "session", ref: "jx7c6zk:142" } },
  ],
  decisions: [{ key: "ship_to_brokers_first", text: "Ship to brokers first", at: ago(6), by: "Ashot", source: { kind: "task", ref: "ct-12" } }],
  sources: [
    { kind: "call", ref: "cl-42:14", quote: "our goal is $250 or less per introduction", by: "Ashot", at: ago(4) },
    { kind: "note", quote: "brokers before lenders" },
  ],
  projects: [{ _id: "p", title: "Growth", status: "active", lead: "@growth", task_counts: { total: 8, done: 2 } }, { _id: "q", title: "Billing", status: "planning", task_counts: { total: 0, done: 0 } }],
  task_counts: { total: 8, done: 2 },
  updates: [{ health: "at_risk", by_label: "@growth", at: ago(2), body: "Two partners slipped.\nOne signed." }],
  sub_initiatives: [{ short_id: "in-5", title: "Broker outreach", status: "planned", health: "none" }],
};

describe("cast initiative: the arguments of the record", () => {
  test("a milestone with its day, and a title that only looks like one", () => {
    expect(parseMilestoneArg("Private beta open=2026-11-01")).toEqual({ title: "Private beta open", date: day("2026-11-01") });
    expect(parseMilestoneArg(" General availability ")).toEqual({ title: "General availability" });
    expect(parseMilestoneArg("Reach x=3 teams")).toEqual({ title: "Reach x=3 teams" });
    expect(parseMilestoneArg("Private beta open=2026-02-30")).toBeNull();
    expect(parseMilestoneArg("=2026-11-01")).toBeNull();
    expect(parseMilestoneArg("  ")).toBeNull();
  });
  test("a source is an address, words, or both; nothing at all is refused", () => {
    expect(readSourceArg("call:cl-42#14", { by: "Ashot", at: day("2026-09-30"), quote: "brokers first" })).toEqual({ kind: "call", ref: "cl-42:14", quote: "brokers first", by: "Ashot", at: day("2026-09-30") });
    expect(readSourceArg("said on the retreat")).toEqual({ kind: "note", quote: "said on the retreat" });
    expect(readSourceArg("  ")).toBeNull();
  });
});

describe("cast initiative: which entry a person means", () => {
  test("milestones number in reading order, the rest as written, and a source's key is its address", () => {
    expect(recordEntries(FULL, "milestones").map((e) => `${e.n} ${e.key}`)).toEqual(["1 design_partner_signed", "2 pricing_page_live", "3 private_beta_open", "4 ga"]);
    expect(recordEntries(FULL, "questions").map((e) => `${e.n} ${e.key}`)).toEqual(["1 which_market_first", "2 do_we_price_per_seat"]);
    expect(recordEntries(FULL, "sources").map((e) => e.key)).toEqual(["call:cl-42:14", "note:brokers before lenders"]);
    expect(recordEntries({}, "decisions")).toEqual([]);
  });
  test("by number, by key, by the whole words or a part only one has", () => {
    const key = (list: any, pick: string) => (pickRecordEntry(FULL, list, pick) as any).key;
    expect(key("milestones", "3")).toBe("private_beta_open");
    expect(key("milestones", "ga")).toBe("ga");
    expect(key("milestones", "private BETA open")).toBe("private_beta_open");
    expect(key("questions", "per seat")).toBe("do_we_price_per_seat");
    expect(key("sources", "cl-42")).toBe("call:cl-42:14");
  });
  test("a miss says what is there", () => {
    expect(pickRecordEntry(FULL, "milestones", "9")).toEqual({ error: "No milestone 9 on in-3: it has 4" });
    expect(pickRecordEntry(FULL, "decisions", "lenders")).toEqual({ error: 'No decision on in-3 matches "lenders"' });
    expect(pickRecordEntry(FULL, "milestones", "a")).toEqual({ error: '"a" matches 4 milestones on in-3; name one by its number: 1. Design partner signed | 2. Pricing page live | 3. Private beta open | 4. General availability' });
    expect(pickRecordEntry({ short_id: "in-9" }, "questions", "1")).toEqual({ error: "in-9 has no questions yet" });
  });
});

describe("cast initiative: the lines of the record", () => {
  test("a metric reads now against its target, the standing, the date and the trend", () => {
    const [cost, teams] = metricReadings(FULL);
    const trends = metricTrends(FULL);
    expect(metricRecordLine(c, teams, trends[teams.key], NOW)).toBe("behind Weekly active teams: 412 of 1000, behind (yesterday) · up from 380, toward the target");
    expect(metricRecordLine(c, cost, trends[cost.key], NOW)).toBe("unread Cost per intro: not reported yet, target < $250");
  });
  test("a milestone: reached, overdue, and due with its source", () => {
    const [signed, pricing, beta, ga] = recordEntries(FULL, "milestones");
    expect(milestoneLine(c, signed.entry, signed.n, NOW)).toBe("  ✓ 1. Design partner signed · by 2026-09-20 · reached 2026-09-21");
    expect(milestoneLine(c, pricing.entry, pricing.n, NOW)).toBe("  ○ 2. Pricing page live · by 2026-09-28 overdue");
    expect(milestoneLine(c, beta.entry, beta.n, NOW)).toBe("  ○ 3. Private beta open · by 2026-11-01 · call:cl-42:14");
    expect(milestoneLine(c, ga.entry, ga.n, NOW)).toBe("  ○ 4. General availability");
  });
  test("the next milestone is the first one not reached, earliest day first", () => {
    expect(nextMilestoneLine(FULL)).toBe("Next milestone: Pricing page live by 2026-09-28 (1 of 4 reached)");
    expect(nextMilestoneLine({ milestones: [{ key: "a", title: "A", done_at: NOW }] })).toBe("Every milestone reached (1 of 1)");
    expect(nextMilestoneLine({})).toBeNull();
  });
  test("a question says who asked, when and where, and carries its answer", () => {
    const [answered, open] = recordEntries(FULL, "questions");
    expect(questionLines(c, open.entry, open.n, NOW)).toEqual(["  2. Do we price per seat? · @ashot · 2026-09-30 · session:jx7c6zk:142"]);
    expect(questionLines(c, answered.entry, answered.n, NOW)).toEqual(["  1. Which market first? · @growth · 2026-09-24", "     answer Brokers (2026-09-28)"]);
  });
  test("a decision says who decided, when and where", () => {
    const [decision] = recordEntries(FULL, "decisions");
    expect(decisionLine(c, decision.entry, decision.n, NOW)).toBe("  1. Ship to brokers first · Ashot · 2026-09-28 · ct-12");
  });
  test("a source says who said it and where, in the shared words", () => {
    const [call, note] = recordEntries(FULL, "sources");
    expect(sourceLine(call.entry, call.n, NOW)).toBe('  1. Ashot, call:cl-42:14, 4 days ago: "our goal is $250 or less per introduction"');
    expect(sourceLine(note.entry, note.n, NOW)).toBe('  2. "brokers before lenders"');
  });
  test("one entry of any list prints as show prints it", () => {
    for (const list of ["milestones", "questions", "decisions", "sources"] as const) {
      const shown = initiativeShowLines(c, FULL, { now: NOW, ago: () => "" });
      for (const e of recordEntries(FULL, list)) for (const line of recordEntryLines(c, list, e, NOW)) expect(shown).toContain(line);
    }
  });
});

describe("cast initiative: what a record write answers", () => {
  test("an added milestone prints as it stands, then where the goal is on its way", () => {
    expect(recordWriteLines(c, "Added a milestone to", { short_id: "in-3", row: FULL, entry: FULL.milestones[1] }, "milestones", NOW)).toEqual([
      "ok Added a milestone to in-3: Win the private network",
      "  ○ 3. Private beta open · by 2026-11-01 · call:cl-42:14",
      "  Next milestone: Pricing page live by 2026-09-28 (1 of 4 reached)",
    ]);
  });
  test("a source is found by its address, and a removed entry prints no line", () => {
    expect(recordWriteLines(c, "Added a source to", { short_id: "in-3", row: FULL, entry: FULL.sources[1] }, "sources", NOW)).toEqual(["ok Added a source to in-3: Win the private network", '  2. "brokers before lenders"']);
    expect(recordWriteLines(c, "Removed a decision from", { short_id: "in-3", row: { ...FULL, decisions: [] }, entry: FULL.decisions[0] }, "decisions", NOW)).toEqual(["ok Removed a decision from in-3: Win the private network"]);
  });
});

describe("cast initiative show", () => {
  const show = (row: any) => initiativeShowLines(c, row, { now: NOW, ago: (at) => `${Math.round((NOW - at) / DAY)} days ago`, projectIcons: { active: "◉", planning: "○" } }).join("\n");
  test("the whole record, in the order a person asks about it", () => {
    expect(show(FULL)).toBe(`
  ◉ Win the private network  in-3
  active | health At risk (2026-10-02) | p1 | target 2026-12-31 | under in-1 Reach 1k teams
  Labels: growth

  Brokers first, then lenders.

  Why
  Introductions are the product.
  Without them nothing else matters.

  Done when
  A broker pays for a second month.

  Owner @growth

  Metrics on track means against the target
  unread Cost per intro: not reported yet, target < $250 · cost_per_intro
  behind Weekly active teams: 412 of 1000, behind (yesterday) · up from 380, toward the target · weekly_active_teams · https://x.test/board
  Report a value: cast initiative report in-3 cost_per_intro=<value> --source <link or short id>

  Milestones
  Next milestone: Pricing page live by 2026-09-28 (1 of 4 reached)
  ✓ 1. Design partner signed · by 2026-09-20 · reached 2026-09-21
  ○ 2. Pricing page live · by 2026-09-28 overdue
  ○ 3. Private beta open · by 2026-11-01 · call:cl-42:14
  ○ 4. General availability

  Open questions (1)
  2. Do we price per seat? · @ashot · 2026-09-30 · session:jx7c6zk:142

  Answered questions (1)
  1. Which market first? · @growth · 2026-09-24
     answer Brokers (2026-09-28)

  Decisions (1)
  1. Ship to brokers first · Ashot · 2026-09-28 · ct-12

  Sources (2)
  1. Ashot, call:cl-42:14, 4 days ago: "our goal is $250 or less per introduction"
  2. "brokers before lenders"

  Projects (2) 2/8 done (25%)
  ◉ Growth active | lead @growth | 2/8 done (25%)
  ○ Billing planning | lead none | no tasks

  Updates (1)
  At risk · @growth · 2 days ago
    Two partners slipped.
    One signed.

  Sub initiatives
  ◌ in-5 Broker outreach No update
`);
  });
  test("a bare goal says what its record lacks", () => {
    const text = show({ short_id: "in-1", title: "T", status: "proposed", health: "none", project_ids: [] });
    expect(text).toContain("  Owner none");
    expect(text).toContain("  Not on the record yet: why, done when, milestones, sources. cast initiative --help lists the commands that write them.");
    expect(text).toContain("  None yet: cast initiative add-project in-1 <project>");
    for (const absent of ["Why", "Done when", "Metrics", "Milestones", "questions", "Decisions", "Sources (", "Sub initiatives"]) expect(text).not.toContain(absent);
  });
});
