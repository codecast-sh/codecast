import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { envEval, envEvalLines, goalLevelLines, isRetryableWrite, recordRun, withWriteRetry, type Post } from "./envCommand";
import { compactCasePages } from "@codecast/shared/contracts/envs";

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();
const plain = { green: "", yellow: "", red: "", cyan: "", dim: "", bold: "", reset: "" };

// A runner whose per-case scores live in scores.txt, one "id score" a line.
const RUNNER = `#!/bin/sh
cases=$(awk '{printf "%s{\\"id\\":\\"%s\\",\\"score\\":%s}", (NR>1?",":""), $1, $2}' scores.txt)
mean=$(awk '{s+=$2} END {printf "%.4f", s/NR}' scores.txt)
n=$(wc -l < scores.txt | tr -d ' ')
printf '{"env":"acme/smoke","env_version":"v1","rung":"L0","candidate":{"label":"%s"},"split":"%s","cases":[%s],"summary":{"n":%s,"mean":%s},"started_at":"2026-11-17T00:00:00Z","finished_at":"2026-11-17T00:00:01Z"}' "$1" "$2" "$cases" "$n" "$mean" > "$3"
`;

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "envs-eval-")));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  fs.mkdirSync(path.join(dir, ".codecast"));
  fs.writeFileSync(path.join(dir, "run.sh"), RUNNER);
  fs.writeFileSync(path.join(dir, ".codecast/envs.toml"), `[[env]]\nkey="acme/smoke"\ntitle="Smoke"\nlevel="L0"\ncommand="sh run.sh {candidate} {split} {out}"\n`);
  fs.writeFileSync(path.join(dir, "scores.txt"), "a 0.5\nb 0.5\nc 0.4\nd 0.6\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "scores.txt"), "a 0.7\nb 0.8\nc 0.6\nd 0.8\n");
  git(dir, "commit", "-qam", "better");
  return { dir, base };
}

function api(levels: any[], goalRef = "in-9:intros_a_week", refuse?: (body: any) => string | null) {
  const calls: Array<{ path: string; body: any }> = [];
  const filed: any[] = [];
  const post: Post = async (p, body) => {
    calls.push({ path: p, body: structuredClone(body) });
    if (p === "/cli/work/get") return { short_id: "ct-5", goal_ref: goalRef };
    if (p === "/cli/envs/goal-levels") return { goal: { short_id: "in-9", title: "Intros" }, levels };
    if (p === "/cli/envs/record") {
      const why = refuse?.(body);
      if (why) throw new Error(why);
      filed.push(JSON.parse(String(body.result)));
      return { short_id: `ea-${filed.length}` };
    }
    if (p === "/cli/envs/list") return filed.map((r, i) => ({ short_id: `ea-${i + 1}`, candidate: r.candidate, env_version: r.env_version, split: r.split })).reverse();
    if (p === "/cli/envs/get") { const r = filed[Number(String(body.id).slice(3)) - 1]; return { cases: r.cases }; }
    // These envs keep no case sets in codecast: the server's answer, and the run goes on with none.
    if (p === "/cli/envs/cases/open") throw new Error(`${body.env} has no ${body.split} set in this workspace`);
    throw new Error(`unplanned ${p}`);
  };
  return { post, calls, filed };
}

const prevCwd = process.env.CODECAST_CWD;
afterEach(() => { if (prevCwd === undefined) delete process.env.CODECAST_CWD; else process.env.CODECAST_CWD = prevCwd; });

