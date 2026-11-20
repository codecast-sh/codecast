// A climb that builds on a pending change (ct-97276's sixth run): Frame
// targeted the moments still unfilled after ct-96939's refill, every
// candidate stacked that refill plus one more admission, and Screen paired
// them against plain main, so each inherited ct-96939's own +0.020. The card
// now names the stack; the climb's base is that change applied onto main's
// tip, and every candidate is measured beyond it.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runEnv, withTreeAt } from "../envCommand";
import { admit, gauge, screen, type ClimbIo } from "./engine";
import { baseWords, stackBase } from "./base";
import { hypothesisLine } from "./report";
import { CARD, ENVS, RUNNER } from "./dryrunFixture";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";
isolateCodecastDirEachTest("climb-stack-state-");
setDefaultTimeout(120_000);

let tmp: string, repo: string;
const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const write = (files: Record<string, string>) => { for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); } };
const commitOn = (branch: string, from: string, files: Record<string, string>) => { g("checkout", "-q", "-b", branch, from); write(files); g("add", "-A"); g("commit", "-q", "-m", branch); const sha = g("rev-parse", "HEAD"); g("checkout", "-q", "main"); return sha; };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "climb-stack-"));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  g("config", "user.email", "t@t"); g("config", "user.name", "t");
  write({ ".codecast/envs.toml": ENVS, "evals/run.mjs": RUNNER, "evals/grader.txt": "grade strictly\n", "prompt.txt": "pitch\n" });
  g("add", "-A"); g("commit", "-q", "-m", "base");
  process.env.FAKE_COUNTER = path.join(tmp, "counter");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("a pending branch is applied onto main's tip as a commit no branch points at; a patch too; a conflict refuses", () => {
  const old = g("rev-parse", "HEAD");
  const pending = commitOn("pending/refill", old, { "refill.txt": "0.20 line\n" });
  write({ "main-fix.txt": "env fix\n" }); g("add", "-A"); g("commit", "-q", "-m", "main moves on");
  const tip = g("rev-parse", "HEAD");
  const branches = g("branch", "--list");
  const stacked = stackBase(repo, tip, { ref: "pending/refill", task: "ct-96939" });
  if ("error" in stacked) throw new Error(stacked.error);
  expect(g("rev-list", "--parents", "-n", "1", stacked.sha).split(" ").slice(1)).toEqual([tip, pending]);
  expect(g("ls-tree", "--name-only", stacked.sha).split("\n")).toEqual(expect.arrayContaining(["refill.txt", "main-fix.txt"]));
  // Nothing in the checkout moved: its branch, its HEAD and its branches are as they were; the commit is kept by a ref.
  expect([g("rev-parse", "HEAD"), g("branch", "--list")]).toEqual([tip, branches]);
  expect(g("show-ref", `refs/codecast/climb-stack/${stacked.sha}`)).toContain(stacked.sha);
  // A branch that already holds the tip is taken as it is.
  const onTip = commitOn("pending/fresh", tip, { "fresh.txt": "x\n" });
  expect(stackBase(repo, tip, { ref: "pending/fresh" })).toEqual({ sha: onTip });
  // A patch is applied onto the tip.
  const patch = path.join(tmp, "refill.patch");
  fs.writeFileSync(patch, `${g("diff", old, pending)}\n`);
  const fromPatch = stackBase(repo, tip, { patch });
  if ("error" in fromPatch) throw new Error(fromPatch.error);
  expect(g("show", `${fromPatch.sha}:refill.txt`)).toBe("0.20 line");
  // A conflict with main refuses, and says to rebase.
  commitOn("pending/clash", old, { "prompt.txt": "a different pitch\n" });
  write({ "prompt.txt": "main's pitch\n" }); g("add", "-A"); g("commit", "-q", "-m", "main edits the pitch");
  expect(stackBase(repo, g("rev-parse", "HEAD"), { ref: "pending/clash" })).toEqual({ error: expect.stringContaining("conflicts with") });
  expect(stackBase(repo, tip, { ref: "nope" })).toEqual({ error: expect.stringContaining("not a branch or commit here") });
});

