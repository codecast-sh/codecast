import { describe, expect, test } from "bun:test";
import { packRecent, PIPELINE_COMMIT_FILES_MAX, PIPELINE_RECENT_MAX_BYTES, recentFiles, recentRefusal, type PipelineCommitIn } from "./pipeline";

const commit = (i: number, files: string[], subject = `change ${i}\n\nbody`): PipelineCommitIn => ({ sha: String(i).padStart(40, "0"), subject, at: 1_000_000 - i, files });
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

describe("packRecent", () => {
  test("each path is stored once; a commit's files index into them; subjects are their first line", () => {
    const r = packRecent([commit(0, ["api/a.ts", "web/b.ts"]), commit(1, ["web/b.ts", "docs/c.md"])]);
    expect(r.paths).toEqual(["api/a.ts", "web/b.ts", "docs/c.md"]);
    expect(r.commits.map((c) => c.files)).toEqual([[0, 1], [1, 2]]);
    expect(r.commits[0]).toMatchObject({ sha: "0".repeat(40), subject: "change 0", at: 1_000_000 });
    expect(recentFiles(r, r.commits[1])).toEqual(["web/b.ts", "docs/c.md"]);
    expect(r.dropped).toBe(0);
    expect(recentRefusal(r)).toBeNull();
  });

  test("at most 50 commits and 100 paths a commit", () => {
    const r = packRecent(Array.from({ length: 60 }, (_, i) => commit(i, Array.from({ length: 150 }, (_, j) => `f${j}`))));
    expect(r.commits).toHaveLength(50);
    expect(r.commits[0].files).toHaveLength(PIPELINE_COMMIT_FILES_MAX);
  });

  test("over the byte cap, the oldest commits are left out first, and counted", () => {
    // Every commit names 100 paths of its own, so the window cannot fit in 64 KB.
    const commits = Array.from({ length: 50 }, (_, i) => commit(i, Array.from({ length: 100 }, (_, j) => `pkg${i}/src/module_${j}/file.ts`)));
    const r = packRecent(commits);
    expect(r.dropped).toBeGreaterThan(0);
    expect(r.commits.length + r.dropped).toBe(50);
    expect(r.commits.map((c) => c.sha)).toEqual(commits.slice(0, r.commits.length).map((c) => c.sha));
    expect(bytes(r)).toBeLessThanOrEqual(PIPELINE_RECENT_MAX_BYTES);
    expect(bytes(packRecent(commits.slice(0, r.commits.length + 1), Infinity))).toBeGreaterThan(PIPELINE_RECENT_MAX_BYTES);
  });

  test("a block packRecent would not make is refused", () => {
    expect(recentRefusal({ paths: ["a"], commits: [{ sha: "x", subject: "", at: 0, files: [1] }], dropped: 0 })).toContain("path index");
    expect(recentRefusal({ paths: ["x".repeat(PIPELINE_RECENT_MAX_BYTES)], commits: [], dropped: 0 })).toContain("bytes, over");
  });
});
