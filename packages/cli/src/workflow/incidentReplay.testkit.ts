// The incident replays' world (incidentReplays.e2e.test.ts): the shipped change
// flow run by the real runner against a real origin, with the real stations.
// PR, Verdicts, Merge, Onto main and Wait for main run the code `cast flow`
// runs, CI runs the real station on a scripted GitHub or hands in a verdict,
// and Deploy runs the real choice of what to send and wait on from the merged
// commit (only `cast deploy` itself and the server's deploy records are fakes).
//
// The fake `cast` on PATH runs this file as a script: `cast flow <station>`
// becomes `bun incidentReplay.testkit.ts cast flow <station> …`, and the fake
// `gh` becomes `bun incidentReplay.testkit.ts gh …`, which keeps a pull
// request's state in a file and squash-merges onto the bare origin as GitHub
// does. The stations' calls to the server read and write the same state
// directory the test's in-process server writes (the reviewer's recorded
// verdict, the rebases a station records).
import { spawnSync } from "../proc.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
export const CONV = "jx7ssssssssssssssssssssssssssss1";
export const BRANCH = "feat";
const PR_URL = "https://github.com/acme/app/pull/7";

const sh = (cmd: string, args: string[], cwd?: string) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf-8", env: { ...process.env, ...ENV } });
  return { status: r.status ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
};
export const git = (cwd: string, ...args: string[]): string => {
  const r = sh("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], cwd);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const arg = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const stateFile = (f: string) => path.join(process.env.FAKE_STATE!, f);
export function readState<T>(f: string, fallback: T): T { try { return JSON.parse(fs.readFileSync(stateFile(f), "utf-8")); } catch { return fallback; } }
const writeState = (f: string, v: unknown) => fs.writeFileSync(stateFile(f), JSON.stringify(v, null, 1));
const originHead = (cwd: string, ref: string) => sh("git", ["ls-remote", "origin", `refs/heads/${ref}`], cwd).stdout.trim().split(/\s/)[0] ?? "";

/** Land a commit on origin's main from a clone of its own, as someone else's merge does; returns its sha. */
export function landOnMain(origin: string, files: Record<string, string>, message: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-other-"));
  try {
    git(dir, "clone", "-q", origin, "c");
    const c = path.join(dir, "c");
    for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(c, f)), { recursive: true }); fs.writeFileSync(path.join(c, f), text); }
    git(c, "add", "-A");
    git(c, "-c", "user.name=Teammate", "-c", "user.email=t@example.com", "commit", "-q", "-m", message);
    git(c, "push", "-q", "origin", "HEAD:main");
    return git(c, "rev-parse", "HEAD");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------------------------------------------
// The station side: what runs in the fake `cast`'s and `gh`'s processes.

/** The server as the stations' own calls reach it. Every call is logged to posts.log. */
async function post(route: string, body: any): Promise<any> {
  fs.appendFileSync(stateFile("posts.log"), `${JSON.stringify({ route, body })}\n`);
  const proof = () => readState<{ review: unknown; rebases: Array<{ from: string; to: string }> }>("proof.json", { review: null, rebases: [] });
  switch (route) {
    case "/cli/workflow-runs/merge-proof": return proof();
    case "/cli/workflow-runs/rebase": { const p = proof(); writeState("proof.json", { ...p, rebases: [...(p.rebases ?? []), { from: body.from, to: body.to }] }); return { attempt: 1 }; }
    case "/cli/workflow-runs/clear": return { node_id: "merge" };
    case "/cli/line/merge/check": return { allowed: true, reason: null };
    case "/cli/line/merge/record": return { used: 0, limit: null };
    case "/cli/repo-lease": return body.op === "release" ? { released: true } : { held: true, expires_at: Date.now() + 600_000 };
    case "/cli/deploys/ship-pass": {
      // What Merge sent before the merge is recorded deployed at the sha it names, as the server records it.
      for (const d of body.deploys ?? []) if (d.ok && d.target) live(d.target, body.pushed, `dp-${d.name}`);
      return { pass: "p1", deploys: [] };
    }
    case "/cli/model/call": throw new Error("no model in a replay");
    default: return {};
  }
}

/** A deploy of `target` live at `sha` on the server's record of the targets. */
function live(target: string, sha: string, id: string) {
  const rows = readState<Array<{ name: string; history: unknown[] }>>("targets.json", []);
  const row = rows.find((r) => r.name === target) ?? (rows.push({ name: target, history: [] }), rows.at(-1)!);
  row.history.unshift({ short_id: id, status: "live", sha, created_at: Date.now(), live_at: Date.now() });
  writeState("targets.json", rows);
}

/** `cast flow pr` as flowStations.ts runs it: a round's push, Merge's retest refresh, or Onto main's rebase. */
async function prCommand(argv: string[], cwd: string): Promise<number> {
  const { prStation, rebasePr, refreshPr } = await import("./prStation.js");
  const dir = arg(argv, "--dir")!;
  const base = arg(argv, "--base") ?? "main";
  const r = argv.includes("--refresh") ? refreshPr({ cwd, dir })
    : argv.includes("--rebase") ? await rebasePr({ cwd, dir, base, runId: arg(argv, "--run") ?? "", post })
    : prStation({ cwd, dir, branch: arg(argv, "--branch")!, base, title: arg(argv, "--title"), body: arg(argv, "--body") ?? "", proof: await post("/cli/workflow-runs/merge-proof", {}) });
  if (!r.ok) { console.log(r.reason); return r.new_round ? 4 : 1; }
  console.log(JSON.stringify(r.pr));
  return 0;
}

/** `cast flow ci`: the next queued answer. `green` is GitHub's green on the pushed head against main as origin has it
 *  now; `red-main` runs the real CI station on a GitHub where the head's test-cli fails exactly as main's does. */
async function ciCommand(argv: string[], cwd: string): Promise<number> {
  const { readPr } = await import("./prStation.js");
  const dir = arg(argv, "--dir")!;
  const head = readPr(dir)?.head_sha ?? "";
  const queue = readState<string[]>("ci.queue", []);
  const answer = queue.shift();
  writeState("ci.queue", queue);
  const visit = readState<unknown[]>("ci.seen", []).length + 1;
  if (answer === "red-main") {
    const { runCiStation } = await import("./ciStation.js");
    const { BASE_OID, BUN_LOG, check, fakeGh, job } = await import("./ciStation.testkit.js");
    // Red on its first run, red again after the station's rerun; main's run at the base the pull request names failed
    // test-cli the same way.
    const gh = fakeGh({
      polls: [{ rollup: [check("test-cli", "FAILURE", 3)], head }, { rollup: [check("test-cli", "FAILURE", 4)], head }],
      logs: { 4: BUN_LOG, 601: BUN_LOG },
      mainAt: { [BASE_OID]: [{ databaseId: 60, headSha: BASE_OID, createdAt: "2026-11-20T15:00:00Z", status: "completed" }] },
      jobs: { 60: [job("test-cli", 601, "failure")] },
    });
    let clock = Date.parse("2026-11-21T00:00:00Z");
    const out = await runCiStation({ pr: 7, dir, deadlineMs: 3_600_000, head, gh, now: () => clock, sleep: async (ms) => { clock += ms; }, pollMs: 30_000, progress: () => {} });
    console.log(out.summary);
  } else if (answer === "green") {
    const green = { green: true, head_sha: head, tested_main_sha: originHead(cwd, "main"), failing: [], preexisting: [], blocked_by_main: false, ci_changed: false, pending: [], reran: false, timed_out: false, no_ci: false, head_moved: false, observed_head: null };
    fs.writeFileSync(path.join(dir, "ci.json"), JSON.stringify(green));
    console.log("CI green on #7");
  } else {
    console.error(`no CI answer queued for visit ${visit}`);
    return 0;
  }
  writeState("ci.seen", [...readState<unknown[]>("ci.seen", []), JSON.parse(fs.readFileSync(path.join(dir, "ci.json"), "utf-8"))]);
  return 0;
}

/** `cast flow verdicts`, as flowStations.ts reads where origin's branch stands and what the server holds. */
async function verdictsCommand(argv: string[], cwd: string): Promise<number> {
  const [{ changeVerdicts }, { readPr }] = await Promise.all([import("./changeVerdicts.js"), import("./prStation.js")]);
  const dir = arg(argv, "--dir")!;
  const pr = readPr(dir);
  const head = pr?.branch ? originHead(cwd, pr.branch) || null : null;
  const proof = pr?.reviewed ? await post("/cli/workflow-runs/merge-proof", {}) : null;
  console.log(JSON.stringify(changeVerdicts(dir, arg(argv, "--review"), head, proof)));
  return 0;
}

/** `cast flow merge` (mergeCommand), with the repository named: this origin is a path, not a GitHub remote. */
async function mergeCommand(argv: string[], cwd: string): Promise<number> {
  const { runMergeStation } = await import("./mergeStation.js");
  const r = await runMergeStation({
    cwd, pr: Number(arg(argv, "--pr")), branch: arg(argv, "--branch")!, runDir: arg(argv, "--dir")!, runId: process.env.run_id || "run-9",
    into: process.env.default_branch || "main", repository: "acme/app", post, wait: () => {}, log: (l) => console.log(l),
  });
  console.log(r.line);
  return r.code;
}

/** `cast flow wait-main`: the real wait on main's CI as `gh run list` reports it. Between its looks, someone lands the
 *  fix queued in main-fix.json, and main's CI passes on it. */
async function waitMainCommand(argv: string[], cwd: string): Promise<number> {
  const { waitForMain } = await import("./waitMain.js");
  const sleep = async () => {
    const fix = readState<{ files: Record<string, string>; message: string } | null>("main-fix.json", null);
    if (!fix) return;
    fs.rmSync(stateFile("main-fix.json"));
    const sha = landOnMain(process.env.FAKE_ORIGIN!, fix.files, fix.message);
    writeState("main-ci.json", { ...readState("main-ci.json", {}), [sha]: "success" });
    writeState("main-fixed.json", sha);
  };
  const r = await waitForMain({ cwd, base: arg(argv, "--base") ?? "main", deadlineMs: 4 * 3_600_000, intervalMs: 1, sleep, say: () => {} });
  console.log(r.line);
  return r.ok ? 0 : 1;
}

/** `cast flow await-deploy` (runAwaitDeploy): the merged commit from merge.json, the duties its own deploy.toml gives,
 *  and the real wait. `cast deploy` is the fake: it records what it was asked to send and marks it live there. */
async function awaitDeployCommand(argv: string[], cwd: string): Promise<number> {
  const { awaitDeploy, holds, landedDuties, mergedCommit, mergedSha } = await import("./awaitDeploy.js");
  const mergeFile = arg(argv, "--merge");
  let merge: { sha?: string; files?: string[] } | null = null;
  try { merge = JSON.parse(fs.readFileSync(mergeFile!, "utf-8")); } catch {}
  const base = arg(argv, "--base") ?? "main";
  const fromRun = (arg(argv, "--files") ?? "").split(/\s+/).filter(Boolean);
  const read = await mergedCommit(cwd, await mergedSha({}, merge, async () => null), base, fromRun.length ? fromRun : merge?.files, { tries: 1, delayMs: 0 });
  if ("error" in read) { console.log(read.error); return read.unread ? 1 : 4; }
  const plan = await landedDuties(cwd, read, { except: arg(argv, "--except"), send: arg(argv, "--send") });
  writeState("deploy-plan.json", plan.duties.map((d) => ({ target: d.target, action: d.action, how: d.how })));
  let clock: any = null;
  const r = await awaitDeploy({ sha: read.sha, base, plan, intervalMs: 1 }, {
    now: () => Date.now(),
    sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 20))),
    mainHead: async () => originHead(cwd, base) || null,
    targets: async () => readState("targets.json", []),
    carries: (deployed) => holds(cwd, read.sha, deployed),
    mainCi: async () => ({ state: "passed", red: [] }),
    redSince: async () => null,
    // As sendDetached: `cast deploy <targets> --carrying <merged sha>` from the run's checkout.
    send: async (targets) => {
      writeState("sends.json", [...readState<unknown[]>("sends.json", []), { targets, carrying: read.sha, cwd }]);
      for (const t of targets) live(t, read.sha, `dp-${t}`);
      return { code: 0, last: "sent" };
    },
    progress: () => {},
    block: async () => {},
    clock: { load: () => clock, save: (c) => { clock = c; } },
  });
  console.log(r.line);
  return r.code;
}

