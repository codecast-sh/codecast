import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { armBrief, baseTree, expectHolds, gradePrompt, passes, readCheckpoint, replayCwd, runReplay, tally, type ReplayResult } from "./lineReplay";

function sh(cwd: string, cmd: string) {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/** A project in a git repo: a graph whose station reads a refreshed shared section, and one checkpoint of a run that reached it. */
function fixture() {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "line-replay-")));
  const root = path.join(top, "proj");
  fs.mkdirSync(path.join(root, "line", "g"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib"));
  fs.writeFileSync(path.join(root, "lib", "say.sh"), 'echo "{\\"rule\\": \\"$(cat "$1")\\"}"\n');
  fs.writeFileSync(path.join(root, "line", "g", "rule.txt"), "old rule");
  fs.writeFileSync(path.join(root, "line", "g", "work.md"), "Do the work. Rule: $shared.json.rule. Problem $task_id.");
  fs.writeFileSync(path.join(root, "line", "g.cast"), `digraph g {
  graph [goal="$task_title"]
  start [shape=Mdiamond] exit [shape=Msquare]
  shared [shape=parallelogram, refresh=true, script="bash lib/say.sh line/g/rule.txt"]
  work [label="Work", backend=session, prompt="@g/work.md"]
  start -> shared -> work -> exit
}`);
  sh(top, "git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm base");
  fs.writeFileSync(path.join(root, "line", "g", "rule.txt"), "new rule");
  const ckDir = path.join(top, ".git", "cast-line", "g-ct-1", "runs");
  fs.mkdirSync(ckDir, { recursive: true });
  fs.writeFileSync(path.join(ckDir, "run1.json"), JSON.stringify({
    completed: ["start", "shared", "work"],
    context: { task_id: "ct-1", task_title: "A thing breaks", project_path: root, "shared.json": JSON.stringify({ rule: "rule at run time" }) },
  }));
  return { top, root };
}

describe("scoring", () => {
  test("expect matches each field against its allowed values", () => {
    expect(expectHolds({ outcome: "red" }, { outcome: ["red", "infeasible"] })).toBe(true);
    expect(expectHolds({ outcome: "stopped" }, { outcome: ["red", "infeasible"] })).toBe(false);
    expect(expectHolds(null, { outcome: "red" })).toBe(false);
    expect(expectHolds({ outcome: "red" }, undefined)).toBe(null);
  });

  test("a graded case passes only on yes, and a failed expect fails it whatever the grade", () => {
    expect(passes({ run: "r", grade: "q" }, null, { answer: "yes", why: "" })).toBe(true);
    expect(passes({ run: "r", grade: "q" }, null, { answer: "no", why: "" })).toBe(false);
    expect(passes({ run: "r", grade: "q", expect: { outcome: "red" } }, false, { answer: "yes", why: "" })).toBe(false);
    expect(passes({ run: "r", expect: { outcome: "red" } }, true, null)).toBe(true);
  });

  test("tally counts runs that did not replay apart from misses", () => {
    const r = (arm: "base" | "work", status: ReplayResult["status"], pass?: boolean): ReplayResult => ({ run: "x", arm, rep: 1, status, pass, cost_usd: 1 });
    const t = tally([r("base", "done", false), r("base", "failed"), r("work", "done", true), r("work", "done", false)]);
    expect(t.base).toEqual({ n: 1, pass: 0, failed: 1, cost_usd: 2 });
    expect(t.work).toEqual({ n: 2, pass: 1, failed: 0, cost_usd: 2 });
  });

  test("the grader is not told which arm it reads", () => {
    const p = gradePrompt("Did it stop?", ["I stopped."], ["REFUSED cast decide"], null);
    expect(p).not.toMatch(/\b(base|work|arm|variant|old|new)\b/i);
  });
});

describe("arms", () => {
  test("each arm renders the station from its own files, with refresh stations made again", async () => {
    const { top, root } = fixture();
    const ck = JSON.parse(fs.readFileSync(path.join(top, ".git", "cast-line", "g-ct-1", "runs", "run1.json"), "utf8"));
    const work = await armBrief(root, "line/g.cast", "work", ck);
    const tree = baseTree(root, path.join(root, "line"), "HEAD", path.join(top, "base-tree"));
    const base = await armBrief(tree, "line/g.cast", "work", ck);
    if ("reason" in work || "reason" in base) throw new Error("not replayable");
    expect(work.brief).toContain("Rule: new rule. Problem ct-1.");
    expect(base.brief).toContain("Rule: old rule. Problem ct-1.");
    expect(work.isolated).toBe(false);
    // The base tree links everything outside the graph's directory to the real files.
    expect(fs.lstatSync(path.join(tree, "lib")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(tree, "line")).isSymbolicLink()).toBe(false);
  });

  test("an isolated station replays in a clone of the run's branch inside its own directory", () => {
    const { top, root } = fixture();
    sh(top, "git branch codecast/g-ct-1 && git -c user.email=t@t -c user.name=t commit -qam later");
    fs.mkdirSync(path.join(root, "node_modules"));
    const ck = readCheckpoint(root, "run1")!;
    expect(ck.branch).toBe("codecast/g-ct-1");
    const dir = path.join(top, "replay");
    fs.mkdirSync(dir);
    const at = replayCwd(root, ck, true, dir);
    if ("reason" in at) throw new Error(at.reason);
    expect(at.cwd).toBe(path.join(dir, "tree", "proj"));
    // The branch as the run left it, not the checkout's later commit.
    expect(fs.readFileSync(path.join(at.cwd, "line", "g", "rule.txt"), "utf8")).toBe("old rule");
    expect(fs.lstatSync(path.join(at.cwd, "node_modules")).isSymbolicLink()).toBe(true);
    expect(replayCwd(root, ck, false, dir)).toEqual({ cwd: root });
    expect(replayCwd(root, { ...ck, branch: "codecast/gone" }, true, path.join(top, "x"))).toEqual({ reason: "the run's branch codecast/gone is not in this repository" });
  });

  test("a run that never reached the station is not replayable", async () => {
    const { root } = fixture();
    const r = await armBrief(root, "line/g.cast", "work", { context: {}, completed: ["start"] });
    expect(r).toEqual({ reason: "the run never reached work" });
  });

  test("runReplay alternates arms per case and scores work against base", async () => {
    const { top, root } = fixture();
    const out = path.join(top, "out");
    fs.mkdirSync(out);
    const order: string[] = [];
    const harness = async (argv: string[]) => {
      const dir = argv[argv.indexOf("--run") + 1];
      const brief = fs.readFileSync(argv[argv.indexOf("--prompt") + 1], "utf8");
      const outcome = brief.includes("new rule") ? "red" : "stopped";
      order.push(outcome === "red" ? "work" : "base");
      fs.writeFileSync(path.join(dir, "out.json"), JSON.stringify({ result: "ok", total_cost_usd: 0.5 }));
      fs.writeFileSync(path.join(dir, "said.json"), JSON.stringify([`Done.\n\`\`\`json\n{"outcome": "${outcome}"}\n\`\`\``]));
      return 0;
    };
    const r = await runReplay({ root, cast: "line/g.cast", station: "work", cases: [{ run: "run1", expect: { outcome: "red" } }], base: "HEAD", reps: 2, out, concurrency: 1 }, { harness, harnessScript: "h.ts" });
    expect(order).toEqual(["base", "work", "work", "base"]);
    expect(r.tally.work).toMatchObject({ n: 2, pass: 2 });
    expect(r.tally.base).toMatchObject({ n: 2, pass: 0 });
    expect(r.p).not.toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(out, "summary.json"), "utf8")).tally.work.pass).toBe(2);
  });
});
