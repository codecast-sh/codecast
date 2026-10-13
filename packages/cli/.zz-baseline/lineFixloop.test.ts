import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { parseFindingLine, parseFindings, parseDue } from "./reviewFindings.js";
import { blameRemoved, isFixSubject, removedRanges, rollupByRole, selectFixCommits, traceFixes } from "./lineFixloop.js";
import { EMPTY_RESOLUTION } from "./blame.js";

describe("finding line grammar", () => {
  test("parses severity, file:line-range, text and a deferral tail", () => {
    const now = Date.parse("2026-10-06T00:00:00Z");
    const f = parseFindingLine("high src/a.ts:12-14 null deref on empty list -> deferred owner=@growth due=7d", now)!;
    expect(f).toMatchObject({ severity: "high", file_path: "src/a.ts", line_number: 12, line_end: 14, content: "null deref on empty list", disposition: "deferred", owner: "@growth" });
    expect(f.due_at).toBe(now + 7 * 86_400_000);
  });
  test("a whole-file finding and an ISO due date", () => {
    const f = parseFindingLine("nit README.md typo in heading -> fixed")!;
    expect(f).toMatchObject({ severity: "nit", file_path: "README.md", content: "typo in heading", disposition: "fixed" });
    expect(f.line_number).toBeUndefined();
    expect(parseDue("2026-11-01")).toBe(Date.parse("2026-11-01"));
    expect(parseDue("soon")).toBeUndefined();
  });
  test("free text stays free text", () => {
    const { findings, text } = parseFindings("Looks good overall.\nblocker convex/x.ts:3 deletes rows without a guard\nShip after that.");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("blocker");
    expect(text).toBe("Looks good overall.\nShip after that.");
    expect(parseFindingLine("fixed the thing in src/a.ts:3")).toBeNull();
  });
});

describe("fix commit selection", () => {
  test("subject convention, bug task and fix story", () => {
    const log = [
      { sha: "a", subject: "fix(sync): bound receipts", authorTime: 1 },
      { sha: "b", subject: "feat: add thing", authorTime: 2 },
      { sha: "c", subject: "Fix: typo", authorTime: 3 },
      { sha: "d", subject: "refactor", authorTime: 4 },
      { sha: "e", subject: "prefix", authorTime: 5 },
    ];
    const picked = selectFixCommits(log, { bugTaskShas: new Set(["b"]), fixStoryShas: new Set(["d"]) });
    expect(picked.map((p) => [p.sha, p.reason])).toEqual([["a", "subject_fix"], ["b", "task_bug"], ["c", "subject_fix"], ["d", "story_fix"]]);
    expect(isFixSubject("fixture: no")).toBe(false);
  });
  test("removed ranges come from the minus side of each hunk", () => {
    const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -3,2 +3,1 @@", "-old", "-old2", "+new", "@@ -10 +9,0 @@", "-gone", "@@ -20,0 +19,2 @@", "+added", "+added", "--- /dev/null", "+++ b/new.ts", "@@ -0,0 +1 @@", "+hello"].join("\n");
    expect(removedRanges(diff)).toEqual([{ file: "x.ts", start: 3, end: 4 }, { file: "x.ts", start: 10, end: 10 }]);
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } }).trim();
}

describe("parent blame mapping against a fixture repo", () => {
  test("a fix is traced to the commits whose lines it changed, not to itself", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fixloop-"));
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@t");
    git(dir, "config", "user.name", "t");
    fs.writeFileSync(path.join(dir, "a.ts"), "one\ntwo\nthree\n");
    git(dir, "add", "."); git(dir, "commit", "-q", "-m", "feat: first");
    const first = git(dir, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(dir, "a.ts"), "one\ntwo\nthree\nfour\n");
    git(dir, "commit", "-qam", "feat: second");
    const second = git(dir, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(dir, "a.ts"), "one\nTWO\nthree\nFOUR\nfive\n");
    git(dir, "commit", "-qam", "fix(a): uppercase two and four");
    const fix = git(dir, "rev-parse", "HEAD");

    const blamed = await blameRemoved(dir, fix, removedRanges(git(dir, "diff", "-U0", `${fix}^`, fix)));
    expect([...blamed.keys()].sort()).toEqual([first, second].sort());
    expect(blamed.get(first)!.lines).toBe(1);
    expect(blamed.get(second)!.lines).toBe(1);

    const traces = await traceFixes({ cwd: dir, since: "10 years ago", config: {}, resolve: async () => ({ ...EMPTY_RESOLUTION, bySha: new Map([[first, { conversation_id: "conv1", title: "t", role_handle: "growth", run_id: "run1" }]]) }) });
    expect(traces).toHaveLength(1);
    expect(traces[0].fix.sha).toBe(fix);
    expect(traces[0].introduced.map((i) => i.sha).sort()).toEqual([first, second].sort());
    expect(traces[0].introduced.find((i) => i.sha === first)!.session?.role_handle).toBe("growth");
    const roll = rollupByRole(traces);
    expect(roll.find((r) => r.role === "growth")).toMatchObject({ fixes: 1, introduced_commits: 1, lines: 1 });
    expect(roll.find((r) => r.role === "(no session)")).toMatchObject({ fixes: 1, introduced_commits: 1, lines: 1 });
  });
});
