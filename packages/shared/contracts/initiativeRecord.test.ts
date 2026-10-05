// The intent record's pure half (initiatives-projects-role-page.md I5): reading
// a source the way people write one, the next milestone, a metric's trend, and
// the one reducer every edit of the four lists goes through (applyRecordOp).
import { describe, expect, test } from "bun:test";
import {
  appendScoreHistory,
  applyRecordOp,
  carryMetricScores,
  initiativeSignature,
  INITIATIVE_RECORD_MAX,
  INITIATIVE_RECORD_NOUN,
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
  recordOpNeedsSignature,
  storedEntry,
  trendWords,
  type InitiativeRecordOp,
  type InitiativeScore,
  type RecordOpResult,
} from "./initiative";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 4);
const score = (value: string, daysAgo: number): InitiativeScore => ({ value, observed_at: NOW - daysAgo * DAY, source: "https://x.test/board" });

describe("parseIntentSource", () => {
  test("reads each address as its kind", () => {
    expect(parseIntentSource("call:cl-42#14")).toEqual({ kind: "call", ref: "cl-42:14" });
    expect(parseIntentSource("call:CL-42:14")).toEqual({ kind: "call", ref: "cl-42:14" });
    expect(parseIntentSource("chat:m9x2")).toEqual({ kind: "chat", ref: "m9x2" });
    expect(parseIntentSource("doc:abc123")).toEqual({ kind: "doc", ref: "abc123" });
    expect(parseIntentSource("jx7c6zk:142")).toEqual({ kind: "session", ref: "jx7c6zk:142" });
    expect(parseIntentSource("jx7c6zk")).toEqual({ kind: "session", ref: "jx7c6zk" });
    expect(parseIntentSource("CT-12")).toEqual({ kind: "task", ref: "ct-12" });
    expect(parseIntentSource("pl-88")).toEqual({ kind: "plan", ref: "pl-88" });
    expect(parseIntentSource("https://example.com/board?x=1")).toEqual({ kind: "link", ref: "https://example.com/board?x=1" });
  });

  // One url reader (shared/entities parseEntityUrl) says what a codecast link
  // opens, so a pasted link and the short id name the same source.
  test("a codecast link or path reads as the object it opens", () => {
    expect(parseIntentSource("https://codecast.sh/conversation/jx7abcd")).toEqual({ kind: "session", ref: "jx7abcd" });
    expect(parseIntentSource("https://codecast.sh/tasks/CT-12 we agreed here")).toEqual({ kind: "task", ref: "CT-12", quote: "we agreed here" });
    expect(parseIntentSource("/plans/pl-9")).toEqual({ kind: "plan", ref: "pl-9" });
    expect(parseIntentSource("https://codecast.sh/calls/cl-42?turns=14")).toEqual({ kind: "call", ref: "cl-42:14" });
    // A page that is no source kind stays a link, and a path that opens nothing is words.
    expect(parseIntentSource("https://codecast.sh/projects/pr-1")).toEqual({ kind: "link", ref: "https://codecast.sh/projects/pr-1" });
    expect(parseIntentSource("/settings/billing")).toEqual({ kind: "note", quote: "/settings/billing" });
    // A link already stored as a link stays one: its stored shape is not read again.
    const stored = { kind: "link", ref: "https://codecast.sh/tasks/ct-12" };
    expect((applyRecordOp([], { list: "sources", action: "add", entry: stored }, { now: 1 }) as any).next).toEqual([stored]);
  });

  test("an address followed by words keeps the words as the quote", () => {
    expect(parseIntentSource('call:cl-42:14 "our goal is $250 or less per introduction"')).toEqual({ kind: "call", ref: "cl-42:14", quote: "our goal is $250 or less per introduction" });
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
    expect(intentSourceLabel({ kind: "call", ref: "cl-42:14" })).toBe("Call cl-42, line 14");
    expect(intentSourceLabel({ kind: "call", ref: "cl-42@12:34" })).toBe("Call cl-42 at 12:34");
    expect(intentSourceLabel({ kind: "call", ref: "cl-42" })).toBe("Call cl-42");
    expect(intentSourceLabel({ kind: "session", ref: "jx7c6zk:142" })).toBe("Session jx7c6zk, line 142");
    expect(intentSourceLabel({ kind: "link", ref: "https://www.example.com/a" })).toBe("example.com");
    expect(intentSourceLabel({ kind: "task", ref: "ct-12" })).toBe("ct-12");
    expect(intentSourceLabel({ kind: "note", quote: "x" })).toBe("Note");
    expect(intentSourceLine({ kind: "call", ref: "cl-42:14", by: "Ashot", at: NOW - 3 * DAY, quote: "brokers first" }, NOW)).toBe('Ashot, call:cl-42:14, 3 days ago: "brokers first"');
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

  test("a metric edit keeps what a key that stays reported, drops what a key that goes did, and moves a renamed one", () => {
    const wat = { key: "wat", name: "WAT", target: "1000" };
    const pay = { key: "paying_teams", name: "Paying teams", target: "40" };
    const board = { wat: score("412", 0), paying_teams: score("9", 0) };
    expect(carryMetricScores([wat, pay], [{ ...wat, target: "2000" }, pay], board)).toEqual(board);
    expect(carryMetricScores([wat, pay], [pay], board)).toEqual({ paying_teams: board.paying_teams });
    // Renamed in place: the new key takes the old one's values.
    const renamed = { key: "weekly_active_teams", name: "Weekly active teams", target: "1000" };
    expect(carryMetricScores([wat, pay], [renamed, pay], board)).toEqual({ weekly_active_teams: board.wat, paying_teams: board.paying_teams });
    // Swapped places: both keys stay, so nothing is a rename.
    expect(carryMetricScores([wat, pay], [pay, wat], board)).toEqual(board);
    expect(carryMetricScores([wat], [], board)).toBeUndefined();
    expect(carryMetricScores(undefined, [wat], undefined)).toBeUndefined();
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

describe("applyRecordOp", () => {
  const who = { by: "@ashot", now: 1_000, goal: "in-1" };
  const run = (prior: readonly any[] | undefined, op: InitiativeRecordOp, ctx = who): RecordOpResult => {
    const out = applyRecordOp(prior, op, ctx);
    if ("error" in out) throw new Error(out.error);
    return out;
  };
  const refusal = (prior: readonly any[] | undefined, op: InitiativeRecordOp): string => {
    const out = applyRecordOp(prior, op, who);
    return "error" in out ? out.error : "";
  };
  /** The op a result hands back, applied to the same list on another clock by another signer, writes the same list. */
  const replays = (prior: readonly any[], op: InitiativeRecordOp) => {
    const first = run(prior, op);
    expect(run(prior, first.op, { by: "@someone_else", now: 777_777, goal: "in-1" }).next).toEqual(first.next);
    return first;
  };

  test("a new entry is keyed by its words, numbered on a clash, and stored with its fields sorted", () => {
    const first = replays([], { list: "milestones", action: "add", entry: { title: "  Private beta open ", date: 5 } });
    expect(first.next).toEqual([{ date: 5, key: "private_beta_open", title: "Private beta open" }]);
    expect(first.op).toEqual({ list: "milestones", action: "add", entry: first.next[0] });
    expect(run(first.next, { list: "milestones", action: "add", entry: { title: "Private beta open" } }).entry.key).toBe("private_beta_open_2");
    const asked = replays([], { list: "questions", action: "add", entry: { text: "Per seat?" } });
    expect(JSON.stringify(asked.entry)).toBe('{"at":1000,"by":"@ashot","key":"per_seat","text":"Per seat?"}');
  });

  test("each written part is trimmed and cut to its limit, on an add, an edit and an answer", () => {
    const long = "x".repeat(1400);
    const d = run([], { list: "decisions", action: "add", entry: { text: `  ${long}  `, by: "b".repeat(120) } }).entry;
    expect([d.text.length, d.by.length]).toEqual([1000, 80]);
    expect(run([], { list: "milestones", action: "add", entry: { title: long } }).entry.title).toHaveLength(200);
    expect(run([{ key: "a", title: "A" }], { list: "milestones", action: "edit", key: "a", entry: { title: "  New  " } }).entry.title).toBe("New");
    expect(run([{ at: 1, key: "q", text: "Q?" }], { list: "questions", action: "close", key: "q", answer: long }).entry.answer).toHaveLength(1000);
  });

  test("the same key with the same words is a retried add; with other words it is another entry and takes a fresh key", () => {
    const prior = [{ at: 1, key: "entry", text: "Сколько стоит место?" }];
    const retry = run(prior, { list: "questions", action: "add", entry: { key: "entry", text: "Сколько стоит место?", at: 9 } });
    expect([retry.moved, retry.next, retry.entry]).toEqual([false, prior, prior[0]]);
    const other = replays(prior, { list: "questions", action: "add", entry: { key: "entry", text: "Кто владеет запуском?", at: 2, by: "Dana" } });
    expect(other.next.map((q) => [q.key, q.text])).toEqual([["entry", "Сколько стоит место?"], ["entry_2", "Кто владеет запуском?"]]);
    // A retry of an entry that was reached or answered since is still that entry.
    const reached = [{ done_at: 7, key: "ga", title: "GA" }];
    expect(run(reached, { list: "milestones", action: "add", entry: { key: "ga", title: "GA" } }).moved).toBe(false);
  });

  test("who signs: the maker when the add does not say, the name it gives, and nobody when it says null", () => {
    const add = (entry: Record<string, unknown>): InitiativeRecordOp => ({ list: "decisions", action: "add", entry });
    expect(recordOpNeedsSignature(add({ text: "D" }))).toBe(true);
    expect(recordOpNeedsSignature(add({ text: "D", by: "  " }))).toBe(true);
    expect(recordOpNeedsSignature(add({ text: "D", by: "Dana" }))).toBe(false);
    expect(recordOpNeedsSignature(add({ text: "D", by: null }))).toBe(false);
    expect(recordOpNeedsSignature({ list: "milestones", action: "add", entry: { title: "M" } })).toBe(false);
    expect(run([], add({ text: "D", by: " " })).entry.by).toBe("@ashot");
    expect(run([], add({ text: "D", by: "Dana" })).entry.by).toBe("Dana");
    const unsigned = replays([], add({ text: "D", by: null, at: 4 }));
    expect(unsigned.entry).toEqual({ at: 4, key: "d", text: "D" });
    // With no signer at hand the op still says nobody signed, so the server does not sign in the client's place.
    expect(run([], add({ text: "D" }), { now: 1, goal: "in-1" } as any).op.entry).toEqual({ at: 1, by: null, key: "d", text: "D" });
  });

  test("an add lands at the end, or at the place it names", () => {
    const prior = [{ key: "b", title: "B" }, { key: "c", title: "C" }];
    expect(run(prior, { list: "milestones", action: "add", entry: { key: "a", title: "A" } }).next.map((m) => m.key)).toEqual(["b", "c", "a"]);
    const back = replays(prior, { list: "milestones", action: "add", entry: { key: "a", title: "A" }, index: 0 });
    expect(back.next.map((m) => m.key)).toEqual(["a", "b", "c"]);
    expect(back.op.index).toBe(0);
    expect(run(prior, { list: "milestones", action: "add", entry: { key: "a", title: "A" }, index: 9 }).next.map((m) => m.key)).toEqual(["b", "c", "a"]);
    expect(refusal(prior, { list: "milestones", action: "add", entry: { title: "A" }, index: 1.5 })).toBe("An index is a whole number from 0");
  });

  test("a close said twice is one close: the first date stands unless the close names another", () => {
    const reached = replays([{ key: "a", title: "A" }], { list: "milestones", action: "close", key: "a" });
    expect(reached.next).toEqual([{ done_at: 1_000, key: "a", title: "A" }]);
    expect(reached.op).toEqual({ list: "milestones", action: "close", key: "a", at: 1_000 });
    const again = run(reached.next, { list: "milestones", action: "close", key: "a" }, { ...who, now: 5_000 });
    expect([again.moved, again.entry.done_at]).toEqual([false, 1_000]);
    expect(run(reached.next, { list: "milestones", action: "close", key: "a", at: 42 }).entry.done_at).toBe(42);

    const answered = replays([{ at: 1, key: "q", text: "Q?" }], { list: "questions", action: "close", key: "q", answer: " Yes " });
    expect(answered.next).toEqual([{ answer: "Yes", answered_at: 1_000, at: 1, key: "q", text: "Q?" }]);
    expect(answered.op).toEqual({ list: "questions", action: "close", key: "q", at: 1_000, answer: "Yes" });
    const repeat = run(answered.next, { list: "questions", action: "close", key: "q", answer: "Yes" }, { ...who, now: 5_000 });
    expect([repeat.moved, repeat.entry.answered_at]).toEqual([false, 1_000]);
    // Another answer is a new one, dated when it was given.
    expect(run(answered.next, { list: "questions", action: "close", key: "q", answer: "No" }, { ...who, now: 5_000 }).entry.answered_at).toBe(5_000);
    expect(refusal([{ at: 1, key: "d", text: "D" }], { list: "decisions", action: "close", key: "d" })).toContain("A decision is edited or removed");
    expect(refusal([{ at: 1, key: "q", text: "Q?" }], { list: "questions", action: "close", key: "q", answer: " " })).toBe("An answer needs words");
  });

  test("a time on the record is a real one, and a question or decision never loses its date", () => {
    const m = [{ key: "a", title: "A" }];
    for (const at of [NaN, 0, -5, Infinity]) expect(refusal(m, { list: "milestones", action: "close", key: "a", at })).toBe("When a milestone was reached is a time in milliseconds");
    expect(refusal(m, { list: "milestones", action: "edit", key: "a", entry: { date: NaN } })).toBe("A milestone's date is a time in milliseconds");
    expect(refusal([], { list: "questions", action: "add", entry: { text: "Q?", at: "soon" } })).toBe("A question's at is a time in milliseconds");
    const q = [{ at: 42, by: "Dana", key: "q", text: "Q?" }];
    const edited = replays(q, { list: "questions", action: "edit", key: "q", entry: { at: null, by: null, text: "Q, again?" } });
    expect(edited.entry).toEqual({ at: 42, key: "q", text: "Q, again?" });
    // A stored row that lost its date gets one, and the op carries it.
    const dated = replays([{ key: "d", text: "D" }], { list: "decisions", action: "edit", key: "d", entry: { text: "D2" } });
    expect(dated.entry).toEqual({ at: 1_000, key: "d", text: "D2" });
  });

  test("an edit clears a field with null, dates an answer it sets, and says nothing when nothing moved", () => {
    const reopened = run([{ done_at: 9, key: "a", title: "A" }], { list: "milestones", action: "edit", key: "a", entry: { done_at: null } });
    expect(reopened.next).toEqual([{ key: "a", title: "A" }]);
    const answered = replays([{ at: 1, key: "q", text: "Q?" }], { list: "questions", action: "edit", key: "q", entry: { answer: "Yes" } });
    expect(answered.entry).toEqual({ answer: "Yes", answered_at: 1_000, at: 1, key: "q", text: "Q?" });
    expect(run(answered.next, { list: "questions", action: "edit", key: "q", entry: { answer: null } }).entry).toEqual({ at: 1, key: "q", text: "Q?" });
    const prior = [{ key: "a", title: "A" }];
    const same = run(prior, { list: "milestones", action: "edit", key: "a", entry: { title: " A " } });
    expect([same.moved, same.next]).toEqual([false, prior]);
    expect(run(prior, { list: "milestones", action: "remove", key: "nope" }).moved).toBe(false);
    expect(run(prior, { list: "milestones", action: "remove", key: "a" }).next).toEqual([]);
  });

  test("a source is read from text or from its stored shape by the same address rules", () => {
    const task = replays([], { list: "sources", action: "add", entry: { text: "ct-12 said so", by: "Sam" } });
    expect(task.next).toEqual([{ by: "Sam", kind: "task", quote: "said so", ref: "ct-12" }]);
    expect(run(task.next, { list: "sources", action: "add", entry: { text: "our goal is ten brokers" } }).entry).toEqual({ kind: "note", quote: "our goal is ten brokers" });
    expect(run(task.next, { list: "sources", action: "add", entry: { kind: "task", ref: "CT-12" } }).moved).toBe(false);
    // The stored shape takes the parser's form: a call line, a lowercased task, a note with no address.
    expect(run([], { list: "sources", action: "add", entry: { kind: "call", ref: "CL-42#14" } }).entry).toEqual({ kind: "call", ref: "cl-42:14" });
    expect(run([], { list: "sources", action: "add", entry: { kind: "doc", ref: "abc1234" } }).entry).toEqual({ kind: "doc", ref: "abc1234" });
    expect(run([], { list: "sources", action: "add", entry: { kind: "note", ref: "x", quote: "said" } }).entry).toEqual({ kind: "note", quote: "said" });
    // A link is a web address and nothing else.
    expect(refusal([], { list: "sources", action: "add", entry: { kind: "link", ref: "javascript:alert(1)" } })).toBe("A link is an http or https address");
    expect(refusal([], { list: "decisions", action: "add", entry: { text: "D", source: { kind: "link", ref: "/settings/delete" } } })).toBe("A link is an http or https address");
    expect(refusal([], { list: "sources", action: "add", entry: { kind: "task", ref: "not a task" } })).toBe("Not the address of a task: not a task");
    expect(refusal([], { list: "sources", action: "add", entry: { text: "   " } })).toBe("A source needs an address or the words said");
  });

  test("an edited source is read again: new text whole, a field alone over what was there", () => {
    const prior = [{ at: 7, by: "Sam", kind: "note", quote: "hello" }];
    const reread = replays(prior, { list: "sources", action: "edit", key: "note:hello", entry: { text: "ct-12 said so" } });
    expect(reread.entry).toEqual({ at: 7, by: "Sam", kind: "task", quote: "said so", ref: "ct-12" });
    const quoted = replays(reread.next, { list: "sources", action: "edit", key: "task:ct-12", entry: { quote: "said otherwise", at: null } });
    expect(quoted.entry).toEqual({ by: "Sam", kind: "task", quote: "said otherwise", ref: "ct-12" });
    const two = [{ kind: "task", ref: "ct-1" }, { kind: "task", ref: "ct-2" }];
    expect(refusal(two, { list: "sources", action: "edit", key: "task:ct-1", entry: { ref: "ct-2" } })).toBe("That source is already on the record");
  });

  test("an op that cannot be applied says why, naming the goal", () => {
    const full = Array.from({ length: INITIATIVE_RECORD_MAX.milestones }, (_, i) => ({ key: `m${i}`, title: `M${i}` }));
    expect(refusal(full, { list: "milestones", action: "add", entry: { title: "One more" } })).toBe("A goal holds at most 12 milestones");
    expect(refusal([], { list: "milestones", action: "add", entry: { title: " " } })).toBe("A milestone needs a title");
    expect(refusal([], { list: "milestones", action: "add", entry: { title: "A", text: "x" } })).toBe("Not a field of a milestone: text");
    expect(refusal([], { list: "milestones", action: "close", key: "nope" })).toBe("No milestone nope on in-1");
    expect(refusal([], { list: "milestones", action: "edit", entry: { title: "x" } })).toBe("Name the milestone by its key");
    expect(Object.keys(INITIATIVE_RECORD_NOUN)).toEqual(["milestones", "questions", "decisions", "sources"]);
  });
});

describe("initiativeSignature", () => {
  const me = { _id: "u1", name: "Sam A", email: "sam@x.ai" };
  test("the @handle where the roster reads it back as the person, else their name, GitHub name or email", () => {
    expect(initiativeSignature({ ...me, github_username: "SamA" }, [{ ...me, github_username: "SamA" }])).toBe("@sama");
    expect(initiativeSignature(me, [me])).toBe("@sam");
    // Two people the handle cannot tell apart, or a roster that does not hold the person: the name.
    expect(initiativeSignature(me, [me, { _id: "u2", name: "Sam B", email: "sam@y.ai" }])).toBe("Sam A");
    expect(initiativeSignature(me, [])).toBe("Sam A");
    expect(initiativeSignature({ _id: "u3", email: "first.last@x.ai" }, [])).toBe("first.last@x.ai");
    expect(initiativeSignature(null, [])).toBeUndefined();
  });
});

describe("storedEntry", () => {
  test("drops cleared fields and sorts the rest, a source inside it too", () => {
    expect(JSON.stringify(storedEntry({ text: "T", key: "k", by: undefined, source: { ref: "ct-1", kind: "task", quote: "" }, at: 1 }))).toBe('{"at":1,"key":"k","source":{"kind":"task","ref":"ct-1"},"text":"T"}');
  });
});