const STATIONS: Record<string, (argv: string[], cwd: string) => Promise<number>> = {
  pr: prCommand, ci: ciCommand, verdicts: verdictsCommand, merge: mergeCommand, "wait-main": waitMainCommand, "await-deploy": awaitDeployCommand,
};

/** GitHub for one pull request (#7, branch feat) on the bare origin, and main's CI as main-ci.json has it per sha. */
function gh(args: string[]): number {
  const origin = process.env.FAKE_ORIGIN!;
  const pr = readState<{ open: boolean; state: string; head?: string; mergeCommit?: string }>("gh.json", { open: false, state: "OPEN" });
  const save = () => writeState("gh.json", pr);
  fs.appendFileSync(stateFile("gh.log"), `${args.join(" ")}\n`);
  const out = (v: unknown) => { process.stdout.write(typeof v === "string" ? `${v}\n` : JSON.stringify(v)); return 0; };
  const head = () => sh("git", ["--git-dir", origin, "rev-parse", `refs/heads/${BRANCH}`]).stdout.trim();
  const a = args.join(" ");
  if (a.startsWith("pr list")) return out(pr.open && pr.state === "OPEN" ? [{ number: 7, url: PR_URL, isCrossRepository: false }] : []);
  if (a.startsWith("pr create")) { pr.open = true; save(); return out(PR_URL); }
  if (a.startsWith("pr view")) return out({ state: pr.state, headRefOid: pr.state === "MERGED" ? pr.head : head(), url: PR_URL, mergeCommit: pr.mergeCommit ? { oid: pr.mergeCommit } : null });
  if (a.startsWith("pr merge")) {
    if (args.includes("--admin")) { process.stderr.write("--admin is never used"); return 1; }
    pr.head = head();
    if (args[args.indexOf("--match-head-commit") + 1] !== pr.head) { process.stderr.write("Head branch was modified. Review and try the merge again."); return 1; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-gh-"));
    try {
      git(dir, "clone", "-q", origin, "m");
      const m = path.join(dir, "m");
      const as = ["-c", "user.name=GitHub", "-c", "user.email=gh@example.com"];
      git(m, "merge", "-q", "--squash", `origin/${BRANCH}`);
      git(m, ...as, "commit", "-q", "-m", "Squashed (#7)");
      git(m, "push", "-q", "origin", "HEAD:main");
      Object.assign(pr, { state: "MERGED", mergeCommit: git(m, "rev-parse", "HEAD") });
      save();
      return 0;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  if (a.startsWith("run list") && args.includes("--branch")) {
    const ci = readState<Record<string, string>>("main-ci.json", {});
    return out(Object.entries(ci).map(([sha, conclusion], i) => ({ databaseId: 100 + i, workflowName: "CI", headSha: sha, status: "completed", conclusion })));
  }
  if (a.startsWith("run view")) {
    const conclusion = Object.values(readState<Record<string, string>>("main-ci.json", {}))[Number(args[2]) - 100] ?? "success";
    return out({ jobs: [{ name: "test-cli", conclusion }] });
  }
  process.stderr.write(`fake gh does not know ${a}`);
  return 1;
}

if (import.meta.main) {
  const [who, ...argv] = process.argv.slice(2);
  if (who === "gh") process.exit(gh(argv));
  const station = STATIONS[argv[1] ?? ""];
  if (argv[0] !== "flow" || !station) process.exit(0);
  process.exit(await station(argv, process.cwd()));
}
