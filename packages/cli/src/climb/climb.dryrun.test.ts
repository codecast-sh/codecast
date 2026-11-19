// The climb's dry run (flows.md FL10): a fake goal with fake environments
// that emit the env result contract, and five candidates on real branches of
// a scratch repo. Deterministic: one is truly better, one gains only on dev,
// one gains most but breaks the goal's floor check, one edits its grader, one
// does nothing. The climb must promote the truly better one, log the overfit
// and the guard refusal, refuse the grader edit, refuse the level too noisy
// to see one change, stop when the budget is spent, and pay for nothing twice
// when it resumes.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runEnv, withTreeAt } from "../envCommand";
import { ClimbStop, admit, bindPromoted, confirm, gauge, guard, promoteMode, readState, refuse, screen, type ClimbIo } from "./engine";
import { effectLine, filedLine, hypothesisLine, statusText, summaryText } from "./report";
import { climbIo } from "../climbCommand";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir.js";
isolateCodecastDirEachTest("climb-dry-state-");

setDefaultTimeout(120_000);

// The fake runner: 40 dev and 30 held cases scored 0.5 plus the tree's
// effect on that split plus a deterministic draw that moves with each run
// (the A/A spread). fake/noisy draws ten times wider. fake/floor fails a case
// when the tree pushes on people (pressure.txt). The version is a hash of
// the grader, so a tree that edits it reports another env.
const RUNNER = `
import fs from "node:fs";
import { createHash } from "node:crypto";
const [env, split, out] = process.argv.slice(2);
const counter = process.env.FAKE_COUNTER;
const shifts = (process.env.FAKE_SHIFT ?? "").split(",").map(Number);
const n = Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : "0") + 1;
fs.writeFileSync(counter, String(n));
const eff = {};
if (fs.existsSync("effect.txt")) for (const l of fs.readFileSync("effect.txt", "utf8").split("\\n")) { const [k, v] = l.split("="); if (k) eff[k.trim()] = Number(v); }
const version = createHash("sha256").update(fs.readFileSync("evals/grader.txt")).digest("hex").slice(0, 12);
const cases = [];
if (env === "fake/floor") {
  for (let i = 1; i <= (process.env.FAKE_VOID ? 4 : 5); i++) cases.push({ id: "f" + i, score: i === 3 && fs.existsSync("pressure.txt") ? 0 : 1 });
} else if (env === "fake/fit") {
  for (let i = 1; i <= 20; i++) cases.push({ id: "p" + i, score: Math.min(1, Math.max(0, 0.8 + (eff.fit ?? 0))) });
} else {
  const wide = env === "fake/noisy" ? 0.1 : 0.005;
  const count = split === "held" ? 30 : 40;
  for (let i = 1; i <= count; i++) {
    const draw = (((i * 7 + (process.env.FAKE_SAME ? 0 : n) * 13) % 9) - 4) * wide;
    const few = i % 5 === 0 ? (eff[split + "_few"] ?? 0) : 0;
    cases.push({ id: (split === "held" ? "h" : "d") + i, score: Math.min(1, Math.max(0, 0.5 + (eff[split] ?? 0) + few + draw + (shifts[n - 1] || 0))) });
  }
}
const mean = cases.reduce((a, c) => a + c.score, 0) / cases.length;
const now = new Date().toISOString();
fs.writeFileSync(out, JSON.stringify({ env, env_version: version, level: env === "fake/floor" ? "L0" : env === "fake/noisy" ? "L1" : "L2",
  candidate: { label: process.env.CODECAST_ENV_CANDIDATE }, split, cases, summary: { n: cases.length, mean, ...(process.env.FAKE_VOID && env === "fake/floor" ? { unscored: 1 } : {}) }, cost_usd: env === "fake/floor" ? 0 : 0.25, started_at: now, finished_at: now }));
`;

const ENVS = `
[[env]]
key = "fake/floor"
title = "Irreversible floor"
level = "L0"
command = "bun {root}/evals/run.mjs fake/floor {split} {out}"
splits = ["dev"]
protects = ["evals/**"]

[[env]]
key = "fake/noisy"
title = "A noisy sim"
level = "L1"
command = "bun {root}/evals/run.mjs fake/noisy {split} {out}"
splits = ["dev", "held"]
protects = ["evals/**"]

[[env]]
key = "fake/replay"
title = "Labelled replay"
level = "L2"
command = "bun {root}/evals/run.mjs fake/replay {split} {out}"
splits = ["dev", "held"]
cost_usd = 0.25
protects = ["evals/**"]

[[env]]
key = "fake/fit"
title = "Share of picks the fit read passes"
level = "L2"
command = "bun {root}/evals/run.mjs fake/fit {split} {out}"
splits = ["dev"]
protects = ["evals/**"]
role = "check"
tolerance = 0.02
`;

const CARD = {
  goal: "in-1", metric: "yes_rate", production_lift: 0.04, target: "matched to opted in, furthest behind its trajectory",
  levels: [{ env: "fake/noisy", plausible_effect: 0.05 }, { env: "fake/replay", plausible_effect: 0.04 }],
  budget: { usd: 1000, runs: 500 }, candidates: 6, hypotheses: ["lead with the need", "shorter pitch"],
};

// The fake runner's version: a hash of the base's grader.
const VERSION = new Bun.CryptoHasher("sha256").update("grade strictly\n").digest("hex").slice(0, 12);

