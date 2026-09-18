// The asks view model (org-staffing.md S19): each ask joined to its rows with
// its state in words, the header count, the cost line, and the letter split
// for the author's first bubble. Run: bun test components/org/staffingAsks.test.ts
import { describe, expect, test } from "bun:test";
import { ORG_STAFFING_FIXTURE_PROPOSAL, ORG_STAFFING_FIXTURE_REVISED_PROPOSAL } from "./orgStaffingFixture";
import { askOfChange, asksProgress, costLine, letterIntro, letterParts, proposalAsks } from "./staffingAsks";
import type { BudgetArithmetic } from "./staffingModel";

describe("proposalAsks", () => {
  test("a proposal with no stored asks derives them, every live change in exactly one", () => {
    const asks = proposalAsks(ORG_STAFFING_FIXTURE_PROPOSAL);
    expect(asks.map((a) => a.title)).toEqual(["Bring 2 records up to date", "Add an agent: Head of Platform", "Add an agent: Content Lead", "4 smaller changes: filing, goals and settings"]);
    const seen = asks.flatMap((a) => a.changes.map((c) => c.seq)).sort((a, b) => a - b);
    expect(seen).toEqual(ORG_STAFFING_FIXTURE_PROPOSAL.changes.map((c) => c.seq));
    expect(asks.map((a) => a.index)).toEqual([0, 1, 2, 3]);
  });

  test("stored asks win, joined to the rows by seq, in apply order inside each", () => {
    const p = { ...ORG_STAFFING_FIXTURE_PROPOSAL, asks: [{ title: "Close the paperwork", why: "It is done.", effect: "Two records close.", seqs: [8, 7] }, { title: "Everything else", why: "Why.", effect: "Effect.", seqs: [1, 2, 3, 4, 5, 6] }] };
    const asks = proposalAsks(p);
    expect(asks.map((a) => a.title)).toEqual(["Close the paperwork", "Everything else"]);
    expect(asks[0].changes.map((c) => c.seq)).toEqual([8, 7], "tasks close before the plan that holds them");
    expect(asks[0].foldLabel).toBe("2 records");
    expect(asks[1].foldLabel).toBe("6 changes");
  });

  test("state and verdict line: open while anything waits, then accepted or skipped", () => {
    const asks = proposalAsks(ORG_STAFFING_FIXTURE_PROPOSAL);
    expect(asks[0].state).toBe("open");
    expect(asks[0].verdictLine).toBeNull();
    // The rest ask holds an accepted, a skipped and two proposed rows.
    expect(asks[3].state).toBe("open");
    expect(asks[3].verdictLine).toBe("2 of 4 changes decided");
    const flip = (status: string, seqs: number[]) => ({ ...ORG_STAFFING_FIXTURE_PROPOSAL, changes: ORG_STAFFING_FIXTURE_PROPOSAL.changes.map((c) => seqs.includes(c.seq) ? { ...c, status: status as any } : c) });
    expect(proposalAsks(flip("applied", [7, 8]))[0]).toMatchObject({ state: "accepted", verdictLine: "Accepted", remaining: 0 });
    expect(proposalAsks(flip("skipped", [7, 8]))[0]).toMatchObject({ state: "skipped", verdictLine: "Skipped" });
    const mixed = { ...ORG_STAFFING_FIXTURE_PROPOSAL, changes: ORG_STAFFING_FIXTURE_PROPOSAL.changes.map((c) => c.seq === 7 ? { ...c, status: "applied" as const } : c.seq === 8 ? { ...c, status: "skipped" as const } : c) };
    expect(proposalAsks(mixed)[0]).toMatchObject({ state: "accepted", verdictLine: "Accepted, 1 skipped" });
    expect(proposalAsks(flip("failed", [7]))[0]).toMatchObject({ state: "open", verdictLine: "1 change failed. Accept tries it again", failed: 1 });
  });

  test("a removed change belongs to no ask", () => {
    const asks = proposalAsks(ORG_STAFFING_FIXTURE_REVISED_PROPOSAL);
    expect(asks.flatMap((a) => a.changes).some((c) => c.status === "removed")).toBe(false);
    expect(askOfChange(asks, "fixture-change-92")).toBeNull();
    expect(askOfChange(asks, "fixture-change-93")?.title).toMatch(/smaller changes/);
  });

  test("the header counts asks, not rows", () => {
    expect(asksProgress(proposalAsks(ORG_STAFFING_FIXTURE_PROPOSAL))).toEqual({ decided: 0, total: 4, remaining: 4 });
    expect(asksProgress([])).toEqual({ decided: 0, total: 0, remaining: 0 });
  });
});

