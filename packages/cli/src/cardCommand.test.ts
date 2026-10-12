import { describe, expect, test } from "bun:test";
import { mergeTreeConflicts, parseShortstat, runCost, taskWorkspaceScope } from "./cardCommand.js";

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
