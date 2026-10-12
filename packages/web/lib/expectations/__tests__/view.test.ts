// The expectations pages' derivations (the-line-model.md LM5): breaks per
// line and per document, the filters, the history timeline and the
// overview's order.
import { describe, expect, test } from "bun:test";
import { byArea, changePhrase, expectationsHref, filterCounts, filterLines, findingCauses, findingWords, historyEntries, howApplied, lineHeat, openProposals, sortOverview, sourceSpeaker, usageSummary } from "../view";

const line = (n: number, part: string, over: Record<string, unknown> = {}) => ({ id: `ex-p-${n}`, text: `Line ${n} about ${part}`, part, status: "active" as const, citations: [], added_in: 1, changed_in: 1, ...over });
const ACTIVE = [line(1, "Calls"), line(2, "Intros", { note: "Within a day, or an hour?" }), line(3, "Calls")];
const row = { usage: { since: 0, lines: { "ex-p-1": { d7: 2, d30: 5, findings: [] }, "ex-p-2": { d7: 0, d30: 1, findings: [] } } } };

describe("usage", () => {
  test("a line's heat: broken this week, this month, or quiet", () => {
    expect(lineHeat(row.usage.lines["ex-p-1"])).toBe("week");
    expect(lineHeat(row.usage.lines["ex-p-2"])).toBe("month");
    expect(lineHeat({ d7: 0, d30: 0, findings: [] })).toBe("quiet");
  });
  test("the document's breaks, lines broken and lines never cited", () => {
    expect(usageSummary(ACTIVE, row)).toEqual({ breaks7: 2, breaks30: 6, broken: 2, quiet: 1 });
    expect(usageSummary(ACTIVE, null)).toEqual({ breaks7: 0, breaks30: 0, broken: 0, quiet: 3 });
  });
});

describe("filters", () => {
  test("broken, never cited, open questions, and a search over words, area and id", () => {
    expect(filterLines(ACTIVE, row, "broken").map((e) => e.id)).toEqual(["ex-p-1", "ex-p-2"]);
    expect(filterLines(ACTIVE, row, "quiet").map((e) => e.id)).toEqual(["ex-p-3"]);
    expect(filterLines(ACTIVE, row, "questions").map((e) => e.id)).toEqual(["ex-p-2"]);
    expect(filterLines(ACTIVE, row, "all", "intros").map((e) => e.id)).toEqual(["ex-p-2"]);
    expect(filterCounts(ACTIVE, row)).toEqual({ all: 3, broken: 2, quiet: 1, questions: 1 });
  });
  test("areas keep first-seen order", () => {
    expect(byArea(ACTIVE).map(([a, ls]) => [a, ls.length])).toEqual([["Calls", 2], ["Intros", 1]]);
  });
});

test("a source's speaker comes from the row, keyed by kind and ref", () => {
  expect(sourceSpeaker({ sources: { "call:cl-1:4": { who: "Ana" } } }, { kind: "call", ref: "cl-1:4" })).toEqual({ who: "Ana" });
  expect(sourceSpeaker(null, { kind: "task", ref: "ct-1" })).toEqual({});
});

describe("history", () => {
  const versions = [
    { version: 2, summary: "Retire intros", how: "person" as const, applied_at: 300, applied_by: "Ana", active: 2, added: 0, changed: 0, retired: 1, proposal: "xp-3", proposed_by: "Ana" },
    { version: 1, summary: "Seed", how: "auto" as const, applied_at: 100, applied_by: "Ana", active: 3, added: 3, changed: 0, retired: 0, proposal: "xp-1", proposed_by: "Ana", from_session: true },
  ];
  const proposals = [
    { short_id: "xp-2", status: "dropped" as const, summary: "Too broad", changes: 1, base_version: 1, created_at: 150, resolved_at: 200 },
    { short_id: "xp-4", status: "open" as const, summary: "Open one", changes: 1, base_version: 2, created_at: 400 },
  ];
  test("versions and closed proposals in one timeline, newest first", () => {
    const h = historyEntries(versions, proposals);
    expect(h.map((e) => (e.kind === "version" ? `v${e.version}` : e.proposal))).toEqual(["v2", "xp-2", "v1"]);
    expect(h[1]).toMatchObject({ kind: "closed", status: "dropped", at: 200 });
  });
  test("how each version landed, and what it changed", () => {
    const [v2, v1] = historyEntries(versions, []) as any[];
    expect(howApplied(v2)).toBe("Applied by Ana");
    expect(howApplied(v1)).toBe("Applied on its own: every line it added quotes words a person said");
    expect(changePhrase({ added: 3, changed: 0, retired: 1 })).toBe("3 added, 1 retired");
    expect(changePhrase({ added: 0, changed: 0, retired: 0 })).toBe("no line changed");
  });
  test("open proposals, newest first", () => {
    expect(openProposals({ proposals: [...proposals, { ...proposals[1], short_id: "xp-5", created_at: 500 }] }).map((p) => p.short_id)).toEqual(["xp-5", "xp-4"]);
  });
});

test("the overview: waiting documents first, then the most broken; projects without one after", () => {
  const r = (id: string, over: Record<string, unknown>) => ({ _id: id, workspace: "team:t", project: { id, title: id }, version: 1, applied_at: 1, active: 3, retired: 0, parts: 1, open_proposals: 0, breaks7: 0, breaks30: 0, broken: 0, most_broken: [], ...over });
  const { documents, without } = sortOverview([r("b", { breaks30: 9 }), r("a", {}), r("c", { open_proposals: 1 }), r("z", { version: 0 }), r("y", { version: 0 })]);
  expect(documents.map((d) => d._id)).toEqual(["c", "b", "a"]);
  expect(without.map((d) => d._id)).toEqual(["y", "z"]);
});

test("links land on the project's Expectations tab, on one line when named", () => {
  expect(expectationsHref("pj-4")).toBe("/projects/pj-4?tab=expectations");
  expect(expectationsHref("pj-4", "ex-p-1")).toBe("/projects/pj-4?tab=expectations#ex-p-1");
});

describe("findings", () => {
  const LINE = "A message leads with the result.";
  const f = (title: string, detail?: string, cause?: string) => ({ short_id: title, title, detail, kind: "prompt_miss", source: "judge", created_at: 1, ...(cause ? { cause: { id: cause, short_id: cause, title: `Cause ${cause}`, status: "open" } } : {}) });
  test("a title that only restates the line gives way to the finding's detail", () => {
    expect(findingWords(f(`Not met: ${LINE}`, "The reply opened with three sentences of process."), LINE)).toBe("The reply opened with three sentences of process.");
    expect(findingWords(f("Reply buried the intro under an apology"), LINE)).toBe("Reply buried the intro under an apology");
    expect(findingWords(f(`Not met: ${LINE}`), LINE)).toBe(`Not met: ${LINE}`);
    expect(findingWords(f("Not met: A message leads", "It led with an apology."), LINE)).toBe("It led with an apology.");
    expect(findingWords(f("Not met: A message leads", `${LINE} (severity 5/10, ex-p-1) It led with an apology.`), LINE)).toBe("It led with an apology.");
  });
  test("the causes the findings opened, most findings first", () => {
    expect(findingCauses([f("a", undefined, "ct-1"), f("b", undefined, "ct-2"), f("c", undefined, "ct-2"), f("d")]).map((c) => [c.short_id, c.count])).toEqual([["ct-2", 2], ["ct-1", 1]]);
  });
});
