import { describe, expect, test } from "bun:test";
import { authorReach, caseNotLive, countedReach, mergeTreeConflicts, parseShortstat, problemFacts, proposalProof, runCost, taskWorkspaceScope } from "./cardCommand.js";

describe("cast card build inputs", () => {
  test("parses git diff --shortstat in every plural form", () => {
    expect(parseShortstat(" 2 files changed, 18 insertions(+), 7 deletions(-)\n")).toEqual({ files: 2, added: 18, removed: 7 });
    expect(parseShortstat(" 1 file changed, 1 insertion(+)")).toEqual({ files: 1, added: 1, removed: 0 });
    expect(parseShortstat(" 1 file changed, 3 deletions(-)")).toEqual({ files: 1, added: 0, removed: 3 });
    expect(parseShortstat("")).toBeNull();
  });

  test("reads the conflicted paths from git merge-tree --name-only", () => {
    expect(mergeTreeConflicts("abc123\nf/a.jsonl\nf/a.jsonl\nf/b.jsonl\n")).toEqual(["f/a.jsonl", "f/b.jsonl"]);
    expect(mergeTreeConflicts("abc123\nf/a.jsonl\n\nAuto-merging f/a.jsonl\nCONFLICT (content)\n")).toEqual(["f/a.jsonl"]);
    expect(mergeTreeConflicts("abc123\n")).toEqual([]);
  });

  test("counts the stations' working minutes, never a run's wall clock or a waiting gate", () => {
    const runs = [
      { created_at: 0, updated_at: 1059 * 60_000, node_statuses: [{ started_at: 0, completed_at: 30 * 60_000 }, { started_at: 31 * 60_000, completed_at: 39 * 60_000 }, { started_at: 40 * 60_000 }] },
      { node_statuses: [] },
    ];
    expect(runCost(runs, { tokens: 1000, run_billed_usd: 0.4, run_list_usd: 51.2 })).toEqual({ tokens: 1000, minutes: 38, usd: 0.4, list_usd: 51.2 });
    expect(runCost(runs, { tokens: 1000, run_billed_usd: 0, run_list_usd: 51.2, minutes: 41 })).toEqual({ tokens: 1000, minutes: 41, usd: 0, list_usd: 51.2 });
    expect(runCost(runs, null)).toEqual({ tokens: 0, minutes: 38, usd: 0, list_usd: 0 });
  });

  test("a presenting station's bare covers become the card's reach, counted from the record", () => {
    const sg = (n: number, moment: string) => ({ _id: `s${n}`, short_id: `sg-${n}`, moment });
    const problem = problemFacts([sg(1, "mo-1"), sg(2, "mo-1"), sg(3, "mo-2")])!;
    const words = { question: "Should people asking for X hear Y?", recommend: "ship", why: "It answers both.", covers: ["sg-1", "sg-2"], page: "/tmp/p/page.html" };
    expect(authorReach(words, problem)).toEqual({ covers: ["sg-1", "sg-2"], of: 2, conversations: 1, read: ["sg-1", "sg-2", "sg-3"] });
    expect(authorReach({ ...words, covers: [] }, problem)).toMatchObject({ conversations: 0, of: 2 });
    // Unreadable findings: no count to make, so no reach rather than a guess.
    expect(authorReach(words, null)).toBeNull();
    expect(authorReach({ recommend: "drop", why: "x" }, problem)).toBeNull();
    // A written reach still wins over bare covers.
    expect(authorReach({ ...words, reach: { conversations: 9, of: 9, covers: ["sg-3"] } }, problem)).toMatchObject({ conversations: 1, of: 2, covers: ["sg-3"] });
  });

  test("a card's reach is counted from the record, not by its author", () => {
    const sg = (n: number, moment: string) => ({ _id: `s${n}`, short_id: `sg-${n}`, moment });
    const problem = problemFacts([sg(1, "mo-1"), sg(2, "mo-1"), sg(3, "mo-2")])!;
    expect(problem.conversations).toBe(2);
    expect(countedReach({ conversations: 9, of: 9, covers: ["sg-1", "sg-2", "sg-77"] }, problem)).toMatchObject({ conversations: 1, of: 2, read: ["sg-1", "sg-2", "sg-3"] });
    // tc-68: every finding left the problem, the author still wrote 1 of 1.
    expect(countedReach({ conversations: 1, of: 1, covers: ["sg-1547"] }, problemFacts([])!)).toMatchObject({ conversations: 0, of: 0 });
    expect(countedReach({ conversations: 1, of: 1 }, null)).toEqual({ conversations: 1, of: 1 });
  });
});

describe("taskWorkspaceScope", () => {
  test("reads the goal from the task's own workspace, not the shell's", () => {
    expect(taskWorkspaceScope({ workspace: "team:abc", project_id: "p1" })).toEqual({ workspace: "team", team_id: "abc", project: "p1" });
    expect(taskWorkspaceScope({ workspace: "user:u1" })).toEqual({ workspace: "personal" });
  });
});

describe("a proposal card's case and proof", () => {
  test("a case judged away is refused, naming the live findings to pick from (tc-26 cited sg-2470, retired; sg-2580 is live)", () => {
    expect(caseNotLive({ case: { signal: "sg-2470" } }, ["sg-2580"])).toBe("case.signal: sg-2470 is not one of this problem's live findings; pick one of sg-2580");
    expect(caseNotLive({ case: { signal: "sg-2580" } }, ["sg-2580"])).toBeNull();
    expect(caseNotLive({ case: null }, [])).toBeNull();
  });

  test("the proof's rung, outcome and prior art come from prove.json, not the author", () => {
    expect(proposalProof(JSON.stringify({ outcome: "red", rung: "replay", prior_art: "ct-59425 1eadcef23a: still red with it applied", check: "x" }))).toEqual({ rung: "replay", outcome: "red", prior_art: "ct-59425 1eadcef23a: still red with it applied" });
    expect(proposalProof(".json")).toBeNull();
    expect(proposalProof(JSON.stringify({ outcome: "red" }))).toBeNull();
  });
});
