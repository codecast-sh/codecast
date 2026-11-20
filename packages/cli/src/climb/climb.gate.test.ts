// The eval gate under a time limit (ct-97276's sixth run: Union's proof-tree.sh
// waited three hours on an ssh whose remote process was gone).
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GATE_LIMIT_DEFAULT_S, gateLimitS, runGate, tailLines } from "./gate";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "climb-gate-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("a gate past its limit is stopped with its whole process group, and says what it last printed", async () => {
  // Like proof-tree.sh: a wrapper that prints, then waits on a child (the ssh) that never returns.
  const pidFile = path.join(tmp, "child.pid");
  const run = await runGate(`echo "proof tree at e1afa7d70"; echo "running the eval on the eval host"; sleep 60 & echo $! > ${pidFile}; wait`, { cwd: tmp, env: process.env, limitS: 1, log: path.join(tmp, "gate.log") });
  expect(run.timedOut).toBe(true);
  expect(run.ms).toBeLessThan(10_000);
  expect(run.tail).toContain("running the eval on the eval host");
  const child = Number(fs.readFileSync(pidFile, "utf8"));
  let alive = true;
  try { process.kill(child, 0); } catch { alive = false; }
  expect(alive).toBe(false);
});

test("a gate within its limit finishes with its own exit code", async () => {
  const run = await runGate("echo ok; exit 3", { cwd: tmp, env: process.env, limitS: 30, log: path.join(tmp, "gate.log") });
  expect([run.timedOut, run.code, run.tail]).toEqual([false, 3, "ok"]);
  expect(tailLines("")).toBe("(no output)");
});

test("the limit: declared in climb.toml at the base, else twice the longest gate this climb ran, else two hours", () => {
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); g("add", "-A"); g("commit", "-q", "-m", "a");
  const bare = g("rev-parse", "HEAD");
  expect(gateLimitS(repo, bare, [])).toEqual({ s: GATE_LIMIT_DEFAULT_S, from: "default" });
  // Union's full gate takes 25 to 60 minutes: twice the longest it took.
  expect(gateLimitS(repo, bare, [25 * 60_000, 60 * 60_000])).toEqual({ s: 2 * 60 * 60, from: "recent" });
  fs.mkdirSync(path.join(repo, ".codecast"));
  fs.writeFileSync(path.join(repo, ".codecast/climb.toml"), "[guard]\ntimeout_s = 5400\n");
  g("add", "-A"); g("commit", "-q", "-m", "declare");
  expect(gateLimitS(repo, g("rev-parse", "HEAD"), [60_000])).toEqual({ s: 5400, from: "declared" });
});
