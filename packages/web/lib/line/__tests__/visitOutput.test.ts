import { describe, expect, test } from "bun:test";
import { decisionOutput, lineVisitOutput, visitOutput, visitOutputWords, type VisitOutputInput } from "../visitOutput";

const v = (over: Partial<VisitOutputInput> & { decided?: Partial<VisitOutputInput["decided"]> } = {}): VisitOutputInput => ({
  kind: "script", status: "done", reasoning: null, caseTitle: "Fee answer invents structure",
  ...over,
  decided: { outcome: null, words: "Done", result: null, toWords: null, ...over.decided },
});

describe("visitOutput", () => {
  test("an agent's long words are kept to whole sentences, never cut inside a figure (ct-59338 Propose)", () => {
    const said = "The missed-call follow-up instructions still script \"tried you by phone\" openers and give the dial as the reason to send (red check 0/20 on main); the proposal carries forward the unmerged ct-57467 prompt rewrite, which turns the check 20/20. A second sentence that would not fit the cap at all, so it is left off.";
    const words = visitOutputWords(visitOutput(v({ kind: "agent", reasoning: said })))!;
    expect(words.endsWith("turns the check 20/20.")).toBe(true);
    expect(words).not.toContain("…");
  });

  test("a script's printed JSON reads as its fields, in order, a few at most", () => {
    const o = visitOutput(v({ decided: { result: { dissolved: "judge_defect", moments: 2 } } }));
    expect(o).toEqual({ kind: "fields", fields: [{ key: "dissolved", value: "judge_defect" }, { key: "moments", value: "2" }], more: 0 });
    expect(visitOutputWords(o)).toBe("dissolved: judge_defect · moments: 2");
    const many = visitOutput(v({ decided: { result: { a: 1, b: "x", c: true, d: [1, 2], e: { nested: 1 }, f: null } } }));
    expect(many).toEqual({ kind: "fields", fields: [{ key: "a", value: "1" }, { key: "b", value: "x" }, { key: "c", value: "true" }], more: 1 });
  });

  test("a script that ended without its result says how it ended, never the arguments it echoed", () => {
    // Eval cut off mid-run (ct-57972): its preview is the arguments it started with.
    const echoed = { reps: "/Users/ashot/x/reps.json", dry: false, surfaces: ["broker.partial.channel-behavior"], freezes: 5, skipped: [] };
    const o = visitOutput(v({ status: "failed", decided: { result: echoed, words: "Interrupted before it finished" } }));
    expect(o).toEqual({ kind: "text", text: "Interrupted before it finished", tone: "bad" });
  });

  test("a file path in a field is left out: it says nothing at a glance", () => {
    expect(visitOutputWords(visitOutput(v({ decided: { result: { card_json: "/Users/ashot/src/x/card.json", card_html: "/Users/ashot/src/union-m…", n: 2 } } })))).toBe("n: 2");
  });

  test("errors a script reported on an exit 0 read as missing fields, in a bad tone", () => {
    expect(visitOutput(v({ decided: { result: { errors: ["wrong: is empty", "change: is empty"], card_json: "/x/card.json" } } }))).toEqual({ kind: "text", text: "2 missing fields", tone: "bad" });
  });

  test("an eval scope reads as what it picked", () => {
    expect(visitOutputWords(visitOutput(v({ decided: { result: { scoped: true, paths: ["a/x.njk", "b/y.njk"], select: "gate", unmapped: [] } } })))).toBe("2 prompt files, gate evals");
  });

  test("a printed JSON the runner capped still gives the fields its head holds", () => {
    const o = visitOutput(v({ raw: '{"task":"ct-1","title":"Profile emails","body":"long text cut of' }));
    expect(visitOutputWords(o)).toBe("task: ct-1 · title: Profile emails");
  });

  test("a printed line is the step's own words; a bare finished word, the title or the outcome is nothing", () => {
    expect(visitOutput(v({ decided: { words: "claimed ct-57382 for run a1" } }))).toEqual({ kind: "text", text: "claimed ct-57382 for run a1" });
    expect(visitOutput(v())).toBeNull();
    expect(visitOutput(v({ decided: { words: "handed on" } }))).toBeNull();
    expect(visitOutput(v({ decided: { words: "Fee answer invents structure" } }))).toBeNull();
    expect(visitOutput(v({ decided: { words: "Sent back", outcome: "sent back" } }))).toBeNull();
  });

  test("a field that repeats the problem's ref or title is left out", () => {
    const o = visitOutput(v({ caseRef: "ct-1", decided: { result: { task: "ct-1", title: "Fee answer invents structure", finding_count: 5 } } }));
    expect(visitOutputWords(o)).toBe("5 findings");
  });

  test("a script reads as one human field: its red checks, else its why, never a key dump", () => {
    const words = (result: Record<string, unknown>) => visitOutputWords(visitOutput(v({ decided: { result } })));
    expect(words({ ok: false, steps: [{ name: "typecheck", ok: false, detail: "exit 1" }, { name: "tripwires", ok: true }] })).toBe("1/2 pass, 1 red · typecheck: exit 1");
    expect(words({ ok: true, steps: [{ name: "typecheck", ok: true }, { name: "tripwires", ok: true }] })).toBe("2/2 pass");
    expect(words({ red: true, dir: "/x/cast-line", why: "the check fails (exit 1)" })).toBe("the check fails (exit 1)");
  });

  test("the outcome a result repeats is left out of its fields", () => {
    expect(visitOutputWords(visitOutput(v({ decided: { outcome: "proved", result: { outcome: "proved", tests: 4 } } })))).toBe("tests: 4");
  });

  test("an agent's finding or last message is text; an older run with neither links its session", () => {
    expect(visitOutput(v({ kind: "agent", reasoning: "## Finding\nThe rep asked for a percentage instead of the value track." })))
      .toEqual({ kind: "text", text: "The rep asked for a percentage instead of the value track." });
    expect(visitOutput(v({ kind: "agent", raw: "Fixed the prompt and reran the eval: 5 of 5 pass." })))
      .toEqual({ kind: "text", text: "Fixed the prompt and reran the eval: 5 of 5 pass." });
    expect(visitOutput(v({ kind: "agent", sessionHref: "/conversation/s1" }))).toEqual({ kind: "session", href: "/conversation/s1" });
    expect(visitOutputWords({ kind: "session", href: "/conversation/s1" })).toBeNull();
    expect(visitOutput(v({ kind: "agent" }))).toBeNull();
  });

  test("a person's visit is their choice and note", () => {
    expect(visitOutput(v({ kind: "person", answer: "Ship", reasoning: "looks right" }))).toEqual({ kind: "choice", choice: "Ship", note: "looks right" });
    expect(visitOutput(v({ kind: "person", decided: { toWords: "Revise" } }))).toEqual({ kind: "choice", choice: "Revise", note: null });
    expect(visitOutputWords(visitOutput(v({ kind: "person", answer: "Drop", reasoning: "not wanted" })))).toBe("Drop · not wanted");
    // The runner's generic outcome is not a choice anyone made.
    expect(visitOutput(v({ kind: "person", decided: { outcome: "failure" } }))).toBeNull();
  });

  test("a visit still running, waiting or superseded has produced nothing yet", () => {
    const done = { decided: { result: { a: 1 } } };
    expect(visitOutput(v({ ...done, status: "live" }))).toBeNull();
    expect(visitOutput(v({ ...done, status: "waiting" }))).toBeNull();
    expect(visitOutput(v({ ...done, superseded: true }))).toBeNull();
  });

  test("a decision and a run's visit read the same way", () => {
    const decided = { outcome: null, words: "Done", result: { dissolved: "judge_defect" }, to: "end", toLabel: "Dissolve", toWords: null };
    const fromDecision = decisionOutput("script", { status: "done", decided, reasoning: null, caseTitle: "T", received: { href: null } });
    const fromVisit = lineVisitOutput({ kind: "script", status: "done", decided, why: null, inferred: false, received: { href: null } as never }, { caseTitle: "T" });
    expect(fromDecision).toEqual(fromVisit);
    expect(lineVisitOutput({ kind: "script", status: "done", decided, why: null, inferred: true, received: { href: null } as never })).toBeNull();
  });
});