describe("costLine", () => {
  const b = (today: number, after: number, lines = 1): BudgetArithmetic => ({
    today: { hands_per_day: 0, wakes_per_day: 0, tokens_per_day: today },
    after: { hands_per_day: 0, wakes_per_day: 0, tokens_per_day: after },
    seats: 2, paused: 0,
    lines: Array.from({ length: lines }, () => ({ handle: "x", before: null, after: null, note: "" })),
  });
  test("says the share in words, less or more", () => {
    expect(costLine(b(1000, 750))).toBe("If you accept everything, the daily limits add up to about a quarter less");
    expect(costLine(b(1000, 1100))).toBe("If you accept everything, the daily limits add up to about a tenth more");
    expect(costLine(b(1000, 500))).toBe("If you accept everything, the daily limits add up to about half less");
    expect(costLine(b(1000, 1660))).toBe("If you accept everything, the daily limits add up to about two thirds more");
    expect(costLine(b(1000, 2100))).toBe("If you accept everything, the daily limits add up to about double");
    expect(costLine(b(1000, 3200))).toBe("If you accept everything, the daily limits add up to about 3 times as much");
    expect(costLine(b(1000, 50))).toBe("If you accept everything, the daily limits add up to almost nothing");
    expect(costLine(b(1000, 1010))).toBe("If you accept everything, the daily limits add up to about the same");
  });
  test("the edges: nothing moves, a first limit, no limit left", () => {
    expect(costLine(b(1000, 1000, 0))).toBe("If you accept everything, the daily limits stay as they are");
    expect(costLine(b(0, 800))).toBe("If you accept everything, the agents get their first daily limit");
    expect(costLine(b(800, 0))).toBe("If you accept everything, no agent has a daily limit left to use");
  });
});

describe("the letter", () => {
  test("a short letter shows whole; a long one leads with its opening and folds the rest", () => {
    expect(letterParts("One paragraph.")).toEqual({ lead: "One paragraph.", rest: "", evidenceHref: null });
    const long = ["A".repeat(500), "B".repeat(500), "C".repeat(100), "Evidence: https://codecast.sh/a/x"].join("\n\n");
    const parts = letterParts(long);
    expect(parts.lead).toBe("A".repeat(500));
    expect(parts.rest).toBe(`${"B".repeat(500)}\n\n${"C".repeat(100)}`);
    expect(parts.evidenceHref).toBe("https://codecast.sh/a/x");
    const short = ["A".repeat(300), "B".repeat(300), "C".repeat(200)].join("\n\n");
    expect(letterParts(short)).toEqual({ lead: short, rest: "", evidenceHref: null });
    // One long paragraph: the lead ends at the last sentence under the limit, the rest folds.
    const sentence = "This sentence has forty characters in it. ";
    const block = sentence.repeat(30).trim();
    const cut = letterParts(block);
    expect(cut.lead.length).toBeLessThanOrEqual(900);
    expect(cut.lead.endsWith(".")).toBe(true);
    expect(`${cut.lead} ${cut.rest}`).toBe(block);
    // A paragraph with no sentence end to cut at shows whole rather than mid word.
    expect(letterParts("A".repeat(1000)).lead).toBe("A".repeat(1000));
  });
  test("the introduction names a role, or an agent with no name", () => {
    expect(letterIntro("Chief of Staff", true)).toBe("I am your Chief of Staff, an agent that looks at how the work here is organized and suggests changes. You decide each one, and nothing changes until you accept it.");
    expect(letterIntro("the agent that wrote this", false)).toMatch(/^I am an agent that looked at how the work here is organized/);
  });
});
