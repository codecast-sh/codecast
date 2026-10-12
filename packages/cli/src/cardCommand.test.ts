import { describe, expect, test } from "bun:test";
import { caseNotLive, mergeTreeConflicts, parseShortstat, proposalProof, runCost, taskWorkspaceScope } from "./cardCommand.js";

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

  test("sums agent minutes over the task's runs and takes tokens and dollars from their priced sessions", () => {
    const runs = [
      { created_at: 0, updated_at: 30 * 60_000 },
      { created_at: 60_000, updated_at: 9 * 60_000 },
      { updated_at: 5 },
    ];
    expect(runCost(runs, { tokens: 1000, run_usd: 51.2 })).toEqual({ tokens: 1000, minutes: 38, usd: 51.2 });
    expect(runCost(runs, null)).toEqual({ tokens: 0, minutes: 38, usd: 0 });
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