describe("envEval: the line's eval station", () => {
  test("runs the goal's L0 env on a base tree and on the branch, files both, and reads the paired delta", async () => {
    const { dir, base } = repo();
    process.env.CODECAST_CWD = dir;
    const { post, filed, calls } = api([{ env: "acme/smoke", level: "L0" }, { env: "acme/sim", level: "L3" }]);
    const rows = await envEval(post, { task: "ct-5", base, out: path.join(dir, "env-eval.json") });
    expect(rows).toHaveLength(1);
    expect(filed.map((r) => [r.candidate.label, r.summary.mean])).toEqual([["ct-5", 0.725], ["base", 0.5]]);
    expect(filed[1].candidate.sha).toBe(base);
    expect(calls.filter((c) => c.path === "/cli/envs/record").every((c) => c.body.goal === "in-9" && c.body.task_id === "ct-5")).toBe(true);
    expect(rows[0].delta).toMatchObject({ n: 4, delta: 0.225 });
    expect(envEvalLines(rows)[0]).toMatch(/^L0 acme\/smoke: \+0\.225 \[\+0\.\d+, \+0\.\d+\] over 4 cases, better; 0 cases worse, 4 better \(base ea-2, branch ea-1\)$/);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "env-eval.json"), "utf8"))).toMatchObject({ task: "ct-5", goal: "in-9", base });
    // The base tree is gone afterwards.
    expect(git(dir, "worktree", "list").split("\n")).toHaveLength(1);
  });

  test("a task with no goal, or a goal with no L0..L2 envs, runs nothing and files nothing", async () => {
    const { dir, base } = repo();
    process.env.CODECAST_CWD = dir;
    const none = api([], "");
    expect(await envEval(none.post, { task: "ct-5", base })).toEqual([]);
    expect(none.calls.map((c) => c.path)).toEqual(["/cli/work/get"]);
    const high = api([{ env: "acme/sim", level: "L3" }]);
    expect(await envEval(high.post, { task: "ct-5", base })).toEqual([]);
    expect(high.filed).toEqual([]);
  });

  test("an env the goal names but this repo no longer declares is reported, not run", async () => {
    const { dir, base } = repo();
    process.env.CODECAST_CWD = dir;
    const { post, filed } = api([{ env: "acme/removed", level: "L1" }]);
    const rows = await envEval(post, { task: "ct-5", base });
    expect(envEvalLines(rows)).toEqual(["L1 acme/removed: skipped: not declared in this repo's .codecast/envs.toml"]);
    expect(filed).toEqual([]);
  });
});

describe("envEval: what the review tried (jx78y5m)", () => {
  test("a dirty tree is filed with no sha, and neither it nor another task's run is reused as the base (H1)", async () => {
    const { dir } = repo();
    process.env.CODECAST_CWD = dir;
    const head = git(dir, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(dir, "scores.txt"), "a 0\nb 0\nc 0\nd 0\n");
    const a = api([{ env: "acme/smoke", level: "L0" }]);
    const rows = await envEval(a.post, { task: "ct-1", base: head });
    expect(a.filed[0].candidate).toEqual({ label: "ct-1" });
    expect(a.filed[1].candidate).toEqual({ label: "base", sha: head });
    expect(envEvalLines(rows)[0]).toMatch(/over 4 cases, worse; 4 cases worse, 0 better \(base ea-2, branch ea-1\)$/);
    // A second task on the base reuses the base run (ea-2), never ct-1's dirty one.
    git(dir, "checkout", "-q", "--", "scores.txt");
    const again = await envEval(a.post, { task: "ct-2", base: head });
    expect(again[0]).toMatchObject({ base: "ea-2", candidate: "ea-3" });
    expect(again[0].phrase).toMatch(/unchanged/);
  });

  test("the base's declaration grades both sides; a branch that changes its grader is reported, not scored (H4)", async () => {
    const { dir, base } = repo();
    process.env.CODECAST_CWD = dir;
    fs.writeFileSync(path.join(dir, ".codecast/envs.toml"), `[[env]]\nkey="acme/smoke"\ntitle="Smoke"\nlevel="L0"\ncommand="echo cheat"\n`);
    const a = api([{ env: "acme/smoke", level: "L0" }]);
    const rows = await envEval(a.post, { task: "ct-5", base });
    expect(rows[0].note).toMatch(/changes this env's declaration; the base's was run/);
    expect(rows[0].phrase).toMatch(/^\+0\.225/);
    fs.writeFileSync(path.join(dir, "run.sh"), fs.readFileSync(path.join(dir, "run.sh"), "utf8").replace('"env_version":"v1"', '"env_version":"v2"'));
    const b = api([{ env: "acme/smoke", level: "L0" }]);
    const changed = await envEval(b.post, { task: "ct-5", base });
    expect(changed[0].skipped).toMatch(/version v1 at the base, v2 here/);
    expect(changed[0].phrase).toBeUndefined();
  });

  test("one env failing is its own row; the others run and --out is written (M5)", async () => {
    const { dir, base } = repo();
    process.env.CODECAST_CWD = dir;
    const a = api([{ env: "acme/smoke", level: "L0" }, { env: "acme/new", level: "L1" }], "in-9", () => "server refused");
    const out = path.join(dir, "env-eval.json");
    const rows = await envEval(a.post, { task: "ct-5", base, out });
    expect(envEvalLines(rows)).toEqual(["L0 acme/smoke: could not score: server refused", "L1 acme/new: skipped: not declared in this repo's .codecast/envs.toml"]);
    expect(JSON.parse(fs.readFileSync(out, "utf8")).envs).toHaveLength(2);
    const down: Post = async (p) => { if (p === "/cli/work/get") throw new Error("fetch failed"); throw new Error("unplanned"); };
    expect(envEvalLines(await envEval(down, { task: "ct-5", base }))).toEqual(["ct-5: could not score: could not read the task: fetch failed"]);
    expect(git(dir, "worktree", "list").split("\n")).toHaveLength(1);
  });
});

