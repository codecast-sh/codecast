import { describe, expect, test } from "bun:test";
import { targetDayStamp } from "@codecast/shared/time";
import { metricReadings, metricTrends } from "@codecast/shared/contracts/initiative";
import {
  SOURCE_NEEDED,
  answerWrite,
  decisionLine,
  initiativeLine,
  initiativeShowLines,
  metricRecordLine,
  milestoneLine,
  milestoneWrite,
  nextMilestoneLine,
  parseInitiativeHealth,
  parseInitiativeStatus,
  parseMilestoneArg,
  pickRecordEntry,
  progressText,
  questionLines,
  readDayArg,
  readMomentArg,
  readSourceArg,
  recordEntries,
  recordEntryLines,
  recordVerb,
  recordWriteLines,
  removeWrite,
  saidWrite,
  scopeSentence,
  sourceFillIn,
  sourceLine,
  sourceWrite,
  type RecordWrite,
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
  test("a mistyped day is refused, never kept as words of the title", () => {
    expect(parseMilestoneArg("Private beta open=2026-11-1")).toBeNull();
    expect(parseMilestoneArg("Beta=11/1/2026")).toBeNull();
    expect(parseMilestoneArg("Churn=1.5")).toEqual({ title: "Churn=1.5" });
    expect(parseMilestoneArg("NPS=40-50")).toEqual({ title: "NPS=40-50" });
  });
  test("a source is an address, words, or both; nothing at all is refused", () => {
    expect(readSourceArg("call:cl-42#14", { by: "Ashot", at: ago(4), quote: "brokers first" })).toEqual({ kind: "call", ref: "cl-42:14", quote: "brokers first", by: "Ashot", at: ago(4) });
    expect(readSourceArg("said on the retreat")).toEqual({ kind: "note", quote: "said on the retreat" });
    expect(readSourceArg("  ")).toBeNull();
  });
  test("words typed beside --quote are kept with it", () => {
    expect(readSourceArg("the Sep 30 founder call", { quote: "our goal is $250" })).toEqual({ kind: "note", quote: "the Sep 30 founder call: our goal is $250" });
    expect(readSourceArg("ct-12 ship by spring", { quote: "brokers first" })).toEqual({ kind: "task", ref: "ct-12", quote: "ship by spring: brokers first" });
    expect(readSourceArg("brokers first", { quote: "brokers first" })).toEqual({ kind: "note", quote: "brokers first" });
  });
  test("a calendar day is the shared stamp, and anything else says how to write one", () => {
    expect(readDayArg("2026-11-01", "--date")).toBe(day("2026-11-01"));
    expect(readDayArg("2026-11-1", "--date")).toEqual({ error: 'Invalid --date "2026-11-1": use YYYY-MM-DD' });
    expect(readDayArg("soon", "--target", true)).toEqual({ error: 'Invalid --target "soon": use YYYY-MM-DD, or "none" to clear' });
  });
  test("a moment typed as a day is noon of that day here; a time is that time", () => {
    expect(readMomentArg("2026-09-30", "--at", NOW)).toBe(new Date(2026, 8, 30, 12).getTime());
    expect(readMomentArg("2026-09-30T09:15", "--at", NOW)).toBe(new Date(2026, 8, 30, 9, 15).getTime());
    expect(readMomentArg("2026-09-30 09:15", "--at", NOW)).toBe(new Date(2026, 8, 30, 9, 15).getTime());
    expect(readMomentArg("2026-09-30T09:15:00Z", "--at", NOW)).toBe(Date.UTC(2026, 8, 30, 9, 15));
    // Never the target day stamp, which is the last instant of the day in UTC.
    expect(readMomentArg("2026-09-30", "--at", NOW)).not.toBe(day("2026-09-30"));
  });
  test("today typed before noon is now, never a moment still to come", () => {
    const morning = new Date(2026, 9, 4, 9).getTime();
    expect(readMomentArg("2026-10-04", "--at", morning)).toBe(morning);
    expect(readMomentArg("2026-10-04", "--at", NOW + 3_600_000)).toBe(NOW);
  });
  test("a moment that is not one is refused, 'none' and a rolled day too", () => {
    for (const text of ["none", "2026-02-30", "30/09/2026", "yesterday", "2026-09-30T25:99"]) {
      expect(readMomentArg(text, "--at", NOW)).toEqual({ error: `Invalid --at "${text}": use YYYY-MM-DD, or YYYY-MM-DDTHH:MM for a time` });
    }
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
  test("a source by its address, in every form the help teaches", () => {
    const row = { short_id: "in-3", sources: [...FULL.sources, { kind: "session", ref: "jx7c6zk:142" }, { kind: "task", ref: "ct-12" }, { kind: "link", ref: "https://x.test/Board" }] };
    const key = (pick: string) => (pickRecordEntry(row, "sources", pick) as any).key;
    for (const pick of ["call:cl-42#14", "call:cl-42:14", "Call:CL-42#14"]) expect(key(pick)).toBe("call:cl-42:14");
    expect(key("jx7c6zk:142")).toBe("session:jx7c6zk:142");
    expect(key("session:jx7c6zk:142")).toBe("session:jx7c6zk:142");
    expect(key("CT-12")).toBe("task:ct-12");
    expect(key("https://x.test/Board")).toBe("link:https://x.test/board");
    expect(key("brokers before lenders")).toBe("note:brokers before lenders");
  });
  test("a miss prints the entries and the command to type next", () => {
    const retry = "cast initiative milestone in-3 --done <n>";
    const milestones = ["  1. Design partner signed", "  2. Pricing page live", "  3. Private beta open", "  4. General availability", `Name one by its number: ${retry}`];
    expect(pickRecordEntry(FULL, "milestones", "9", { retry })).toEqual({ error: ["No milestone 9 on in-3. It has 4:", ...milestones].join("\n") });
    expect(pickRecordEntry(FULL, "milestones", "a", { retry })).toEqual({ error: ['"a" matches 4 milestones on in-3:', ...milestones].join("\n") });
    expect(pickRecordEntry(FULL, "decisions", "lenders", { retry: "cast initiative record in-3 --list decisions --remove <n>" })).toEqual({
      error: 'No decision on in-3 matches "lenders". It has:\n  1. Ship to brokers first\nName one by its number: cast initiative record in-3 --list decisions --remove <n>',
    });
    expect(pickRecordEntry(FULL, "decisions", "lenders")).toEqual({ error: 'No decision on in-3 matches "lenders". It has:\n  1. Ship to brokers first' });
  });
  test("a goal with none of a list says the command that adds one", () => {
    expect(pickRecordEntry({ short_id: "in-9" }, "milestones", "1")).toEqual({ error: 'in-9 has no milestones yet. Add one: cast goal milestone in-9 "<title>" --date <YYYY-MM-DD>' });
    expect(pickRecordEntry({ short_id: "in-9" }, "questions", "1")).toEqual({ error: 'in-9 has no questions yet. Add one: cast initiative ask in-9 "<question>"' });
    expect(pickRecordEntry({ short_id: "in-9" }, "decisions", "x")).toEqual({ error: 'in-9 has no decisions yet. Add one: cast initiative decide in-9 "<decision>"' });
    expect(pickRecordEntry({ short_id: "in-9" }, "sources", "x")).toEqual({ error: "in-9 has no sources yet. Add one: cast initiative source in-9 <address or the words said>" });
  });
  test("a command that takes only some entries refuses the rest by name, and matches words among the ones it takes", () => {
    const { pick } = answerWrite("in-3", "1", "Per seat") as RecordWrite;
    const two = { ...FULL, questions: [...FULL.questions, { key: "which_price", text: "Which price?", at: ago(1), answer: "$250" }] };
    const picked = (text: string) => pickRecordEntry(two, "questions", text, pick);
    // The number is the one show prints, so 1 is the answered question, not the first open one.
    expect(picked("1")).toEqual({ error: 'Question 1 on in-3 is already answered: "Brokers". Pass --replace to put this answer in its place.' });
    expect((picked("2") as any).key).toBe("do_we_price_per_seat");
    // "price" is in an open question and an answered one: only the open one is meant.
    expect((picked("price") as any).key).toBe("do_we_price_per_seat");
    expect(picked("which market")).toEqual({ error: 'Question 1 on in-3 is already answered: "Brokers". Pass --replace to put this answer in its place.' });
    expect(picked("lenders")).toEqual({ error: 'No open question on in-3 matches "lenders". It has:\n  2. Do we price per seat?\nName one by its number: cast initiative answer in-3 <n> "<answer>"' });
    // With --replace every question is taken.
    const replacing = (answerWrite("in-3", "1", "Per seat", { replace: true }) as RecordWrite).pick;
    expect((pickRecordEntry(two, "questions", "1", replacing) as any).key).toBe("which_market_first");
  });
});

describe("cast initiative: the op each record command sends", () => {
  const SEP_21 = new Date(2026, 8, 21, 12).getTime();
  const named = (text: string, flag: string) => ({ text, retry: `cast initiative milestone in-3 ${flag} <n>` });

  test("milestone: a title adds one, with its day in the title or in --date, and where it was set", () => {
    expect(milestoneWrite("in-3", "General availability", {})).toEqual({ verb: "Added a milestone to", op: { list: "milestones", action: "add", entry: { title: "General availability" } } });
    const dated: RecordWrite = { verb: "Added a milestone to", op: { list: "milestones", action: "add", entry: { title: "GA", date: day("2026-12-15") } } };
    expect(milestoneWrite("in-3", "GA=2026-12-15", {})).toEqual(dated);
    expect(milestoneWrite("in-3", "GA", { date: "2026-12-15" })).toEqual(dated);
    expect((milestoneWrite("3", "GA", { source: "call:cl-42#14" }) as RecordWrite).op.entry).toEqual({ title: "GA", source: { kind: "call", ref: "cl-42:14" } });
  });
  test("milestone: a mistyped day, a day given twice and a reached day on a new one are refused", () => {
    expect(milestoneWrite("in-3", "GA=2026-12-1", {})).toEqual({ error: 'Invalid milestone "GA=2026-12-1": use "Title" or "Title=YYYY-MM-DD"' });
    expect(milestoneWrite("in-3", "GA", { date: "12/15/2026" })).toEqual({ error: 'Invalid --date "12/15/2026": use YYYY-MM-DD' });
    expect(milestoneWrite("in-3", "GA=2026-12-15", { date: "2026-12-16" })).toEqual({ error: 'Give the day once: in the title as "Title=YYYY-MM-DD", or with --date' });
    expect(milestoneWrite("in-3", "GA", { at: "2026-09-21" })).toEqual({ error: "--at is the day a milestone was reached: give it with --done or --edit" });
    expect(milestoneWrite("in-3", "GA", { source: "  " })).toEqual({ error: SOURCE_NEEDED });
  });
  test("milestone --done closes it now, or on the day --at names, and takes nothing else", () => {
    expect(milestoneWrite("in-3", undefined, { done: "2" })).toEqual({ verb: "Reached a milestone of", op: { list: "milestones", action: "close" }, pick: named("2", "--done") });
    expect(milestoneWrite("IN-3", undefined, { done: "Design partner signed", at: "2026-09-21" }, NOW)).toEqual({ verb: "Reached a milestone of", op: { list: "milestones", action: "close", at: SEP_21 }, pick: named("Design partner signed", "--done") });
    for (const extra of [{ date: "2026-09-21" }, { source: "ct-12" }, { date: null }]) expect(milestoneWrite("in-3", undefined, { done: "2", ...extra })).toEqual({ error: "--done takes only --at, the day it was reached. A title, --date and --source belong to a new milestone or to --edit" });
    expect(milestoneWrite("in-3", undefined, { done: "2", at: "21 Sep" })).toEqual({ error: 'Invalid --at "21 Sep": use YYYY-MM-DD, or YYYY-MM-DDTHH:MM for a time' });
    expect(milestoneWrite("in-3", undefined, { done: "2", at: null })).toEqual({ error: "A reached milestone is reopened with: cast initiative milestone in-3 --edit <n> --at none" });
  });
  test("milestone --edit sends only what changes: the title, the day, the source, the day it was reached", () => {
    const edit = (title: string | undefined, o: any) => (milestoneWrite("in-3", title, { edit: "2", ...o }, NOW) as RecordWrite);
    expect(edit(undefined, { date: "2026-12-01" })).toEqual({ verb: "Changed a milestone of", op: { list: "milestones", action: "edit", entry: { date: day("2026-12-01") } }, pick: named("2", "--edit") });
    expect(edit("Open beta", {}).op.entry).toEqual({ title: "Open beta" });
    expect(edit("Open beta=2026-12-01", {}).op.entry).toEqual({ title: "Open beta", date: day("2026-12-01") });
    expect(edit(undefined, { date: null, source: null }).op.entry).toEqual({ date: null, source: null });
    expect(edit(undefined, { source: "ct-12" }).op.entry).toEqual({ source: { kind: "task", ref: "ct-12" } });
    // The day it was reached moves, or is cleared: the one way back from a --done on the wrong one.
    expect(edit(undefined, { at: "2026-09-21" }).op.entry).toEqual({ done_at: SEP_21 });
    expect(edit(undefined, { at: null }).op.entry).toEqual({ done_at: null });
    expect(milestoneWrite("in-3", undefined, { edit: "2" })).toEqual({ error: "Nothing to change: give a new title, --date, --source, or --at (the day it was reached; 'none' reopens it)" });
    expect(milestoneWrite("in-3", undefined, { edit: "2", date: "soon" })).toEqual({ error: 'Invalid --date "soon": use YYYY-MM-DD, or "none" to clear' });
  });
  test("milestone --remove takes the milestone alone, and one gesture is given at a time", () => {
    expect(milestoneWrite("in-3", undefined, { remove: "ga" })).toEqual({ verb: "Removed a milestone from", op: { list: "milestones", action: "remove" }, pick: named("ga", "--remove") });
    expect(milestoneWrite("in-3", undefined, { remove: "ga", date: "2026-12-01" })).toEqual({ error: "--remove takes the milestone alone" });
    const one = { error: "Give one of: a title to add, --done <n|title>, --edit <n|title> with what changes, or --remove <n|title>" };
    expect(milestoneWrite("in-3", undefined, {})).toEqual(one);
    expect(milestoneWrite("in-3", undefined, { done: "1", remove: "2" })).toEqual(one);
    expect(milestoneWrite("in-3", undefined, { done: "1", edit: "1" })).toEqual(one);
  });

  test("ask and decide: the words, who said them and where", () => {
    expect(saidWrite("in-3", "questions", "Do we price per seat?", {})).toEqual({ verb: "Asked on", op: { list: "questions", action: "add", entry: { text: "Do we price per seat?" } } });
    expect(saidWrite("in-3", "decisions", "Ship to brokers first", { by: "Ashot", source: "jx7c6zk:142" })).toEqual({
      verb: "Recorded a decision on", op: { list: "decisions", action: "add", entry: { text: "Ship to brokers first", by: "Ashot", source: { kind: "session", ref: "jx7c6zk:142" } } },
    });
    // 'none' clears on an edit only: a new entry that names nobody is signed by whoever adds it.
    expect((saidWrite("in-3", "questions", "Q?", { by: null, source: null }) as RecordWrite).op.entry).toEqual({ text: "Q?" });
    expect(saidWrite("in-3", "questions", undefined, {})).toEqual({ error: "Give the question, or --edit <n|words> to change one" });
    expect(saidWrite("in-3", "decisions", " ", {})).toEqual({ error: "Give the decision, or --edit <n|words> to change one" });
    expect(saidWrite("in-3", "questions", "Q?", { source: " " })).toEqual({ error: SOURCE_NEEDED });
  });
  test("ask and decide --edit send the wire's edit with only what changes", () => {
    expect(saidWrite("3", "questions", "Do we price per team?", { edit: "2" })).toEqual({
      verb: "Changed a question on", op: { list: "questions", action: "edit", entry: { text: "Do we price per team?" } }, pick: { text: "2", retry: 'cast initiative ask in-3 --edit <n> "<new words>"' },
    });
    expect(saidWrite("in-3", "decisions", undefined, { edit: "brokers", by: "@ashot", source: null })).toEqual({
      verb: "Changed a decision on", op: { list: "decisions", action: "edit", entry: { by: "@ashot", source: null } }, pick: { text: "brokers", retry: 'cast initiative decide in-3 --edit <n> "<new words>"' },
    });
    expect(saidWrite("in-3", "questions", undefined, { edit: "2" })).toEqual({ error: "Nothing to change: give the new words, --by or --source" });
  });

  test("answer closes a question, on the day --at names", () => {
    const write = answerWrite("in-3", "per seat", "Per seat", { at: "2026-09-21" }, NOW) as RecordWrite;
    expect(write.verb).toBe("Answered a question on");
    expect(write.op).toEqual({ list: "questions", action: "close", answer: "Per seat", at: SEP_21 });
    expect(write.pick).toMatchObject({ text: "per seat", retry: 'cast initiative answer in-3 <n> "<answer>"' });
    expect((answerWrite("in-3", "1", "Per seat", { replace: true }) as RecordWrite)).toEqual({
      verb: "Replaced the answer to a question on", op: { list: "questions", action: "close", answer: "Per seat" }, pick: { text: "1", retry: 'cast initiative answer in-3 <n> "<answer>"' },
    });
    expect(answerWrite("in-3", "1", "Per seat", { at: "none" })).toEqual({ error: 'Invalid --at "none": use YYYY-MM-DD, or YYYY-MM-DDTHH:MM for a time' });
  });

  test("source: when it was said is a moment, so a day typed reads back as that day", () => {
    const write = sourceWrite("call:cl-42#14", { quote: "our goal is $250 or less", by: "Ashot", at: "2026-10-03" }, NOW) as RecordWrite;
    expect(write).toEqual({ verb: "Added a source to", op: { list: "sources", action: "add", entry: { kind: "call", ref: "cl-42:14", quote: "our goal is $250 or less", by: "Ashot", at: new Date(2026, 9, 3, 12).getTime() } } });
    expect(sourceLine(write.op.entry as any, 1, NOW)).toBe('  1. Ashot, call:cl-42:14, yesterday: "our goal is $250 or less"');
    const older = sourceWrite("ct-12", { at: "2026-09-01" }, NOW) as RecordWrite;
    expect(sourceLine(older.op.entry as any, 1, NOW)).toBe("  1. ct-12, 1 Sep");
    expect(sourceWrite("the Sep 30 founder call", { quote: "our goal is $250" }, NOW)).toMatchObject({ op: { entry: { kind: "note", quote: "the Sep 30 founder call: our goal is $250" } } });
    expect(sourceWrite(" ", {})).toEqual({ error: SOURCE_NEEDED });
    expect(sourceWrite("ct-12", { at: "none" })).toEqual({ error: 'Invalid --at "none": use YYYY-MM-DD, or YYYY-MM-DDTHH:MM for a time' });
  });

  test("record --remove names its list, and the retry names it too", () => {
    expect(removeWrite("in-3", "sources", "call:cl-42#14")).toEqual({ verb: "Removed a source from", op: { list: "sources", action: "remove" }, pick: { text: "call:cl-42#14", retry: "cast initiative record in-3 --list sources --remove <n>" } });
    expect(removeWrite("in-3", "notes", "1")).toEqual({ error: 'Invalid --list "notes": milestones, questions, decisions, sources' });
  });
});

describe("cast initiative: the lines of the record", () => {
  test("a metric reads now against its target, the standing, the date and the trend", () => {
    const [cost, teams] = metricReadings(FULL);
    const trends = metricTrends(FULL);
    // The standing is said once, in the line's own words, and colors the line.
    expect(metricRecordLine(c, teams, trends[teams.key], NOW)).toBe("Weekly active teams: 412 of 1000, behind (yesterday) · up from 380, toward the target");
    expect(metricRecordLine(c, cost, trends[cost.key], NOW)).toBe("Cost per intro: not reported yet, target < $250");
    const tint = { ...c, yellow: "<y>", dim: "<d>", reset: "<r>" };
    expect(metricRecordLine(tint, teams, undefined, NOW)).toBe("<y>Weekly active teams: 412 of 1000, behind (yesterday)<r>");
    expect(metricRecordLine(tint, cost, undefined, NOW)).toBe("<d>Cost per intro: not reported yet, target < $250<r>");
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
  test("a write that moved nothing says so, and names what stands", () => {
    const add = sourceWrite("call:cl-42#14", {}) as RecordWrite;
    const stands = { short_id: "in-3", row: FULL, entry: FULL.sources[0], moved: false };
    expect(recordVerb(add, { ...stands, moved: true })).toBe("Added a source to");
    expect(recordVerb(add, stands)).toBe("Already on the record of");
    // A server that does not say whether it moved prints the write's own verb.
    expect(recordVerb(add, { short_id: "in-3", row: FULL, entry: FULL.sources[0] })).toBe("Added a source to");
    expect(recordVerb(milestoneWrite("in-3", undefined, { done: "1" }) as RecordWrite, { moved: false })).toBe("Nothing changed on");
    expect(recordWriteLines(c, recordVerb(add, stands), stands, "sources", NOW)).toEqual([
      "ok Already on the record of in-3: Win the private network",
      '  1. Ashot, call:cl-42:14, 4 days ago: "our goal is $250 or less per introduction"',
    ]);
  });
  test("a source typed again fills what the one on the record lacks, as one edit, and keeps what it says", () => {
    const bare = { kind: "session", ref: "jx7c6zk:142" };
    const typed = sourceWrite("jx7c6zk:142", { quote: "our goal is $250 or less", by: "Ashot", at: "2026-09-30" }, NOW) as RecordWrite;
    expect(sourceFillIn(typed, { entry: bare, moved: false })).toEqual({
      kept: [],
      write: { verb: "Updated a source on", op: { list: "sources", action: "edit", key: "session:jx7c6zk:142", entry: { quote: "our goal is $250 or less", by: "Ashot", at: new Date(2026, 8, 30, 12).getTime() } } },
    });
    // What the record already says is never overwritten; it is named.
    expect(sourceFillIn(typed, { entry: { ...bare, by: "Sam", quote: "under $250" }, moved: false })).toEqual({
      kept: ["the words", "who said it"],
      write: { verb: "Updated a source on", op: { list: "sources", action: "edit", key: "session:jx7c6zk:142", entry: { at: new Date(2026, 8, 30, 12).getTime() } } },
    });
    expect(sourceFillIn(typed, { entry: (typed.op.entry as any), moved: false })).toEqual({ kept: [] });
    // An add that landed, an older server and any other write have nothing to follow.
    expect(sourceFillIn(typed, { entry: typed.op.entry, moved: true })).toEqual({ kept: [] });
    expect(sourceFillIn(typed, { entry: bare })).toEqual({ kept: [] });
    expect(sourceFillIn(saidWrite("in-3", "questions", "Q?", {}) as RecordWrite, { entry: { key: "q", text: "Q?" }, moved: false })).toEqual({ kept: [] });
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

  Metrics each number against its target
  Cost per intro: not reported yet, target < $250 · cost_per_intro
  Weekly active teams: 412 of 1000, behind (yesterday) · up from 380, toward the target · weekly_active_teams · https://x.test/board
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

  Goals under it
  ◌ in-5 Broker outreach No update
`);
  });
  test("a bare goal says what its record lacks", () => {
    const text = show({ short_id: "in-1", title: "T", status: "proposed", health: "none", project_ids: [] });
    expect(text).toContain("  Owner none");
    expect(text).toContain("  Not on the record yet: why, done when, milestones, sources. cast goal --help lists the commands that write them.");
    expect(text).toContain("  None yet: cast goal add-project in-1 <project>");
    for (const absent of ["Why", "Done when", "Metrics", "Milestones", "questions", "Decisions", "Sources (", "Goals under it"]) expect(text).not.toContain(absent);
  });
});