test("Screen pairs candidates against the stacked base: a candidate is credited only with its own effect beyond the pending change", async () => {
  const main = g("rev-parse", "HEAD");
  // ct-96939's refill: +0.02 on dev and held. A candidate stacks it and adds one more admission: +0.08 in all, +0.06 of its own.
  commitOn("pending/refill", main, { "effect.txt": "dev=0.02\nheld=0.02\n" });
  const stacked = stackBase(repo, main, { ref: "pending/refill", task: "ct-96939" });
  if ("error" in stacked) throw new Error(stacked.error);
  commitOn("climb/more", stacked.sha, { "effect.txt": "dev=0.08\nheld=0.08\n" });
  // A candidate built on plain main, without the stack, is not a candidate of this climb.
  commitOn("climb/unstacked", main, { "effect.txt": "dev=0.08\nheld=0.08\n" });
  const registry = new Map<string, any>();
  const io: ClimbIo = {
    root: repo,
    post: async (url, body) => {
      if (url === "/cli/envs/goal-levels") return { goal: { short_id: "in-1" }, levels: [{ env: "fake/floor", level: "L0" }, { env: "fake/replay", level: "L2", held: { version: "v1", size: 30, uploaded_at: 1, reads: 0, unfiled: 0 } }] };
      if (url === "/cli/envs/get") return registry.get(String(body.id)) ?? null;
      if (url === "/cli/envs/list" || url === "/cli/initiatives/get") return url === "/cli/envs/list" ? [] : null;
      throw new Error(`unexpected ${url}`);
    },
    run: async (decl, o) => {
      const r = await runEnv(decl, { dir: o.dir, candidate: o.label, split: o.split, sha: o.sha, quiet: true });
      if (!r.ok) return r;
      const short_id = `ea-${registry.size + 1}`;
      registry.set(short_id, { short_id, ...r.result, created_at: Date.now() });
      return { ok: true, result: r.result, short_id };
    },
    tree: (sha, fn) => withTreeAt(repo, sha, fn),
    evalResult: () => 0,
    log: () => {},
  };
  const dir = path.join(tmp, "run", "climb");
  const base = { sha: stacked.sha, from: "origin/main", fetched: true, head_behind: 0, head_ahead: 0, stack: { ref: "pending/refill", task: "ct-96939", sha: stacked.sha, onto: main } };
  const card = { ...CARD, levels: [{ env: "fake/replay", plausible_effect: 0.04 }], stack: { ref: "pending/refill", task: "ct-96939" } };
  const s0 = await gauge(io, dir, { card, base: stacked.sha, base_info: base });
  expect(s0.card.stack).toEqual({ ref: "pending/refill", task: "ct-96939" });
  expect(baseWords(s0.base_info!)).toContain("stacked: pending/refill (ct-96939, pending) applied onto");
  const s1 = await admit(io, dir, [{ branch: "climb/more", hypothesis: "one more admission", predicted_delta: 0.06 }, { branch: "climb/unstacked", hypothesis: "h", predicted_delta: 0.08 }]);
  expect(s1.candidates[1].why).toContain("does not start from the base");
  const s2 = await screen(io, dir);
  const delta = s2.candidates[0].dev["fake/replay"].delta;
  // Its own +0.06, not the +0.08 it would read against plain main.
  expect(delta).toBeGreaterThan(0.05);
  expect(delta).toBeLessThan(0.07);
  // Record reads the same number, and says it is beyond the pending change.
  expect(hypothesisLine(s2)).toContain("moved fake/replay by +0.0");
  expect(hypothesisLine(s2)).toContain("beyond ct-96939 (the base it stacks on) against the card's plausible +0.040");
});