describe("goalLevelLines", () => {
  test("each level: title, score with CI, noise, link with age, cost; a level never run says so", () => {
    const now = Date.parse("2026-11-17T12:00:00Z");
    const lines = goalLevelLines(plain, [
      { env: "acme/smoke", level: "L0", title: "Unit smoke", attempt: { short_id: "ea-3", candidate: { label: "base" }, split: "dev", n: 40, mean: 0.9, ci95: [0.85, 0.95], cost_usd: 0, finished_at: now - 3_600_000 } },
      { env: "acme/replay", level: "L2", note: "second side", attempt: { short_id: "ea-4", candidate: { label: "base" }, split: "held", n: 300, mean: 0.31, noise: { aa_sd: 0.012, aa_runs: 3 }, cost_usd: 4.2, finished_at: now }, link: { to: "L4:matched_to_opted_in", measure: "auc", value: 0.66, n: 300, measured_at: now - 2 * 86_400_000 } },
      { env: "acme/sim", level: "L3" },
    ], "in-9", now);
    expect(lines.join("\n")).toBe([
      "\n  Environments what predicts it, by level",
      "  L0 Unit smoke acme/smoke · Deterministic checks",
      "     0.900 [0.850, 0.950] n=40 base dev ea-3 1h ago · noise unmeasured · $0.00",
      "     link to the level above: not measured",
      "  L2 acme/replay Outcome-labelled replay · second side",
      "     0.310 n=300 base held ea-4 just now · A/A sd 0.012 over 3 runs · $4",
      "     link auc 0.66 to L4:matched_to_opted_in (n=300, 2d ago)",
      "  L3 acme/sim Forward simulation",
      "     no attempt yet · noise unmeasured",
      "     link to the level above: not measured",
    ].join("\n"));
  });

  test("an env with no title on its attempts takes this checkout's declared title, else prints its key once", () => {
    const lines = goalLevelLines(plain, [{ env: "acme/second-side-replay", level: "L2" }, { env: "acme/sim", level: "L3" }], "in-8", 0, (k) => (k === "acme/second-side-replay" ? "Second side replay" : undefined));
    expect(lines[1]).toBe("  L2 Second side replay acme/second-side-replay · Outcome-labelled replay");
    expect(lines[4]).toBe("  L3 acme/sim Forward simulation");
  });
});

