// codecast's prove command (scripts/line.ts, line-profile.md LP4): the replay
// JSON it reads, and the majority rule a miss and a guard are held to.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { provenEntry, replayRuns, shipRange } from "./line";

const run = (status: string, score: number | null = null) => ({ status, score, gatesFailed: [], missedFloors: [] }) as any;

describe("scripts/line.ts prove", () => {
  test("reads the JSON array --json prints after the replay's progress lines", () => {
    const out = `[1/3] replaying fz-1\nrep 1 PASS\n${JSON.stringify([run("pass"), run("fail")], null, 2)}\n`;
    expect(replayRuns(out)?.map((r) => r.status)).toEqual(["pass", "fail"]);
    expect(replayRuns("[]\n")).toEqual([]);
    expect(replayRuns("no json here")).toBeNull();
  });

  test("a miss is shown when it fails by majority; a guard holds when it passes by majority; crashes count for nothing", () => {
    expect(provenEntry("fz-1", "miss", [run("fail"), run("fail"), run("pass")])).toEqual({ freeze: "fz-1", kind: "miss", passed: 1, scored: 3, ok: true });
    expect(provenEntry("fz-1", "miss", [run("pass"), run("pass"), run("fail")]).ok).toBe(false);
    // A tie is no pass, so a tied miss is shown and a tied guard does not hold.
    expect(provenEntry("fz-1", "miss", [run("pass"), run("fail")]).ok).toBe(true);
    expect(provenEntry("g-1", "guard", [run("pass"), run("fail")]).ok).toBe(false);
    expect(provenEntry("g-1", "guard", [run("pass"), run("pass"), run("crash")])).toEqual({ freeze: "g-1", kind: "guard", passed: 2, scored: 2, ok: true });
    expect(provenEntry("fz-2", "miss", [run("crash")])).toEqual({ freeze: "fz-2", kind: "miss", passed: 0, scored: 0, ok: false, error: "no rep scored" });
  });
});

describe("scripts/line.ts ship", () => {
  test("lands only the branch's own commits when the local default branch lags origin's", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "line-ship-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
    const commit = (file: string) => { writeFileSync(path.join(repo, file), `${file}\n`); git("add", file); git("commit", "-qm", file); };
    try {
      git("init", "-q", "-b", "main");
      commit("a.txt");
      git("checkout", "-q", "-b", "work");
      commit("upstream.txt");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      commit("change.txt");
      expect(git("diff", "--name-only", shipRange(repo, "main"))).toBe("change.txt");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a tree that already holds the change, as a session's own edits do, counts as landed; one without it gets the change", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "line-ship-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
    const ship = (tree: string) => execFileSync("bun", [path.join(import.meta.dir, "line.ts"), "ship", "--base", "main", "--tree", tree], { cwd: repo, encoding: "utf8" }).trim();
    try {
      git("init", "-q", "-b", "main");
      writeFileSync(path.join(repo, "a.txt"), "a\n");
      git("add", "a.txt");
      git("commit", "-qm", "a");
      git("worktree", "add", "-q", "--detach", "tree", "main");
      git("checkout", "-q", "-b", "work");
      writeFileSync(path.join(repo, "a.txt"), "a\nchanged\n");
      git("commit", "-qam", "change");
      writeFileSync(path.join(repo, "tree/a.txt"), "a\nchanged\n");
      expect(ship(path.join(repo, "tree"))).toStartWith("already in the working tree");
      writeFileSync(path.join(repo, "tree/a.txt"), "a\n");
      expect(ship(path.join(repo, "tree"))).toStartWith("applied to the working tree");
      expect(readFileSync(path.join(repo, "tree/a.txt"), "utf8")).toBe("a\nchanged\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
