// The asks view model (org-staffing.md S19): each ask joined to its rows with
// its state in words, the header count, the cost line, and the letter split
// for the author's first bubble. Run: bun test components/org/staffingAsks.test.ts
import { describe, expect, test } from "bun:test";
import { ORG_STAFFING_FIXTURE_PROPOSAL, ORG_STAFFING_FIXTURE_REVISED_PROPOSAL } from "./orgStaffingFixture";
import { askOfChange, asksProgress, letterIntro, letterParts, proposalAsks } from "./staffingAsks";

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
    // Six rows in the ask; the fold counts five, because the limit among them is never a row (S23.2).
    expect(asks[1].foldLabel).toBe("5 changes");
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
    // A letter in the page's shape (an opening, one paragraph per ask, then
    // a bold heading) shows every ask: a real run wrote 233, 242, 184 and
    // 399 characters, and the limit alone folded the third ask.
    const shaped = ["O".repeat(233), "A".repeat(242), "B".repeat(184), "C".repeat(399), "**What I found**", "- a finding"].join("\n\n");
    expect(letterParts(shaped).lead).toBe(["O".repeat(233), "A".repeat(242), "B".repeat(184), "C".repeat(399)].join("\n\n"));
    expect(letterParts(shaped).rest).toBe("**What I found**\n\n- a finding");
    // Bold that opens a sentence is not a heading, and a page of prose before the first heading keeps the limit.
    expect(letterParts(["**The ask.** " + "A".repeat(600), "B".repeat(600)].join("\n\n")).rest).toBe("B".repeat(600));
    expect(letterParts(["A".repeat(800), "B".repeat(800), "C".repeat(800), "**Evidence**", "x"].join("\n\n")).lead).toBe("A".repeat(800));
    // A paragraph with no sentence end to cut at shows whole rather than mid word.
    expect(letterParts("A".repeat(1000)).lead).toBe("A".repeat(1000));
  });
  test("the introduction names a role, or an agent with no name", () => {
    expect(letterIntro("Chief of Staff", true)).toBe("I am your Chief of Staff, an agent that looks at how the work here is organized and suggests changes. You decide each one, and nothing changes until you accept it.");
    expect(letterIntro("the agent that wrote this", false)).toMatch(/^I am an agent that looked at how the work here is organized/);
  });
});

// Round 1 of the org eval (docs/architecture/org-eval.md): a letter longer
// than the shaped fold allows fell back to its introduction alone, so the
// reader saw no ask; and the page introduced an author who had already
// introduced itself.
import { introducesItself } from "./staffingAsks";
const long = (n: number) => Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} of a long paragraph.`).join(" ");

describe("letterParts keeps the first ask on the first screen", () => {
  test("an unshaped letter whose second paragraph opens the first ask keeps it in the lead", () => {
    const md = `${long(30)}\n\nFirst, correct the records. ${long(25)}\n\nSecond, add three roles. ${long(20)}`;
    const { lead, rest } = letterParts(md);
    expect(lead).toContain("First, correct the records.");
    expect(rest).toContain("Second, add three roles.");
  });
  test("the page's own introduction is skipped when the letter opens with one", () => {
    expect(introducesItself("I am the reviewer for the agents at Union. I read 30 days.")).toBe(true);
    expect(introducesItself("**I am the reviewer** for Union.")).toBe(true);
    expect(introducesItself("Union has no goal written down.")).toBe(false);
  });
});