describe("recordRun: a large attempt is filed in pages, each write retried (Acme in-9, 468 held cases)", () => {
  const decl = { key: "acme/replay", title: "Replay", level: "L2" as const, command: "true", splits: ["dev" as const] };
  const cases = Array.from({ length: 1200 }, (_, i) => ({ id: `second-side-pitch/${String(i).padStart(5, "0")}/${"x".repeat(60)}`, score: i % 4 ? 1 : 0 }));
  const result = { env: "acme/replay", env_version: "9f3a2c1d", level: "L2" as const, candidate: { label: "base" }, split: "dev" as const, cases, summary: { n: cases.length, mean: 0.75 }, started_at: Date.parse("2026-11-17T00:00:00Z"), finished_at: Date.parse("2026-11-17T00:01:00Z") };
  const pages = compactCasePages(cases);
  const refusal = "Too many writes per second: this deployment is limited to 4 MiB/s";

  function server(fail: (path: string, n: number) => string | null) {
    const calls: Array<{ path: string; body: any }> = [];
    const seen: Record<string, number> = {};
    const post: Post = async (p, body) => {
      calls.push({ path: p, body: structuredClone(body) });
      seen[p] = (seen[p] ?? 0) + 1;
      const why = fail(p, seen[p]);
      if (why) throw new Error(why);
      if (p === "/cli/envs/record") return { short_id: "ea-7", case_pages: pages.length, case_pages_written: 1 };
      if (p === "/cli/envs/record-cases") return { short_id: "ea-7", case_pages: pages.length, case_pages_written: Number(body.seq) + 1 };
      throw new Error(`unplanned ${p}`);
    };
    return { post, calls };
  }
  const waits: number[] = [];
  const quiet = { sleep: async (ms: number) => { waits.push(ms); }, onRetry: () => {} };

  test("the record carries the first page; each later page is its own write, in order", async () => {
    const { post, calls } = server(() => null);
    expect(pages.length).toBe(3);
    const filed = await recordRun(post, decl, "/tmp", result, { goal: "in-9" }, quiet);
    expect(filed.short_id).toBe("ea-7");
    expect(calls.map((c) => c.path)).toEqual(["/cli/envs/record", "/cli/envs/record-cases", "/cli/envs/record-cases"]);
    expect(calls.slice(1).map((c) => [c.body.seq, c.body.cases === pages[c.body.seq]])).toEqual([[1, true], [2, true]]);
    expect(JSON.parse(calls[0].body.result).cases).toHaveLength(1200);
  });

  test("a write-rate refusal is retried with backoff, the record under one client key, and the filing lands", async () => {
    waits.length = 0;
    const { post, calls } = server((p, n) => (p === "/cli/envs/record" && n <= 2) || (p === "/cli/envs/record-cases" && n === 2) ? refusal : null);
    expect((await recordRun(post, decl, "/tmp", result, { goal: "in-9" }, quiet)).short_id).toBe("ea-7");
    const records = calls.filter((c) => c.path === "/cli/envs/record");
    expect(records).toHaveLength(3);
    expect(new Set(records.map((c) => c.body.client_key)).size).toBe(1);
    expect(calls.filter((c) => c.path === "/cli/envs/record-cases").map((c) => c.body.seq)).toEqual([1, 2, 2]);
    expect(waits).toHaveLength(3);
    expect(waits[0]).toBeGreaterThanOrEqual(750);
    expect(waits[1]).toBeGreaterThanOrEqual(1500);
  });

  test("a refusal that does not pass throws at once; one that keeps coming gives up after six tries", async () => {
    const wrong = server((p) => (p === "/cli/envs/record" ? "The result for acme/replay breaks the contract: summary.mean 0.75 is not the mean" : null));
    await expect(recordRun(wrong.post, decl, "/tmp", result, {}, quiet)).rejects.toThrow(/breaks the contract/);
    expect(wrong.calls).toHaveLength(1);
    const busy = server((p) => (p === "/cli/envs/record-cases" ? refusal : null));
    await expect(recordRun(busy.post, decl, "/tmp", result, {}, quiet)).rejects.toThrow(/Too many writes/);
    expect(busy.calls.filter((c) => c.path === "/cli/envs/record-cases")).toHaveLength(6);
    expect(isRetryableWrite(new Error("HTTP 503"))).toBe(true);
    expect(isRetryableWrite(new Error("Attempt not found"))).toBe(false);
  });

  test("a server from before pages, which refuses client_key, takes the record whole", async () => {
    const calls: any[] = [];
    const old: Post = async (p, body) => {
      calls.push(structuredClone(body));
      if ("client_key" in body) throw new Error("ArgumentValidationError: Object contains extra field `client_key` that is not in the validator.");
      return { short_id: "ea-3" };
    };
    expect((await recordRun(old, decl, "/tmp", result, {}, quiet)).short_id).toBe("ea-3");
    expect(calls.map((b) => "client_key" in b)).toEqual([true, false]);
  });

  test("withWriteRetry returns the first answer that comes", async () => {
    let n = 0;
    expect(await withWriteRetry(async () => { if (++n < 3) throw new Error(refusal); return "ok"; }, quiet)).toBe("ok");
    expect(n).toBe(3);
  });
});