describe("the climb's dry run", () => {
  let tmp: string, repo: string, dir: string, base: string;
  let runs = 0;
  const filed: string[] = [];
  const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  // The registry: every filed attempt as the server keeps it.
  let registry = new Map<string, any>();
  /** The goal's environments as `/cli/envs/goal-levels` serves them: the scoring levels hold a held set in codecast. */
  const HELD = { version: "v1", size: 30, uploaded_at: 1, reads: 0, unfiled: 0 };
  let standings: any[] = [];
  /** The goal row `/cli/initiatives/get` serves; null unless a test gives the goal a metric to read. */
  let goalRow: any = null;
  const TASK_AT = 1000;
  const io = (): ClimbIo => ({
    root: repo,
    post: async (url, body) => {
      if (url === "/cli/work/get") return { short_id: body.short_id, created_at: TASK_AT, goal_ref: body.short_id === "ct-9" ? "in-1:m" : body.short_id === "ct-12" ? "in-12:m" : null, parent: body.short_id === "ct-9" || body.short_id === "ct-12" ? { short_id: "ct-1" } : null };
      if (url === "/cli/envs/list") return [...registry.values()].filter((a) => a.env === body.env).reverse();
      if (url === "/cli/envs/get") return registry.get(String(body.id)) ?? null;
      if (url === "/cli/initiatives/get") return goalRow;
      if (url === "/cli/envs/goal-levels") return body.goal === "in-1" ? { goal: { short_id: "in-1" }, levels: standings } : null;
      throw new Error(`unexpected ${url}`);
    },
    run: async (decl, o) => {
      runs++;
      const r = await runEnv(decl, { dir: o.dir, candidate: o.label, split: o.split, sha: o.sha, quiet: true });
      if (!r.ok) return r;
      filed.push(`${o.label} ${decl.key} ${o.split}`);
      const short_id = `ea-${registry.size + 1}`;
      // As the server files it: the summary's counts sit on the attempt itself (convex/envs.ts record).
      registry.set(short_id, { short_id, ...r.result, ...(r.result.summary.unscored !== undefined ? { unscored: r.result.summary.unscored } : {}), task_id: o.task, created_at: Date.now() });
      return { ok: true, result: r.result, short_id };
    },
    tree: (sha, fn) => withTreeAt(repo, sha, fn),
    evalResult: (reps) => { const r = JSON.parse(fs.readFileSync(reps, "utf8")); return r.void ? 2 : r.worse ? 1 : 0; },
    log: () => {},
  });
  /** A filed base run from before the climb, as another session would have left it. */
  const fileOldBase = (short_id: string, finished_at: number, cases: unknown[]) =>
    registry.set(short_id, { short_id, env: "fake/replay", split: "dev", env_version: VERSION, candidate: { label: "base", sha: base }, cases, cost_usd: 0.25, created_at: finished_at, finished_at });
  const branch = (name: string, files: Record<string, string>) => {
    g("checkout", "-q", "-b", name, base);
    for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), text); }
    g("add", "-A");
    g("commit", "-q", "-m", name);
    g("checkout", "-q", "main");
  };
  const proposed = [
    { branch: "climb/good", hypothesis: "lead with the need the second side stated", predicted_delta: 0.05 },
    { branch: "climb/overfit", hypothesis: "match the phrasing the dev cases use", predicted_delta: 0.08 },
    { branch: "climb/pushy", hypothesis: "ask twice", predicted_delta: 0.1 },
    { branch: "climb/grader", hypothesis: "loosen the reader", predicted_delta: 0.2 },
    { branch: "climb/nothing", hypothesis: "reorder sentences", predicted_delta: 0.01 },
  ];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "climb-dry-"));
    repo = path.join(tmp, "repo");
    dir = path.join(tmp, "run", "climb");
    fs.mkdirSync(path.join(repo, ".codecast"), { recursive: true });
    fs.mkdirSync(path.join(repo, "evals"));
    fs.writeFileSync(path.join(repo, ".codecast/envs.toml"), ENVS);
    fs.writeFileSync(path.join(repo, "evals/run.mjs"), RUNNER);
    fs.writeFileSync(path.join(repo, "evals/grader.txt"), "grade strictly\n");
    // A grader module that imports an installed package: the climb holds that package still (protect.ts graderPackageDirs).
    fs.writeFileSync(path.join(repo, "evals/deps.mjs"), `import lib from "grader-lib";\nexport default lib;\n`);
    fs.writeFileSync(path.join(repo, "prompt.txt"), "pitch\n");
    // The product's eval gate, as the line profile names it: FAKE_GATE=worse makes it refuse.
    fs.mkdirSync(path.join(repo, "scripts"));
    fs.writeFileSync(path.join(repo, "scripts/gate.sh"), `[ "$FAKE_GATE" = void ] && { echo '{"void": true}' > "$run_dir/reps.json"; exit 0; }; [ "$FAKE_GATE" = worse ] && w=true || w=false; echo "{\\"worse\\": $w}" > "$run_dir/reps.json"\n`);
    fs.writeFileSync(path.join(repo, ".codecast/line.toml"), `[line.commands]\neval = "bash scripts/gate.sh"\n`);
    process.env.FAKE_COUNTER = path.join(tmp, "counter");
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    g("config", "user.email", "t@t"); g("config", "user.name", "t");
    g("add", "-A"); g("commit", "-q", "-m", "base");
    base = g("rev-parse", "HEAD");
    branch("climb/good", { "effect.txt": "dev=0.06\nheld=0.06\n" });
    branch("climb/overfit", { "effect.txt": "dev=0.08\nheld=0\n" });
    branch("climb/pushy", { "effect.txt": "dev=0.1\nheld=0.1\n", "pressure.txt": "ask twice\n" });
    branch("climb/grader", { "evals/grader.txt": "grade kindly\n", "effect.txt": "dev=0\nheld=0\n" });
    branch("climb/nothing", { "prompt.txt": "pitch, reordered\n" });
    runs = 0;
    filed.length = 0;
    registry = new Map();
    goalRow = null;
    standings = [{ env: "fake/floor", level: "L0" }, { env: "fake/noisy", level: "L1", held: HELD }, { env: "fake/replay", level: "L2", held: HELD }];
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test("promotes the truly better candidate, logs the overfit and the guard refusal, refuses the grader edit and the blind level", async () => {
    const s0 = await gauge(io(), dir, { card: CARD, base });
    const noisy = s0.levels.find((l) => l.env === "fake/noisy")!;
    const replay = s0.levels.find((l) => l.env === "fake/replay")!;
    expect(noisy.kept).toBe(false);
    expect(noisy.why).toContain("cannot see one change");
    expect(replay.kept).toBe(true);
    expect(replay.noise!.mde).toBeLessThan(0.04);
    expect(s0.card.budget).toEqual({ usd: 25, runs: 60 });
    expect(s0.notes.join(" ")).toContain("budget held to the default");

    const s1 = await admit(io(), dir, proposed);
    expect(s1.candidates.map((c) => c.status)).toEqual(["admitted", "admitted", "admitted", "refused", "admitted"]);
    expect(s1.candidates[3].why).toContain("evals/grader.txt");

    const s2 = await screen(io(), dir);
    expect(s2.candidates.find((c) => c.branch === "climb/nothing")!.status).toBe("dropped");
    expect(s2.candidates.filter((c) => c.status === "survivor").map((c) => c.branch)).toEqual(["climb/good", "climb/overfit", "climb/pushy"]);

    const s3 = await confirm(io(), dir);
    const over = s3.candidates.find((c) => c.branch === "climb/overfit")!;
    expect(over.status).toBe("overfit");
    expect(over.why).toContain("dev +0.08");

    const s4 = await guard(io(), dir);
    const pushy = s4.candidates.find((c) => c.branch === "climb/pushy")!;
    expect(pushy.status).toBe("guard_failed");
    expect(pushy.guard!.why).toContain("fake/floor");
    expect(s4.candidates.find((c) => c.status === "promoted")!.branch).toBe("climb/good");

    const sum = summaryText(s4);
    expect(sum).toContain("cand-1 promoted");
    expect(sum).toContain("Overfit cand-2");
    expect(sum).toContain("Guard refused cand-3");
    expect(sum).toContain("Refused cand-4");
    expect(sum).toMatch(/Cost: \$\d+\.\d\d of \$25\.00/);
    // The held split is run only for the base and the dev survivors.
    // The base runs twice on held, around the candidates (its held A/A).
    expect(filed.filter((f) => f.endsWith(" held")).sort()).toEqual(["base fake/replay held", "base fake/replay held", "cand-1 fake/replay held", "cand-2 fake/replay held", "cand-3 fake/replay held"]);
    expect(filed.some((f) => f.startsWith("cand-4"))).toBe(false);
    expect(s4.candidates.find((c) => c.status === "promoted")!.guard!.why).toContain("eval gate passed");
  });

  test("a resumed climb, and each station's replay of the ones before it, runs nothing it already ran", async () => {
    await gauge(io(), dir, { card: CARD, base });
    await admit(io(), dir, proposed);
    await screen(io(), dir);
    const paid = runs;
    await gauge(io(), dir, { card: CARD, base });
    await admit(io(), dir, proposed);
    await screen(io(), dir);
    expect(runs).toBe(paid);
    await confirm(io(), dir);
    await guard(io(), dir);
    const all = runs;
    await guard(io(), dir);
    expect(runs).toBe(all);
  });

  test("the product's eval gate refusing every survivor stops the climb", async () => {
    await gauge(io(), dir, { card: CARD, base });
    await admit(io(), dir, proposed);
    process.env.FAKE_GATE = "worse";
    try { await expect(guard(io(), dir)).rejects.toThrow("every survivor failed the guard"); } finally { delete process.env.FAKE_GATE; }
    expect(readState(dir)!.candidates.find((c) => c.branch === "climb/good")!.guard!.why).toContain("scored it worse");
  });

  test("the budget stops the climb when it is spent, and the record says where", async () => {
    await gauge(io(), dir, { card: { ...CARD, budget: { usd: 1.5, runs: 500 } }, base });
    await admit(io(), dir, proposed);
    const err = await screen(io(), dir).catch((e) => e);
    expect(err).toBeInstanceOf(ClimbStop);
    expect(err.code).toBe(4);
    const s = readState(dir)!;
    expect(s.ledger.usd).toBeLessThanOrEqual(1.5);
    expect(s.stopped).toContain("budget spent");
    expect(s.candidates.some((c) => c.status === "unscreened")).toBe(true);
  });

  test("a review refusal keeps a candidate out of every run", async () => {
    await gauge(io(), dir, { card: CARD, base });
    await admit(io(), dir, proposed);
    await refuse(io(), dir, "cand-3", "asks twice: pressure on people");
    await screen(io(), dir);
    expect(filed.some((f) => f.startsWith("cand-3"))).toBe(false);
    expect(readState(dir)!.candidates[2].why).toBe("review: asks twice: pressure on people");
  });

  test("a card naming no level that can see one change stops before anything is proposed", async () => {
    const err = await gauge(io(), dir, { card: { ...CARD, levels: [{ env: "fake/noisy", plausible_effect: 0.5 }] }, base }).catch((e) => e);
    expect(err.code).toBe(3);
    expect(readState(dir)!.levels[0].why).toContain("one change is held to 0.100");
  });

  test("base runs filed before the climb's task are reused; ones filed during the climb are not", async () => {
    // Three quiet base runs: a level with them would look sharper than it is.
    const flat = Array.from({ length: 40 }, (_, i) => ({ id: `d${i + 1}`, score: 0.5 }));
    for (const k of [1, 2, 3]) fileOldBase(`ea-9${k}`, 5000, flat);
    await gauge(io(), dir, { card: CARD, base, task: "ct-1" });
    expect(filed.filter((f) => f === "base fake/replay dev")).toHaveLength(3);
    filed.length = 0;
    for (const k of [1, 2, 3]) fileOldBase(`ea-9${k}`, 500, flat);
    const s = await gauge(io(), `${dir}-again`, { card: CARD, base, task: "ct-1" });
    expect(filed.filter((f) => f === "base fake/replay dev")).toHaveLength(0);
    expect(s.levels.find((l) => l.env === "fake/replay")!.base_attempts.sort()).toEqual(["ea-91", "ea-92", "ea-93"]);
  });

  // Regressions from the adversarial review (jx77c5d).
  test("a rename, a .gitattributes, committed node_modules and a duplicate commit are refused at admit", async () => {
    branch("climb/rename", { "effect.txt": "dev=0.06\nheld=0.06\n" });
    g("checkout", "-q", "climb/rename"); g("mv", "evals/grader.txt", "archive.txt"); g("commit", "-q", "-am", "mv"); g("checkout", "-q", "main");
    branch("climb/attrs", { ".gitattributes": "evals/grader.txt text eol=crlf\n", "effect.txt": "dev=0.06\n" });
    branch("climb/nm", { "node_modules/grader-lib/index.js": "module.exports = () => 1\n", "effect.txt": "dev=0.06\n" });
    await gauge(io(), dir, { card: CARD, base });
    const s = await admit(io(), dir, [
      { branch: "climb/rename", hypothesis: "h", predicted_delta: 0.05 },
      { branch: "climb/attrs", hypothesis: "h", predicted_delta: 0.05 },
      { branch: "climb/nm", hypothesis: "h", predicted_delta: 0.05 },
      { branch: "climb/good", hypothesis: "h", predicted_delta: 0.05 },
      { branch: "climb/good", hypothesis: "h again", predicted_delta: 0.05 },
    ]);
    expect(s.candidates.map((c) => c.status)).toEqual(["refused", "refused", "refused", "admitted", "refused"]);
    expect(s.candidates[0].why).toContain("evals/grader.txt");
    expect(s.candidates[1].why).toContain(".gitattributes");
    expect(s.candidates[2].why).toContain("node_modules");
    expect(s.candidates[4].why).toContain("same commit");
  });

  test("a broken seal stops the climb; a forged one changes no decision, and a forged attempt is refused", async () => {
    const store = await import("./store");
    await gauge(io(), dir, { card: CARD, base, task: "ct-1" });
    await admit(io(), dir, proposed);
    const file = path.join(store.climbHome(dir), "state.json");
    const sealed = fs.readFileSync(file, "utf8");
    const body = JSON.parse(JSON.parse(sealed).body);
    // An edit without the key breaks the seal.
    fs.writeFileSync(file, JSON.stringify({ seal: JSON.parse(sealed).seal, body: JSON.stringify({ ...body, card: { ...body.card, budget: { usd: 1e9, runs: 1e9 } } }) }));
    expect(() => readState(dir)).toThrow("changed outside cast climb");
    // With the key: the grader edit admitted and promoted, the budget raised. The replay derives all of it again.
    const grader = body.candidates.find((c: any) => c.branch === "climb/grader");
    store.writeSealed(dir, { ...body, card: { ...body.card, budget: { usd: 1e9, runs: 1e9 } }, candidates: body.candidates.map((c: any) => (c === grader ? { ...c, barred: undefined, status: "promoted" } : c)) });
    const s = await guard(io(), dir);
    expect(s.candidates.find((c) => c.branch === "climb/grader")!.status).toBe("refused");
    expect(s.candidates.find((c) => c.status === "promoted")!.branch).toBe("climb/good");
    expect(s.ledger.usd).toBeLessThanOrEqual(25);
    // A base held run pointed at a candidate's attempt is refused by what the registry says it is.
    const forged = readState(dir)!;
    forged.ledger.done["base|fake/replay|held|0"] = { attempt: forged.ledger.done["cand-2|fake/replay|held"].attempt };
    store.writeSealed(dir, forged);
    await expect(confirm(io(), dir)).rejects.toThrow("names ea-");
  });

  test("the promoted task must be a subtask of the climb's task under exactly its goal", async () => {
    await gauge(io(), dir, { card: CARD, base, task: "ct-1" });
    await admit(io(), dir, proposed);
    await expect(bindPromoted(io(), dir, "ct-12")).rejects.toThrow("not in-1");
    await expect(bindPromoted(io(), dir, "ct-5")).rejects.toThrow();
    expect((await bindPromoted(io(), dir, "ct-9")).promoted_task).toBe("ct-9");
  });

  test("a shift that moves every case together counts as noise, so a do-nothing change cannot win on it", async () => {
    // Base runs drift by ±0.03 together; pairing alone would call the level sharp.
    process.env.FAKE_SHIFT = "0.03,-0.03,0.03,0.05";
    try {
      await gauge(io(), dir, { card: { ...CARD, levels: [{ env: "fake/replay", plausible_effect: 0.1 }] }, base }).catch(() => {});
      const replay = readState(dir)!.levels.find((l) => l.env === "fake/replay")!;
      expect(replay.kept).toBe(false);
      expect(replay.noise!.mde).toBeGreaterThan(0.05);
    } finally { delete process.env.FAKE_SHIFT; }
  });

  test("the guard refuses a candidate that edits what the eval command starts, and keeps the goal's L0 checks from gauge", async () => {
    // The candidate is truly better on every env, but rewrites the gate the product's eval command runs.
    branch("climb/evalhack", { "scripts/gate.sh": `echo '{"worse": false}' > "$run_dir/reps.json"; echo hacked\n`, "effect.txt": "dev=0.2\nheld=0.2\n" });
    await gauge(io(), dir, { card: CARD, base });
    await admit(io(), dir, [{ branch: "climb/evalhack", hypothesis: "h", predicted_delta: 0.2 }]);
    const err = await guard(io(), dir).catch((e) => e);
    expect(err.message).toBe("every survivor failed the guard");
    expect(readState(dir)!.candidates[0].guard!.why).toContain("changes the files the product's eval command starts");
    expect(readState(dir)!.checks).toEqual(["fake/floor"]);
  });

  test("a runner's own directory is held still: a candidate that edits what the runner imports is refused", async () => {
    branch("climb/import", { "evals/lib/bonus.mjs": "export default 0.06\n", "effect.txt": "dev=0.06\nheld=0.06\n" });
    await gauge(io(), dir, { card: CARD, base });
    await expect(admit(io(), dir, [{ branch: "climb/import", hypothesis: "h", predicted_delta: 0.05 }])).rejects.toThrow("every candidate was refused");
    expect(readState(dir)!.candidates[0].why).toContain("evals/lib/bonus.mjs");
  });

  // From the second flow run (ct-97125): the shared checkout's node_modules are touched all day; only a new version or tarball moves a grade.
  const graderLib = (version: string, body: string) => {
    fs.mkdirSync(path.join(repo, "node_modules/grader-lib"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules/grader-lib/package.json"), JSON.stringify({ name: "grader-lib", version }));
    fs.writeFileSync(path.join(repo, "node_modules/grader-lib/index.js"), body);
  };
  test("a grader package whose version changes mid-climb measures the base again on the new state, keeping what the old runs cost", async () => {
    graderLib("1.0.0", "module.exports = 0\n");
    await gauge(io(), dir, { card: CARD, base });
    await admit(io(), dir, proposed);
    graderLib("2.0.0", "module.exports = 0\n");
    const s = await screen(io(), dir);
    expect(s.notes.join(" ")).toContain("measured again on the new state");
    expect(Object.keys(s.ledger.failed).filter((k) => k.startsWith("stale")).length).toBeGreaterThan(0);
    expect(s.levels.find((l) => l.env === "fake/replay")!.kept).toBe(true);
    expect(s.candidates.filter((c) => c.status === "survivor").map((c) => c.branch)).toEqual(["climb/good", "climb/overfit", "climb/pushy"]);
  });

  test("a held run's error text never reaches the record", async () => {
    const leaky = io();
    const run = leaky.run;
    leaky.run = async (decl, o) => (o.split === "held" && o.label !== "base" ? { ok: false, error: 'summary.mean got "SEALED Alice wants a cofounder"' } : run(decl, o));
    await gauge(leaky, dir, { card: CARD, base });
    await admit(leaky, dir, proposed);
    await screen(leaky, dir);
    await confirm(leaky, dir).catch(() => {});
    expect(summaryText(readState(dir)!)).not.toContain("SEALED");
  });

  test("the repo's committed climb.toml sets the ceiling a card may ask up to; an uncommitted edit moves nothing", async () => {
    fs.writeFileSync(path.join(repo, ".codecast/climb.toml"), `[budget]\nusd = 50\nruns = 100\n\n[goals."in-1".budget]\nusd = 400\nruns = 40\n`);
    g("add", "-A"); g("commit", "-q", "-m", "ceiling");
    base = g("rev-parse", "HEAD");
    fs.writeFileSync(path.join(repo, ".codecast/climb.toml"), `[budget]\nusd = 99999\nruns = 99999\n`);
    const s = await gauge(io(), dir, { card: { ...CARD, budget: { usd: 1000, runs: 1000 } }, base });
    expect(s.card.budget).toEqual({ usd: 400, runs: 40 });
    expect(s.notes.join(" ")).toContain("the goal's ceiling");
  });

  // Round three of the adversarial review (jx77c5d).
  test("a run that fails is counted, and no station runs it again", async () => {
    branch("climb/crash", { "effect.txt": "dev=oops\n", "crash.txt": "x\n" });
    const crashy = io();
    const run = crashy.run;
    let crashes = 0;
    crashy.run = async (decl, o) => (o.label === "cand-2" ? (crashes++, { ok: false, error: "runner crashed" }) : run(decl, o));
    await gauge(crashy, dir, { card: CARD, base });
    await admit(crashy, dir, [proposed[0], { branch: "climb/crash", hypothesis: "h", predicted_delta: 0.05 }]);
    await screen(crashy, dir);
    await confirm(crashy, dir);
    await guard(crashy, dir);
    expect(crashes).toBe(1);
    const s = readState(dir)!;
    expect(Object.keys(s.ledger.failed)).toEqual(["cand-2|fake/replay|dev"]);
    expect(s.ledger.usd).toBeGreaterThan(Object.values(s.ledger.done).filter((d: any) => !d.reused).reduce((a: number, d: any) => a + (d.usd ?? 0), 0) - 1e-9);
  });

  test("other sessions touching the shared node_modules (same version, new bytes and timestamps) stop nothing", async () => {
    graderLib("1.0.0", "module.exports = 0.00;\n");
    await gauge(io(), dir, { card: CARD, base });
    await admit(io(), dir, proposed);
    graderLib("1.0.0", "module.exports = 0.00; // rebuilt\n");
    const s = await screen(io(), dir);
    expect(s.notes.join(" ")).not.toContain("measured again");
    expect(s.candidates.some((c) => c.status === "survivor")).toBe(true);
  });

  test("a scoring level whose env names no protects is refused, since its runner's imports cannot show what grades", async () => {
    fs.writeFileSync(path.join(repo, ".codecast/envs.toml"), ENVS.replace(/cost_usd = 0\.25\nprotects = \["evals\/\*\*"\]/, "cost_usd = 0.25"));
    g("add", "-A"); g("commit", "-q", "-m", "unprotected");
    base = g("rev-parse", "HEAD");
    const err = await gauge(io(), dir, { card: CARD, base }).catch((e) => e);
    expect(err.code).toBe(5);
    expect(err.message).toContain("fake/replay (the card's L2 level) declares no protects");
    expect(runs).toBe(0);
  });

  test("an eval gate run through a package script pins the script it runs; a candidate that rewrites it is refused", async () => {
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { eval: "bash gate/gate.sh" } }));
    fs.mkdirSync(path.join(repo, "gate"));
    fs.writeFileSync(path.join(repo, "gate/gate.sh"), `echo '{"worse": false}' > "$run_dir/reps.json"\n`);
    fs.writeFileSync(path.join(repo, ".codecast/line.toml"), `[line.commands]\neval = "bun run eval"\n`);
    g("add", "-A"); g("commit", "-q", "-m", "gate via package script");
    base = g("rev-parse", "HEAD");
    branch("climb/gatehack", { "gate/gate.sh": `echo '{"worse": false}' > "$run_dir/reps.json"; echo always\n`, "effect.txt": "dev=0.2\nheld=0.2\n" });
    await gauge(io(), dir, { card: CARD, base });
    await admit(io(), dir, [{ branch: "climb/gatehack", hypothesis: "h", predicted_delta: 0.2 }]);
    await expect(guard(io(), dir)).rejects.toThrow("every survivor failed the guard");
    expect(readState(dir)!.candidates[0].guard!.why).toContain("changes the files the product's eval command starts");
  });

  // From the first real climb (Union in-9).
  test("a void L0 check is pending, never a pass: nothing is promoted until a re-run lands a real verdict", async () => {
    await gauge(io(), dir, { card: CARD, base });
    await admit(io(), dir, proposed);
    process.env.FAKE_VOID = "1";
    try {
      const err = await guard(io(), dir).catch((e) => e);
      expect(err).toBeInstanceOf(ClimbStop);
      expect(err.code).toBe(6);
      const s = readState(dir)!;
      expect(s.candidates.some((c) => c.status === "promoted")).toBe(false);
      expect(s.pending).toContain("unscored");
      // The pushy candidate fails at once on the cases both sides scored: a void never hides a real failure.
      expect(s.candidates.find((c) => c.branch === "climb/pushy")!.status).toBe("guard_failed");
      expect(summaryText(s)).toContain("held, ");
      // Reading it back costs nothing and stays void.
      const before = runs;
      await guard(io(), dir).catch(() => {});
      expect(runs).toBe(before);
    } finally { delete process.env.FAKE_VOID; }
    const s = await guard(io(), dir, { rerunVoid: true });
    expect(s.candidates.find((c) => c.status === "promoted")!.branch).toBe("climb/good");
    expect(s.pending).toBeUndefined();
  });

  test("a void eval gate holds promotion too, and its re-run counts against the run limit", async () => {
    await gauge(io(), dir, { card: CARD, base });
    await admit(io(), dir, proposed);
    process.env.FAKE_GATE = "void";
    try { expect((await guard(io(), dir).catch((e) => e)).code).toBe(6); } finally { delete process.env.FAKE_GATE; }
    const voidRuns = readState(dir)!.gate_runs!;
    const s = await guard(io(), dir, { rerunVoid: true });
    expect(s.candidates.find((c) => c.status === "promoted")).toBeTruthy();
    expect(s.gate_runs).toBe(voidRuns + 1);
  });

  test("the repo's climb.toml at the base says how a promoted change ships", async () => {
    expect(promoteMode(repo, base)).toBe("experiment");
    fs.writeFileSync(path.join(repo, ".codecast/climb.toml"), `[promote]\nmode = "line"\n`);
    g("add", "-A"); g("commit", "-q", "-m", "line mode");
    expect(promoteMode(repo, g("rev-parse", "HEAD"))).toBe("line");
    expect(promoteMode(repo, base)).toBe("experiment");
    fs.writeFileSync(path.join(repo, ".codecast/climb.toml"), `[promote]\nmode = "ab"\n`);
    g("add", "-A"); g("commit", "-q", "-m", "bad mode");
    expect(() => promoteMode(repo, g("rev-parse", "HEAD"))).toThrow('"line" or "experiment"');
  });

  test("before anything is spent, the card says whether production can confirm one change of its size", async () => {
    const WEEK = 7 * 24 * 3600 * 1000, monday = Date.UTC(2026, 8, 7);
    goalRow = {
      short_id: "in-1",
      metrics: [{ key: "yes_rate", name: "Yes rate", noise: "poisson:1.75", series: "mw-1", target: "at least 16", window: "3w" }],
      series: { "mw-1": { short_id: "mw-1", name: "Yes rate", unit: "/week", cohorts: [30, 17, 22, 19, 25, 16, 21, 18].map((value, i) => ({ at: monday + i * WEEK, value })), points: [{ at: monday + 10 * WEEK, value: 18 }] } },
    };
    const s = await gauge(io(), dir, { card: CARD, base });
    const r = s.readability as any;
    expect(r.readable).toBe(false);
    expect(r.weeks).toBeNull();
    expect(r.evidence).toContain("predictions read back over many climbs");
    expect(statusText(s)).toContain("production cannot confirm one change of +4% on yes_rate");
    const big = await gauge(io(), `${dir}-big`, { card: { ...CARD, production_lift: 3 }, base });
    expect((big.readability as any).readable).toBe(true);
    // A card that names the metric without a plausible lift is sent back to Frame.
    await expect(gauge(io(), `${dir}-none`, { card: { ...CARD, production_lift: undefined }, base })).rejects.toThrow("production_lift");
  });

  // From the first run of the climb through the flow (Union in-9, ct-97125): an L0 unit-test env with no case set in
  // codecast beside an L2 env with one. The station ran 50 minutes and ended on a refusal, filing nothing.
  test("an env with no case set in codecast runs as before beside one that has a set, through the climb's own runs", async () => {
    const opened: string[] = [];
    const recorded: any[] = [];
    // The server as the climb's posts meet it: a refusal is an error the caller reads (apiPost with exitOnError off).
    const post = async (url: string, body: any) => {
      if (url === "/cli/envs/cases/open") {
        opened.push(body.env);
        if (body.env === "fake/floor") throw new Error(`${body.env} has no dev set in this workspace: the product's runner uploads one with cast env cases put ${body.env} --split dev --file <json>`);
        return { read: "cr-1", version: "v1", size: 1 };
      }
      if (url === "/cli/envs/cases/page") return { cases: [{ id: "d1", payload: JSON.stringify({ text: "a moment" }) }], next: null };
      if (url === "/cli/envs/record") {
        const r = JSON.parse(body.result);
        const short_id = `ea-${registry.size + 1}`;
        recorded.push({ env: body.env, cases_read: body.cases_read });
        registry.set(short_id, { short_id, ...r, created_at: Date.now(), task_id: body.task_id });
        return { short_id };
      }
      return io().post(url, body);
    };
    const card = { ...CARD, levels: [{ env: "fake/floor" }, { env: "fake/replay", plausible_effect: 0.04 }] };
    const s = await gauge(climbIo(post, repo, null), dir, { card, base });
    expect(s.levels.map((l) => [l.env, l.kept])).toEqual([["fake/floor", true], ["fake/replay", true]]);
    expect(opened).toEqual(["fake/floor", "fake/replay", "fake/replay", "fake/replay"]);
    // The L0 env ran on its own cases and was filed; the L2 runs were filed against the set they read.
    expect(recorded).toEqual([{ env: "fake/floor", cases_read: undefined }, ...[1, 2, 3].map(() => ({ env: "fake/replay", cases_read: "cr-1" }))]);
    expect(filedLine(readState(dir))).toMatch(/^Filed 4 runs \(ea-1, ea-2, ea-3, ea-4\); \$0\.75 spent$/);
  });

  test("preflight answers before any run: every level's missing precondition, in one list", async () => {
    standings = [{ env: "fake/floor", level: "L0" }, { env: "fake/noisy", level: "L1" }, { env: "fake/replay", level: "L2" }];
    fs.writeFileSync(path.join(repo, ".codecast/envs.toml"), ENVS.replace(/key = "fake\/floor"([\s\S]*?)protects = \["evals\/\*\*"\]\n/, 'key = "fake/floor"$1'));
    g("add", "-A"); g("commit", "-q", "-m", "floor unprotected");
    const at = Date.now();
    const err = await gauge(io(), dir, { card: CARD, base: g("rev-parse", "HEAD") }).catch((e) => e);
    expect(err.code).toBe(5);
    expect(runs).toBe(0);
    expect(Date.now() - at).toBeLessThan(5000);
    for (const words of ["fake/noisy declares a held split but has no held set", "fake/replay declares a held split but has no held set", "no scoring level the card names has a held set", "fake/floor (the goal's check, which the guard runs on every survivor) declares no protects"]) expect(err.message).toContain(words);
    // Nothing ran, and the station can say so.
    expect(filedLine(readState(dir))).toBe("Filed nothing: the climb had not started");
  });

  test("a run the registry refuses to file is counted with the registry's reason", async () => {
    const refusing = { ...io(), run: async (decl: any, o: any) => { const r = await io().run(decl, o); return r.ok ? { ok: true as const, result: r.result, unfiled: "held_read required" } : r; } };
    await gauge(refusing, dir, { card: CARD, base }).catch(() => {});
    const line = filedLine(readState(dir));
    expect(line).toContain("could not be filed (held_read required)");
    expect(line).toMatch(/^Filed 0 runs, \d+ failed or unfiled/);
  });

  // From the second flow run: Frame climbed a sensitivity check (share of picks the fit read passes) as if it were a score.
  test("an env declared a check is never a level to climb: preflight sends the card back", async () => {
    standings = [...standings, { env: "fake/fit", level: "L2" }];
    const err = await gauge(io(), dir, { card: { ...CARD, levels: [{ env: "fake/fit", plausible_effect: 0.09 }, { env: "fake/replay", plausible_effect: 0.04 }] }, base }).catch((e) => e);
    expect(err.code).toBe(5);
    expect(err.message).toContain('fake/fit is a check (role = "check"), not a climb target');
    expect(runs).toBe(0);
  });

  test("Guard runs the goal's checks on every survivor and refuses one whose check falls past its tolerance against base", async () => {
    standings = [...standings, { env: "fake/fit", level: "L2" }];
    // The truly better candidate buys its yeses by passing fewer picks on fit: -0.05, past the 0.02 tolerance.
    branch("climb/unfit", { "effect.txt": "dev=0.07\nheld=0.07\nfit=-0.05\n" });
    branch("climb/fitok", { "effect.txt": "dev=0.06\nheld=0.06\nfit=-0.01\n" });
    await gauge(io(), dir, { card: CARD, base });
    await admit(io(), dir, [{ branch: "climb/unfit", hypothesis: "h", predicted_delta: 0.07 }, { branch: "climb/fitok", hypothesis: "h", predicted_delta: 0.06 }]);
    const s = await guard(io(), dir);
    const unfit = s.candidates.find((c) => c.branch === "climb/unfit")!;
    expect(unfit.status).toBe("guard_failed");
    expect(unfit.guard!.why).toContain("fake/fit: -0.050 over 20 cases, 0.050 the wrong way, past its tolerance 0.02");
    const ok = s.candidates.find((c) => c.status === "promoted")!;
    expect(ok.branch).toBe("climb/fitok");
    expect(s.checks).toEqual(["fake/floor", "fake/fit"]);
  });

  // From the third flow run (ct-97125): survivors gained +0.0017 to +0.0037 against a plausible +0.03, moving 11-19 of 691 cases.
  test("Screen reports each survivor's effect beside the card's plausible one, and Record says whether the hypothesis held", async () => {
    const at = async (plausible: number, sub: string) => {
      const d = `${dir}-${sub}`;
      await gauge(io(), d, { card: { ...CARD, levels: [{ env: "fake/replay", plausible_effect: plausible }] }, base });
      await admit(io(), d, proposed);
      return screen(io(), d);
    };
    const held = await at(0.04, "held");
    const good = held.candidates.find((c) => c.branch === "climb/good")!.dev["fake/replay"];
    expect([good.changed, good.of]).toEqual([40, 40]);
    expect(effectLine(held)).toMatch(/plausible \+0\.040 on fake\/replay; cand-1 \+0\.060 \(15\d%\), 40 of 40 cases moved/);
    // The candidate that changes nothing moves no case past the base's own spread.
    expect(effectLine(held)).toMatch(/cand-5 [+-]0\.00\d \(-?\d%\), 0 of 40 cases moved/);
    expect(hypothesisLine(held)).toMatch(/^Hypothesis: held\. The best survivor \(cand-3\) moved fake\/replay by \+0\.(09|10)\d/);
    expect(hypothesisLine(await at(0.4, "weaker"))).toMatch(/^Hypothesis: weaker than expected\./);
    const refuted = await at(1, "refuted");
    expect(hypothesisLine(refuted)).toMatch(/^Hypothesis: refuted\. The best survivor \(cand-3\) moved fake\/replay by \+0\.(09|10)\d against the card's plausible \+1\.000 \(10%\), moving 40 of 40 cases/);
    expect(summaryText(refuted)).toContain("Hypothesis: refuted.");
  });

  // From the third flow run's end (ct-97125): Gauge read MDE 0.000, Confirm read held drift as gain, Guard refused a gate it could not resolve.
  test("base runs that agree exactly never give a level a zero MDE: the cases' own spread is the floor", async () => {
    process.env.FAKE_SAME = "1";
    try {
      const s = await gauge(io(), dir, { card: CARD, base });
      const replay = s.levels.find((l) => l.env === "fake/replay")!;
      expect(replay.noise!.se).toBe(0);
      expect(replay.noise!.mde).toBeGreaterThan(0.004);
      expect(replay.noise!.by).toBe("cases");
      expect(replay.why).toContain("the case-level floor");
    } finally { delete process.env.FAKE_SAME; }
  });

  /** An io whose held runs drift: `shift(k, label)` is added to 70% of the cases of the k-th held run of the sitting. */
  const driftingIo = (shift: (k: number, label: string) => number) => {
    const d = io();
    const run = d.run;
    let k = 0;
    d.run = async (decl, o) => {
      const r = await run(decl, o);
      if (!r.ok || o.split !== "held") return r;
      const add = shift(k++, o.label);
      const cases = r.result.cases.map((c, i) => (i % 10 < 7 ? { ...c, score: Math.min(1, c.score + add) } : c));
      registry.set(r.short_id!, { ...registry.get(r.short_id!), cases });
      return { ...r, result: { ...r.result, cases } };
    };
    return d;
  };

  test("a held gain that moves far more cases than the change moved on dev is the held runs' drift, and is not confirmed", async () => {
    // Dev runs agree exactly (a cached grader); the change reaches one case in five. The candidates' held runs land while
    // the held grader has drifted (+0.012 on most cases), as the run's 184-195 of 467 held cases did against 11-19 of 691 on dev.
    process.env.FAKE_SAME = "1";
    try {
      branch("climb/few", { "effect.txt": "dev_few=0.1\nheld_few=0.1\n" });
      const drifting = driftingIo((_, label) => (label === "base" ? 0 : 0.012));
      await gauge(drifting, dir, { card: CARD, base });
      await admit(drifting, dir, [proposed[0], { branch: "climb/few", hypothesis: "h", predicted_delta: 0.02 }]);
      const s = await confirm(drifting, dir);
      expect(filed.filter((f) => f === "base fake/replay held")).toHaveLength(2);
      const few = s.candidates.find((c) => c.branch === "climb/few")!;
      expect([few.dev["fake/replay"].changed, few.dev["fake/replay"].of]).toEqual([8, 40]);
      expect(few.status).toBe("dropped");
      expect(few.why).toContain("the held runs drift");
      // The truly better candidate moves every case on dev and held alike: it is confirmed.
      expect(s.candidates.find((c) => c.branch === "climb/good")!.status).toBe("survivor");
      // The hypothesis is read from dev for a held result that was drift.
      expect(hypothesisLine(s)).not.toContain("+0.012");
    } finally { delete process.env.FAKE_SAME; }
  });

  test("Confirm runs the base twice around the candidates, so a drift over the sitting is not read as gain", async () => {
    // The held grader drifts upward through the sitting, base runs included: base, candidates, base again.
    process.env.FAKE_SAME = "1";
    try {
      branch("climb/tiny", { "effect.txt": "dev_few=0.02\n" });
      const drifting = driftingIo((k) => 0.012 * k);
      await gauge(drifting, dir, { card: CARD, base });
      await admit(drifting, dir, [{ branch: "climb/tiny", hypothesis: "h", predicted_delta: 0.004 }]);
      const err = await confirm(drifting, dir).catch((e) => e);
      expect(err.message).toBe("no dev gain held up on the held split");
      const tiny = readState(dir)!.candidates[0];
      expect(tiny.held["fake/replay"].keep).toBe(false);
      expect(Math.abs(tiny.held["fake/replay"].delta)).toBeLessThan(0.005);
    } finally { delete process.env.FAKE_SAME; }
  });

  test("the eval gate is resolved through its wrapper and the command after --, run on the base's copies, and named when it cannot be", async () => {
    // Union's shape: bash $project_path/backend/scripts/eval/proof-tree.sh ... -- bun scripts/line.ts eval, run from the repo root.
    fs.mkdirSync(path.join(repo, "outreach/backend/scripts/eval"), { recursive: true });
    fs.writeFileSync(path.join(repo, "outreach/backend/scripts/eval/wrap.sh"), `while [ "$1" != "--" ]; do shift; done; shift\ncd "$(dirname "$0")/../.." && exec "$@"\n`);
    fs.writeFileSync(path.join(repo, "outreach/backend/scripts/gate.mjs"), `import fs from "node:fs";\nfs.writeFileSync(process.env.run_dir + "/reps.json", JSON.stringify({ worse: false }));\n`);
    fs.writeFileSync(path.join(repo, ".codecast/line.toml"), `[line.commands]\neval = "bash $project_path/backend/scripts/eval/wrap.sh --name x -- bun scripts/gate.mjs eval"\n`);
    g("add", "-A"); g("commit", "-q", "-m", "gate behind a wrapper");
    base = g("rev-parse", "HEAD");
    branch("climb/good2", { "effect.txt": "dev=0.06\nheld=0.06\n" });
    branch("climb/gatehack2", { "outreach/backend/scripts/gate.mjs": `import fs from "node:fs";\nfs.writeFileSync(process.env.run_dir + "/reps.json", "{}");\n`, "effect.txt": "dev=0.2\nheld=0.2\n" });
    await gauge(io(), dir, { card: CARD, base });
    await admit(io(), dir, [{ branch: "climb/good2", hypothesis: "h", predicted_delta: 0.06 }, { branch: "climb/gatehack2", hypothesis: "h", predicted_delta: 0.2 }]);
    // The run fills $project_path with the checkout it started in: the repo root, where backend/ is not.
    const s = await guard(io(), dir, { env: { project_path: repo } });
    expect(s.candidates.find((c) => c.branch === "climb/gatehack2")!.guard!.why).toContain("changes the files the product's eval command starts");
    expect(s.candidates.find((c) => c.status === "promoted")!.guard!.why).toContain("eval gate passed");
    // A command naming a script nothing reaches is refused, and says which.
    fs.writeFileSync(path.join(repo, ".codecast/line.toml"), `[line.commands]\neval = "bash $project_path/backend/scripts/eval/wrap.sh -- bun scripts/nope.ts eval"\n`);
    g("add", "-A"); g("commit", "-q", "-m", "gate that is not there");
    base = g("rev-parse", "HEAD");
    branch("climb/good3", { "effect.txt": "dev=0.06\nheld=0.06\n" });
    const d2 = `${dir}-nope`;
    await gauge(io(), d2, { card: CARD, base });
    await admit(io(), d2, [{ branch: "climb/good3", hypothesis: "h", predicted_delta: 0.06 }]);
    await expect(guard(io(), d2, { env: { project_path: repo } })).rejects.toThrow("every survivor failed the guard");
    expect(readState(d2)!.candidates[0].guard!.why).toContain("names scripts/nope.ts, which the climb could not find at the base");
  });
});
