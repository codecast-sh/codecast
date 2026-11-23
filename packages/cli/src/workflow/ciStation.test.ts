import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ciCommand, runCiStation, type CiResult, type Gh } from "./ciStation.js";
import { BUN_LOG, BUN_TEST, OTHER_TEST_LOG, STEP_END, bunLogBody, VITE_LOG, mergeLog, tests } from "./ciStation.testkit.js";

const REPO = "acme/app";
const HEAD = "a".repeat(40);
const NEW_HEAD = "e".repeat(40);
const MAIN = "b".repeat(40);
const OLDER_MAIN = "c".repeat(40);
const BASE_OID = "f".repeat(40);
const NOW = Date.parse("2026-11-21T00:00:00Z");

type Rollup = Record<string, any>;
const T0 = Date.parse("2026-11-20T16:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const check = (name: string, conclusion: string | null, job: number, mins = 3, startMin = 0, run = 900): Rollup => ({
  __typename: "CheckRun",
  name,
  workflowName: "CI",
  status: conclusion ? "COMPLETED" : "IN_PROGRESS",
  conclusion: conclusion ?? "",
  detailsUrl: `https://github.com/${REPO}/actions/runs/${run}/job/${job}`,
  startedAt: at(startMin),
  completedAt: conclusion ? at(startMin + mins) : null,
});
// GitHub's shape for a skipped job: it completes before it starts.
const skippedCheck = (name: string, job: number): Rollup => ({ ...check(name, "SKIPPED", job), startedAt: at(5), completedAt: at(4) });
const status = (context: string, state: string): Rollup => ({ __typename: "StatusContext", context, state, targetUrl: `https://ci.example/${context}` });
const job = (name: string, id: number, conclusion: string) => ({ name, databaseId: id, status: "completed", conclusion });
const workflowFile = (text: string) => Buffer.from(text).toString("base64");
const CI_WORKFLOW = "name: CI\non:\n  pull_request:\n";

interface Poll { rollup: Rollup[]; head?: string; runs?: Array<Record<string, any>>; mergeable?: string }

/**
 * A fake gh. Each poll of the pull request answers with the next entry of `polls` (the last repeats). The head's
 * workflow run defaults to run 900, whose jobs are its checks: in progress until they are done, then a success
 * when all passed, its attempt counting reruns. Main's runs answer by the sha asked for (`mainAt`), or as the
 * runs before a date (`mainEarlier`).
 */
function fakeGh(o: {
  polls: Poll[];
  logs?: Record<number, string>;
  mainAt?: Record<string, Array<Record<string, any>>>;
  mainEarlier?: Array<Record<string, any>>;
  jobs?: Record<number, any[]>;
  workflows?: Record<string, string>;
  /** Other repository files by path, as GitHub's contents API serves them (the base's .codecast/line.toml). */
  repoFiles?: Record<string, string>;
  /** GitHub's compare status by `base...head` (ahead, behind, diverged); absent, the compare fails as for an unknown sha. */
  compare?: Record<string, string>;
  /** What the pull request's files query prints: each path, and a renamed file's old path. */
  files?: string[];
  fail?: (a: string) => { code: number; out: string } | null;
  onLog?: (jobId: number) => void;
  /** How gh treats --allow-escape-sequences on a log read: 2.105 refuses a log without it, a gh older than the flag rejects it. */
  escapes?: "required" | "unknown";
}): Gh & { calls: string[] } {
  let poll = -1;
  let attempt = 1;
  // GitHub shows a rerun run as going again until its new attempt's jobs land.
  let rerunOf: string | null = null;
  const calls: string[] = [];
  const current = () => o.polls[Math.max(0, Math.min(poll, o.polls.length - 1))]!;
  const gh = ((args: string[]) => {
    const a = args.join(" ");
    calls.push(a);
    const failed = o.fail?.(a);
    if (failed) return failed;
    if (a.startsWith("pr view")) {
      poll++;
      const p = current();
      return { code: 0, out: JSON.stringify({ url: `https://github.com/${REPO}/pull/7`, headRefOid: p.head ?? HEAD, headRefName: "feature", baseRefName: "main", baseRefOid: BASE_OID, mergeable: p.mergeable ?? "MERGEABLE", statusCheckRollup: p.rollup }) };
    }
    if (a.startsWith(`api --paginate repos/${REPO}/pulls/7/files`)) return { code: 0, out: (o.files ?? ["src/app.ts"]).join("\n") };
    const compare = /^api repos\/acme\/app\/compare\/(\S+) --jq \.status$/.exec(a);
    if (compare) return o.compare?.[compare[1]!] ? { code: 0, out: o.compare[compare[1]!]! } : { code: 1, out: "HTTP 404: No common ancestor or unknown sha" };
    const commit = /^run list .*--commit (\S+)/.exec(a);
    if (commit && commit[1] === (current().head ?? HEAD)) {
      const p = current();
      const actions = p.rollup.filter((c) => c.__typename === "CheckRun" && /\/actions\/runs\//.test(c.detailsUrl));
      const done = actions.every((c) => c.status === "COMPLETED") && JSON.stringify(p.rollup) !== rerunOf;
      const passed = actions.every((c) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c.conclusion));
      const runs = p.runs ?? (actions.length ? [{ databaseId: 900, status: done ? "completed" : "in_progress", conclusion: done ? (passed ? "success" : "failure") : "", attempt, workflowName: "CI", event: "pull_request" }] : []);
      return { code: 0, out: JSON.stringify(runs) };
    }
    if (commit) return { code: 0, out: JSON.stringify(o.mainAt?.[commit[1]!] ?? []) };
    if (a.startsWith("run list") && a.includes("--created")) return { code: 0, out: JSON.stringify(o.mainEarlier ?? []) };
    if (a.startsWith("run rerun")) { attempt++; rerunOf = JSON.stringify(current().rollup); return { code: 0, out: "" }; }
    const log = /^api repos\/acme\/app\/actions\/jobs\/(\d+)\/logs( --allow-escape-sequences)?$/.exec(a);
    if (log) {
      if (o.escapes === "required" && !log[2]) return { code: 1, out: "the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway" };
      if (o.escapes === "unknown" && log[2]) return { code: 1, out: "unknown flag: --allow-escape-sequences\n\nUsage:  gh api <endpoint> [flags]" };
      o.onLog?.(Number(log[1]));
      return o.logs?.[Number(log[1])] !== undefined ? { code: 0, out: o.logs[Number(log[1])]! } : { code: 1, out: "HTTP 404: BlobNotFound" };
    }
    const view = /^run view (\d+) .*--json jobs$/.exec(a);
    if (view) {
      const id = Number(view[1]);
      const own = current().rollup.filter((c) => c.__typename === "CheckRun" && String(c.detailsUrl).includes(`/runs/${id}/job/`));
      const derived = own.map((c) => job(c.name, Number(/job\/(\d+)/.exec(c.detailsUrl)![1]), String(c.conclusion).toLowerCase()));
      return { code: 0, out: JSON.stringify({ jobs: o.jobs?.[id] ?? derived }) };
    }
    const workflows = o.workflows ?? { ".github/workflows/ci.yml": CI_WORKFLOW };
    if (a.startsWith(`api --paginate repos/${REPO}/actions/workflows`)) return { code: 0, out: Object.keys(workflows).join("\n") };
    const file = /^api repos\/acme\/app\/contents\/(\S+)\?ref=/.exec(a);
    if (file && o.repoFiles?.[file[1]!] !== undefined) return { code: 0, out: workflowFile(o.repoFiles[file[1]!]!) };
    if (file) return workflows[file[1]!] !== undefined ? { code: 0, out: workflowFile(workflows[file[1]!]!) } : { code: 1, out: "HTTP 404: Not Found" };
    return { code: 1, out: `unexpected gh ${a}` };
  }) as Gh & { calls: string[] };
  gh.calls = calls;
  return gh;
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ci-station-")); dirs.push(d); return d; };

let clock = NOW;
async function station(gh: Gh, opts: { deadlineMs?: number; dir?: string; head?: string } = {}) {
  const dir = opts.dir ?? tmpDir();
  clock = NOW;
  const lines: string[] = [];
  const out = await runCiStation({ pr: 7, dir, deadlineMs: opts.deadlineMs ?? 60 * 60_000, head: opts.head, gh, now: () => clock, sleep: async (ms) => { clock += ms; }, pollMs: 30_000, progress: (l) => lines.push(l) });
  if (out.written) expect(JSON.parse(fs.readFileSync(path.join(dir, "ci.json"), "utf-8"))).toEqual(out.result);
  return { ...out, lines };
}
const verdict = (r: Partial<CiResult>): CiResult => ({ green: false, head_sha: HEAD, tested_main_sha: null, failing: [], preexisting: [], blocked_by_main: false, ci_changed: false, pending: [], reran: false, timed_out: false, no_ci: false, head_moved: false, observed_head: null, ...r });
/** CI red on its first run (each job id one lower), then the rollup given, after the station's rerun. */
const redAfterRerun = (rollup2: Rollup[], extra: Partial<Parameters<typeof fakeGh>[0]>) =>
  fakeGh({ polls: [{ rollup: rollup2.map((c) => ({ ...c, detailsUrl: c.detailsUrl.replace(/job\/(\d+)/, (_: string, n: string) => `job/${Number(n) - 1}`) })) }, { rollup: rollup2 }], ...extra });
/** Main at the tested sha (the pull request's base): run 60, whose jobs are given. */
const mainWith = (jobs: any[]) => ({ mainAt: { [BASE_OID]: [{ databaseId: 60, headSha: BASE_OID, createdAt: "2026-11-20T15:00:00Z", status: "completed" }] }, jobs: { 60: jobs } });

describe("cast flow ci: green is GitHub's", () => {
  test("green: every run concluded success, looked at twice; the tested main sha comes from a job that ran", async () => {
    const gh = fakeGh({
      polls: [{ rollup: [skippedCheck("test-shared", 9), check("lint", null, 1), check("test-cli", null, 2)] }, { rollup: [skippedCheck("test-shared", 9), check("lint", "SUCCESS", 1, 1), check("test-cli", "SUCCESS", 2, 9)] }],
      logs: { 1: mergeLog(HEAD, MAIN) },
    });
    const { result, summary, lines } = await station(gh);
    expect(result).toEqual(verdict({ green: true, tested_main_sha: MAIN }));
    expect(summary).toBe("CI green on #7");
    expect(lines).toEqual(["Waiting on CI for #7 at aaaaaaa: 1 of 3 jobs done, 0m of 60m", "Waiting on CI for #7 at aaaaaaa: a second look before calling it green, 0m of 60m"]);
    expect(gh.calls.some((c) => c.includes("jobs/9/logs"))).toBe(false);
  });

  test("with no checkout log to read, the tested main sha is the base the pull request names", async () => {
    const gh = fakeGh({ polls: [{ rollup: [skippedCheck("test-shared", 9), check("lint", "SUCCESS", 1, 1)] }] });
    expect((await station(gh)).result.tested_main_sha).toBe(BASE_OID);
  });

  test("an outside check that registers once Actions finished is seen before green (P10)", async () => {
    const gh = fakeGh({ polls: [{ rollup: [check("lint", "SUCCESS", 1, 1)] }, { rollup: [check("lint", "SUCCESS", 1, 1), status("vercel", "FAILURE")] }], logs: { 1: mergeLog(HEAD, MAIN) } });
    const { result } = await station(gh);
    expect(result.green).toBe(false);
    expect(result.failing).toEqual([expect.objectContaining({ job: "vercel", excerpt: "vercel failed: https://ci.example/vercel" })]);
  });

  test("a run that failed with no failed job (a workflow file that does not load) is red (P15, live #97)", async () => {
    const gh = fakeGh({
      polls: [{ rollup: [{ ...check("GitGuardian Security Checks", "SUCCESS", 1), detailsUrl: "https://dashboard.gitguardian.com/x" }], runs: [{ databaseId: 900, status: "completed", conclusion: "failure", attempt: 1, workflowName: "CI", event: "pull_request" }] }],
      fail: (a) => (a.startsWith("run rerun") ? { code: 1, out: "cannot rerun a run that never started" } : null),
      jobs: { 900: [] },
    });
    const { result, summary } = await station(gh);
    expect(result.green).toBe(false);
    expect(result.failing).toEqual([expect.objectContaining({ job: "CI", excerpt: expect.stringContaining("concluded failure with no failed job") })]);
    expect(summary).toBe("CI red on #7: 1 failure in CI");
  });

  test("a run in progress keeps the station waiting though every visible check is done (staged jobs)", async () => {
    const going = [{ databaseId: 900, status: "in_progress", conclusion: "", attempt: 1, workflowName: "CI", event: "pull_request" }];
    const gh = fakeGh({
      polls: [
        { rollup: [check("classify", "SUCCESS", 1, 1)], runs: going },
        { rollup: [check("classify", "SUCCESS", 1, 1), check("test-cli", "FAILURE", 2, 5, 1)] },
      ],
      fail: (a) => (a.startsWith("run rerun") ? { code: 1, out: "no" } : null),
      logs: { 2: BUN_LOG },
    });
    expect(tests((await station(gh)).result.failing)).toEqual([["test-cli", BUN_TEST]]);
  });

  test("an outside status that finished before the Actions run registered does not end the wait", async () => {
    const gh = fakeGh({ polls: [{ rollup: [status("GitGuardian", "SUCCESS")] }, { rollup: [status("GitGuardian", "SUCCESS"), check("test-cli", "FAILURE", 2)] }, { rollup: [status("GitGuardian", "SUCCESS"), check("test-cli", "FAILURE", 3)] }], logs: { 3: BUN_LOG } });
    expect(tests((await station(gh)).result.failing)).toEqual([["test-cli", BUN_TEST]]);
  });

  test("no run where a workflow should run: waits, then timed out, never green", async () => {
    const { result, summary } = await station(fakeGh({ polls: [{ rollup: [] }] }), { deadlineMs: 10 * 60_000 });
    expect(result).toEqual(verdict({ timed_out: true, tested_main_sha: BASE_OID, pending: ["CI"], failing: [expect.objectContaining({ job: "ci-station", excerpt: "CI did not finish within 10m: CI never started on aaaaaaa." })] }));
    expect(summary).toBe("CI timed out on #7 after 10m: CI never started on aaaaaaa");
  });

  test("push-only CI is waited for until its run registers (P5)", async () => {
    const gh = fakeGh({ polls: [{ rollup: [] }, { rollup: [check("test", "FAILURE", 2)] }, { rollup: [check("test", "FAILURE", 3)] }], workflows: { ".github/workflows/ci.yml": "name: CI\non: push\n" }, logs: { 3: OTHER_TEST_LOG } });
    const { result } = await station(gh);
    expect(result.green).toBe(false);
    expect(result.failing.map((f) => f.job)).toEqual(["test"]);
  });

  test("a repository that runs nothing on this pull request is green with no_ci, after a settle period", async () => {
    const gh = fakeGh({ polls: [{ rollup: [] }], workflows: { ".github/workflows/deploy.yml": "name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  d:\n    if: github.event.pull_request.merged\n" } });
    const { result, summary } = await station(gh);
    expect(result).toEqual(verdict({ green: true, no_ci: true, tested_main_sha: BASE_OID }));
    expect(summary).toBe("CI green on #7: the repository runs no CI on this pull request");
    expect(clock - NOW).toBeGreaterThanOrEqual(2 * 60_000);
  });

  test("a workflow whose paths filter this pull request misses is not waited for; one it hits is", async () => {
    const workflows = { ".github/workflows/ci.yml": "name: CI\non:\n  pull_request:\n    branches: [main]\n    paths: ['src/**', '!src/**/*.md']\n" };
    expect((await station(fakeGh({ polls: [{ rollup: [] }], files: ["docs/guide.md", "src/notes.md"], workflows }))).result.no_ci).toBe(true);
    expect((await station(fakeGh({ polls: [{ rollup: [] }], files: ["src/app.ts"], workflows }), { deadlineMs: 2 * 60_000 })).result.timed_out).toBe(true);
  });

  test("the full file list decides a paths filter, past gh pr view's 100 files (P14)", async () => {
    const files = Array.from({ length: 150 }, (_, i) => `src/f${i}.ts`);
    const gh = fakeGh({
      polls: [{ rollup: [check("lint", "SUCCESS", 1, 1)] }],
      logs: { 1: mergeLog(HEAD, MAIN) },
      files,
      workflows: { ".github/workflows/ci.yml": CI_WORKFLOW, ".github/workflows/e2e.yml": "name: E2E\non:\n  pull_request:\n    paths: ['src/f149.ts']\n" },
    });
    const { result, lines } = await station(gh, { deadlineMs: 2 * 60_000 });
    expect(result.green).toBe(false);
    expect(result.timed_out).toBe(true);
    expect(lines[0]).toContain("E2E not started yet");
  });

  test("a second workflow that has not registered its run yet is waited for", async () => {
    const ci = { databaseId: 900, status: "completed", conclusion: "success", attempt: 1, workflowName: "CI", event: "pull_request" };
    const gh = fakeGh({
      polls: [
        { rollup: [check("lint", "SUCCESS", 1, 1)], runs: [ci] },
        { rollup: [check("lint", "SUCCESS", 1, 1), { ...check("e2e", "FAILURE", 3, 3, 0, 901), workflowName: "E2E" }], runs: [ci, { databaseId: 901, status: "completed", conclusion: "failure", attempt: 1, workflowName: "E2E", event: "pull_request" }] },
      ],
      logs: { 1: mergeLog(HEAD, MAIN), 3: BUN_LOG },
      workflows: { ".github/workflows/ci.yml": CI_WORKFLOW, ".github/workflows/e2e.yml": "name: E2E\non: pull_request\n" },
      fail: (a) => (a.startsWith("run rerun") ? { code: 1, out: "no" } : null),
    });
    const { result, lines } = await station(gh);
    expect(lines).toContain("Waiting on CI for #7 at aaaaaaa: E2E not started yet, 0m of 60m");
    expect(result.failing.map((f) => f.job)).toEqual(["e2e"]);
  });

  test("a merge conflict with no run on the head is red at once, saying why", async () => {
    const { result, summary } = await station(fakeGh({ polls: [{ rollup: [], mergeable: "CONFLICTING" }] }));
    expect(result.green).toBe(false);
    expect(result.failing[0]!.excerpt).toContain("merge conflict");
    expect(summary).toBe("CI red on #7: it has a merge conflict, so GitHub runs no CI on it");
  });

  test("--head: judges only the head the flow pushed, waiting until the pull request has it", async () => {
    const gh = fakeGh({ polls: [{ rollup: [check("lint", "SUCCESS", 1, 1)] }, { rollup: [check("lint", "SUCCESS", 11, 1, 0, 901)], head: NEW_HEAD, runs: [{ databaseId: 901, status: "completed", conclusion: "success", attempt: 1, workflowName: "CI", event: "pull_request" }] }] });
    const { result, lines } = await station(gh, { head: NEW_HEAD });
    expect(lines[0]).toBe("Waiting on CI for #7 at aaaaaaa: the head to be eeeeeee (it is aaaaaaa), 0m of 60m");
    expect(result).toMatchObject({ green: true, head_sha: NEW_HEAD });
    const never = await station(fakeGh({ polls: [{ rollup: [check("lint", "SUCCESS", 1, 1)] }] }), { head: NEW_HEAD, deadlineMs: 2 * 60_000 });
    // The head it was asked to judge never came: ci.json names no head, and the verdict is not posted.
    expect(never.result).toMatchObject({ green: false, timed_out: true, head_sha: null, tested_main_sha: null });
  });

  test("timeout: the deadline ends the wait with the jobs still running named", async () => {
    const gh = fakeGh({ polls: [{ rollup: [check("lint", "SUCCESS", 1, 1), check("test-cli", null, 2), check("test-web", null, 4)] }], logs: { 1: mergeLog(HEAD, MAIN) } });
    const { result, summary } = await station(gh, { deadlineMs: 2 * 60_000 });
    expect(result).toEqual(verdict({ tested_main_sha: MAIN, timed_out: true, pending: ["test-cli", "test-web"], failing: [expect.objectContaining({ job: "ci-station" })] }));
    expect(summary).toBe("CI timed out on #7 after 2m: 2 jobs still running (test-cli, test-web)");
  });

  test("a gh outage of a few polls is waited out", async () => {
    let down = 4;
    const gh = fakeGh({ polls: [{ rollup: [check("lint", "SUCCESS", 1, 1)] }], logs: { 1: mergeLog(HEAD, MAIN) }, fail: (a) => (a.startsWith("pr view") && down-- > 0 ? { code: 1, out: "HTTP 502: Bad Gateway" } : null) });
    const { result, lines } = await station(gh);
    expect(result.green).toBe(true);
    expect(lines[0]).toBe("Cannot read CI for #7 (gh pr view failed: HTTP 502: Bad Gateway); trying again, 0m of 60m");
  });

  test("gh failing until the deadline: timed out with the gh error, never a throw", async () => {
    const gh = fakeGh({ polls: [], fail: (a) => (a.startsWith("pr view") ? { code: 1, out: "HTTP 401: Bad credentials" } : null) });
    const { result, summary } = await station(gh, { deadlineMs: 5 * 60_000 });
    expect(result).toEqual(verdict({ head_sha: null, timed_out: true, failing: [expect.objectContaining({ job: "ci-station", excerpt: "Could not read the pull request's CI before the deadline: gh pr view failed: HTTP 401: Bad credentials" })] }));
    expect(summary).toBe("CI timed out on #7 after 5m: gh kept failing (gh pr view failed: HTTP 401: Bad credentials)");
  });

  test("an unreadable workflow list or file list is never read as nothing more to come", async () => {
    for (const what of ["actions/workflows", "pulls/7/files"]) {
      const gh = fakeGh({ polls: [{ rollup: [check("lint", "SUCCESS", 1, 1)] }], logs: { 1: mergeLog(HEAD, MAIN) }, fail: (a) => (a.includes(what) ? { code: 1, out: "HTTP 403: Resource not accessible" } : null) });
      const { result } = await station(gh, { deadlineMs: 2 * 60_000 });
      expect(result).toMatchObject({ green: false, timed_out: true });
      expect(result.failing[0]!.excerpt).toContain(`${what} failed: HTTP 403`);
    }
  });

  test("ci.json: a stale verdict is removed at the start and replaced whole; an unwritable dir still returns the verdict", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "ci.json"), JSON.stringify({ green: true, head_sha: "old" }));
    const gh = fakeGh({ polls: [], fail: () => ({ code: 1, out: "down" }) });
    expect((await station(gh, { dir, deadlineMs: 60_000 })).written).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "ci.json"), "utf-8")).green).toBe(false);
    expect(fs.existsSync(path.join(dir, "ci.json.tmp"))).toBe(false);
    const unwritable = await station(gh, { dir: path.join(dir, "ci.json"), deadlineMs: 60_000 });
    expect(unwritable.written).toBe(false);
    expect(unwritable.result.timed_out).toBe(true);
  });

  test("an unreadable deadline is a station failure, not a silent 60m", async () => {
    const out = await runCiStation({ pr: 7, dir: tmpDir(), deadlineMs: NaN, gh: fakeGh({ polls: [] }) });
    expect(out.result.failing[0]!.excerpt).toContain("--deadline is not a duration");
    expect(out.result.green).toBe(false);
  });
});

describe("cast flow ci: reruns", () => {
  test("flaky: red, rerun, green", async () => {
    const gh = fakeGh({ polls: [{ rollup: [check("test-cli", "FAILURE", 2)] }, { rollup: [check("test-cli", "FAILURE", 2)] }, { rollup: [check("test-cli", null, 3)] }, { rollup: [check("test-cli", "SUCCESS", 3)] }], logs: { 3: mergeLog(HEAD, MAIN) } });
    const { result, summary, lines } = await station(gh);
    expect(gh.calls).toContain(`run rerun 900 --failed --repo ${REPO}`);
    expect(lines[0]).toBe("Rerunning the failed jobs of CI on #7");
    expect(result).toEqual(verdict({ green: true, tested_main_sha: MAIN, reran: true }));
    expect(summary).toBe("CI green on #7 after a rerun");
  });

  test("a new head gets its own rerun, and ci.json names the head it judged", async () => {
    const run901 = (attempt: number, conclusion: string) => [{ databaseId: 901, status: "completed", conclusion, attempt, workflowName: "CI", event: "pull_request" }];
    const gh = fakeGh({
      polls: [
        { rollup: [check("test-cli", "FAILURE", 2)] },
        { rollup: [check("test-cli", "FAILURE", 12, 3, 0, 901)], head: NEW_HEAD, runs: run901(1, "failure") },
        { rollup: [check("test-cli", "SUCCESS", 13, 3, 0, 901)], head: NEW_HEAD, runs: run901(2, "success") },
      ],
    });
    const { result } = await station(gh);
    expect(gh.calls.filter((c) => c.startsWith("run rerun"))).toEqual([`run rerun 900 --failed --repo ${REPO}`, `run rerun 901 --failed --repo ${REPO}`]);
    expect(result).toMatchObject({ green: true, head_sha: NEW_HEAD });
  });
});

describe("cast flow ci: splitting a red head (routing only, never green)", () => {
  test("red caused by the change: main passed that job", async () => {
    const gh = redAfterRerun([check("lint", "SUCCESS", 2, 1), check("test-cli", "FAILURE", 4)], { logs: { 2: mergeLog(HEAD, MAIN), 4: BUN_LOG }, mainAt: { [MAIN]: [{ databaseId: 50, headSha: MAIN, createdAt: "2026-11-20T15:00:00Z", status: "completed" }] }, jobs: { 50: [job("test-cli", 500, "success")] } });
    const { result, summary } = await station(gh);
    expect(result).toMatchObject({ green: false, reran: true, blocked_by_main: false, preexisting: [] });
    expect(result.failing).toEqual([expect.objectContaining({ job: "test-cli", test: BUN_TEST, file: "packages/cli/src/bench/bootGraph.guard.test.ts", line: 723 })]);
    expect(summary).toBe("CI red on #7: 1 failure in test-cli");
  });

  test("every failure also on main: blocked by main, still red; the tested sha's skipped job falls back to main's nearest earlier run", async () => {
    const gh = redAfterRerun([check("test-cli", "FAILURE", 4)], {
      logs: { 4: BUN_LOG, 601: BUN_LOG.replace(/\/app\/app\//g, "/x/x/") },
      mainAt: { [BASE_OID]: [{ databaseId: 60, headSha: BASE_OID, createdAt: "2026-11-20T15:00:00Z", status: "completed" }] },
      mainEarlier: [{ databaseId: 59, headSha: OLDER_MAIN, createdAt: "2026-11-20T14:00:00Z", status: "completed" }],
      jobs: { 60: [job("test-cli", 600, "skipped")], 59: [job("test-cli", 601, "failure")] },
    });
    const { result, summary } = await station(gh);
    expect(result).toMatchObject({ green: false, blocked_by_main: true, failing: [], tested_main_sha: BASE_OID });
    expect(tests(result.preexisting)).toEqual([["test-cli", BUN_TEST]]);
    expect(gh.calls.some((c) => c.includes(`--created <=2026-11-20T15:00:00Z`))).toBe(true);
    expect(summary).toBe("CI red on #7, blocked by main: all 1 failure also fail on main");
  });

  test("main's run at a tested sha older than any window is fetched by its sha", async () => {
    const gh = redAfterRerun([check("test-cli", "FAILURE", 4)], { logs: { 4: BUN_LOG, 601: BUN_LOG }, ...mainWith([job("test-cli", 601, "failure")]) });
    expect((await station(gh)).result.blocked_by_main).toBe(true);
    expect(gh.calls).toContain(`run list --repo ${REPO} --workflow CI --commit ${BASE_OID} --limit 20 --json databaseId,headSha,createdAt,status`);
  });

  test("one failure main has and one it does not: the change's goes back, nothing is blocked by main", async () => {
    const pr = BUN_LOG.replace(" 1 fail", " 2 fail").replace("1 tests failed:", `2026-11-20T16:38:42.0Z ##[group]src/x.test.ts:\n2026-11-20T16:38:42.1Z error: boom\n2026-11-20T16:38:42.2Z (fail) x > new [1.00ms]\n1 tests failed:`);
    const gh = redAfterRerun([check("test-cli", "FAILURE", 4)], { logs: { 4: pr, 601: BUN_LOG }, ...mainWith([job("test-cli", 601, "failure")]) });
    const { result } = await station(gh);
    expect(tests(result.failing)).toEqual([["test-cli", "x > new"]]);
    expect(tests(result.preexisting)).toEqual([["test-cli", BUN_TEST]]);
    expect(result.blocked_by_main).toBe(false);
  });

  test("a test is matched by its file too: main's `renders` in a.test.ts is not the change's in b.test.ts (P6)", async () => {
    const pr = `2026-11-20T10:00:00.0Z ##[group]src/a.test.ts:\n2026-11-20T10:00:00.1Z error: expect(received).toBe(expected)\n2026-11-20T10:00:00.2Z (fail) renders [1.00ms]\n2026-11-20T10:00:01.0Z ##[group]src/b.test.ts:\n2026-11-20T10:00:01.1Z error: TypeError: undefined is not an object\n2026-11-20T10:00:01.2Z (fail) renders [1.00ms]\n${STEP_END()}`;
    const main = `2026-11-20T10:00:00.0Z ##[group]src/a.test.ts:\n2026-11-20T10:00:00.1Z error: expect(received).toBe(expected)\n2026-11-20T10:00:00.2Z (fail) renders [1.00ms]\n${STEP_END()}`;
    const gh = redAfterRerun([check("test-cli", "FAILURE", 4)], { logs: { 4: pr, 601: main }, ...mainWith([job("test-cli", 601, "failure")]) });
    const { result } = await station(gh);
    expect(result.failing.map((f) => f.file)).toEqual(["src/b.test.ts"]);
    expect(result.preexisting.map((f) => f.file)).toEqual(["src/a.test.ts"]);
    expect(result).toMatchObject({ green: false, blocked_by_main: false });
  });

  test("a failure the log cannot name is main's when main's job failed the same way, the change's when it passed", async () => {
    const red = await station(redAfterRerun([check("build", "FAILURE", 4)], { logs: { 4: VITE_LOG("x"), 601: VITE_LOG("x") }, ...mainWith([job("build", 601, "failure")]) }));
    expect(red.result).toMatchObject({ green: false, blocked_by_main: true, failing: [] });
    const ours = await station(redAfterRerun([check("build", "FAILURE", 4)], { logs: { 4: VITE_LOG("x") }, ...mainWith([job("build", 601, "success")]) }));
    expect(ours.result.failing.map((f) => f.job)).toEqual(["build"]);
  });

  test("a step the log cannot name, broken differently from main's red one (a typecheck on other errors), is the change's", async () => {
    const typecheck = (errors: string) => `2026-11-20T16:40:00.0Z ##[group]Run cast check\n2026-11-20T16:40:00.1Z ##[endgroup]\n2026-11-20T16:40:01.0Z ${errors}\n${STEP_END()}`;
    const differ = await station(redAfterRerun([check("typecheck", "FAILURE", 4)], { logs: { 4: typecheck("cli: 3 errors in the change's own files"), 601: typecheck("cli: 1 error on main") }, ...mainWith([job("typecheck", 601, "failure")]) }));
    expect(differ.result).toMatchObject({ green: false, blocked_by_main: false, preexisting: [] });
    expect(differ.result.failing.map((f) => f.job)).toEqual(["typecheck"]);
    const same = await station(redAfterRerun([check("typecheck", "FAILURE", 4)], { logs: { 4: typecheck("cli: 1 error on main"), 601: typecheck("cli: 1 error on main") }, ...mainWith([job("typecheck", 601, "failure")]) }));
    expect(same.result).toMatchObject({ blocked_by_main: true, failing: [] });
  });

  test("a step the log cannot name is main's when its excerpt differs only in numbers: durations and pass counts", async () => {
    const run = (took: string, passed: number) => `2026-11-20T16:40:00.0Z ##[group]Run bun run guard\n2026-11-20T16:40:00.1Z ##[endgroup]\n2026-11-20T16:40:01.0Z ${passed} pass [${took}]\n2026-11-20T16:40:01.1Z guard failed in ${took}\n${STEP_END()}`;
    const same = await station(redAfterRerun([check("guard", "FAILURE", 4)], { logs: { 4: run("1.20s", 412), 601: run("12.3s", 409) }, ...mainWith([job("guard", 601, "failure")]) }));
    expect(same.result).toMatchObject({ blocked_by_main: true, failing: [] });
  });

  test("an unreadable pull request log is the change's", async () => {
    const { result } = await station(redAfterRerun([check("test-cli", "FAILURE", 4)], { logs: { 601: BUN_LOG }, ...mainWith([job("test-cli", 601, "failure")]) }));
    expect(result.failing).toEqual([expect.objectContaining({ job: "test-cli", excerpt: expect.stringContaining("its log could not be read") })]);
    expect(result.blocked_by_main).toBe(false);
  });

  test("a failed status from outside Actions is the change's", async () => {
    const { result } = await station(fakeGh({ polls: [{ rollup: [check("lint", "SUCCESS", 1, 1), status("vercel", "FAILURE")] }], logs: { 1: mergeLog(HEAD, MAIN) } }));
    expect(result.failing).toEqual([expect.objectContaining({ job: "vercel" })]);
    expect(result.green).toBe(false);
  });

  test("log reading after the wait stops at the grace period: what it could not read stays the change's", async () => {
    const gh = redAfterRerun([check("classify", "SUCCESS", 6, 0), check("lint", "FAILURE", 2, 1), check("test-cli", "FAILURE", 4, 9)], {
      logs: { 5: mergeLog(HEAD, MAIN), 6: mergeLog(HEAD, MAIN), 2: BUN_LOG, 4: BUN_LOG },
      onLog: (id) => { if (id === 2 || id === 4) clock += 6 * 60_000; },
    });
    const { result } = await station(gh);
    expect(result.failing.map((f) => [f.job, f.excerpt.includes("ran out of time")])).toEqual([["lint", false], ["test-cli", true]]);
  });
});

describe("cast flow ci: a change to CI is a person's to judge", () => {
  // Green stays GitHub's verdict; ci_changed sends the change to a person's Ship, and Merge needs both.
  test("a change that drops its own pull_request trigger is flagged as a CI edit (P4)", async () => {
    const gh = fakeGh({ polls: [{ rollup: [] }], workflows: { ".github/workflows/ci.yml": "name: CI\non:\n  push:\n    branches: [main]\n" }, files: [".github/workflows/ci.yml", "src/app.ts"] });
    const { result, summary } = await station(gh);
    expect(result).toMatchObject({ green: true, ci_changed: true, no_ci: true });
    expect(summary).toBe("CI green on #7, but it edits CI (.github/workflows/ci.yml): a person must look");
  });

  test("a change that gates its own test job off (skipped) is flagged as a CI edit (P4b)", async () => {
    const gh = fakeGh({ polls: [{ rollup: [check("lint", "SUCCESS", 1, 1), skippedCheck("test-cli", 2)] }], logs: { 1: mergeLog(HEAD, MAIN) }, files: [".github/workflows/ci.yml", "src/app.ts"] });
    expect((await station(gh)).result).toMatchObject({ green: true, ci_changed: true });
  });

  test("a red CI edit is red and flagged", async () => {
    const gh = fakeGh({ polls: [{ rollup: [check("lint", "SUCCESS", 1, 1), status("vercel", "FAILURE")] }], logs: { 1: mergeLog(HEAD, MAIN) }, files: [".github/workflows/ci.yml"] });
    const { result, summary } = await station(gh);
    expect(result).toMatchObject({ green: false, ci_changed: true });
    expect(summary).toBe("CI red on #7: 1 failure in vercel; it edits CI (.github/workflows/ci.yml)");
  });

  test("a path the line profile lists as CI counts too, and so does a file list at GitHub's cap", async () => {
    const pass = { polls: [{ rollup: [check("lint", "SUCCESS", 1, 1)] }], logs: { 1: mergeLog(HEAD, MAIN) } };
    const profile = { ".codecast/line.toml": '[line]\nci_paths = ["scripts/ci/**"]\n' };
    const listed = fakeGh({ ...pass, files: ["scripts/ci/changed-path-scope.ts"], repoFiles: profile });
    expect((await station(listed)).result).toMatchObject({ green: true, ci_changed: true });
    // The list is the base's, read at the tested main sha, never the change's own checkout.
    expect(listed.calls).toContain(`api repos/${REPO}/contents/.codecast/line.toml?ref=${MAIN} --jq .content`);
    expect((await station(fakeGh({ ...pass, files: ["scripts/ci/changed-path-scope.ts"] }))).result).toMatchObject({ green: true, ci_changed: false });
    const many = Array.from({ length: 3000 }, (_, i) => `src/f${i}.ts`);
    const capped = await station(fakeGh({ ...pass, files: many }));
    expect(capped.result).toMatchObject({ green: true, ci_changed: true });
    expect(capped.summary).toBe("CI green on #7, but its file list is too long to rule out an edit to CI: a person must look");
  });
});

describe("cast flow ci: the verifier's wrong greens stay red", () => {
  const redWithMainFailing = (prLog: string, mainLog = BUN_LOG) =>
    station(redAfterRerun([check("test-cli", "FAILURE", 4)], { logs: { 4: prLog, 601: mainLog }, ...mainWith([job("test-cli", 601, "failure")]) }));

  test("P1 a file that no longer loads, beside a failure main has", async () => {
    const pr = `${bunLogBody}\n2026-11-20T16:38:42.0Z ##[group]src/newFeature.test.ts:\n2026-11-20T16:38:42.1Z # Unhandled error between tests\n2026-11-20T16:38:42.3Z error: Cannot find module "./newFeature"\n2026-11-20T16:38:42.5Z  1 error\n${STEP_END()}`;
    const { result } = await redWithMainFailing(pr);
    expect(result).toMatchObject({ green: false, blocked_by_main: false });
    expect(result.failing).toEqual([expect.objectContaining({ test: null, assertion: "bun reported 1 error between tests" })]);
  });

  test("P2 a second failed step after a first whose failure main has", async () => {
    const pr = `${bunLogBody}\n${STEP_END()}\n2026-11-20T16:39:00.0Z ##[group]Run bun run guard\n2026-11-20T16:39:00.2Z ##[endgroup]\n2026-11-20T16:39:01.0Z fatal: guard failed\n${STEP_END()}`;
    const { result } = await redWithMainFailing(pr);
    expect(result.green).toBe(false);
    expect(tests(result.preexisting)).toEqual([["test-cli", BUN_TEST]]);
    // Unnamed, so routed by job: main's test-cli failed too. Still red; the rebased rerun corrects a misroute.
    expect(result.preexisting.length + result.failing.length).toBe(2);
  });

  test("P3 a retried step's (fail) lines do not stand in for the failed step", async () => {
    const pr = `2026-11-20T16:30:00.0Z ##[group]Run bun test e2e\n2026-11-20T16:30:00.2Z ##[endgroup]\n${bunLogBody}\n2026-11-20T16:39:00.0Z ##[group]Run bun scripts/build.ts\n2026-11-20T16:39:00.2Z ##[endgroup]\n2026-11-20T16:39:01.0Z error: Could not resolve "./newThing"\n${STEP_END()}`;
    const { result } = await redWithMainFailing(pr);
    expect(result.green).toBe(false);
    expect(tests([...result.failing, ...result.preexisting])).toEqual([["test-cli", null]]);
  });

  test("P7 a continue-on-error job with a templated name excuses nothing: GitHub's run conclusion decides", async () => {
    const wf = "name: CI\non: pull_request\njobs:\n  smoke:\n    name: ${{ matrix.label }}\n    continue-on-error: true\n  test-cli: {}\n";
    const gh = redAfterRerun([check("lint", "SUCCESS", 2, 1), check("test-cli", "FAILURE", 4)], { logs: { 2: mergeLog(HEAD, MAIN), 4: BUN_LOG }, workflows: { ".github/workflows/ci.yml": wf } });
    const { result } = await station(gh);
    expect(result).toMatchObject({ green: false, blocked_by_main: false });
    expect(tests(result.failing)).toEqual([["test-cli", BUN_TEST]]);
  });

  test("P8 main's history of the test cannot make a red head green, flake or no flake", async () => {
    const { result } = await station(redAfterRerun([check("test-cli", "FAILURE", 4)], { logs: { 4: BUN_LOG }, ...mainWith([job("test-cli", 600, "success")]) }));
    expect(result).toMatchObject({ green: false, blocked_by_main: false });
  });

  test("P9 two different unnamed build failures: routed by job, never green", async () => {
    const build = (real: string) => `2026-11-20T16:40:00.0Z ##[group]Run bun run build\n2026-11-20T16:40:00.0Z ##[endgroup]\n2026-11-20T16:40:00.1Z warn: package "error-ex" is deprecated\n2026-11-20T16:40:01.0Z ${real}\n${STEP_END()}`;
    const gh = redAfterRerun([check("build", "FAILURE", 4)], { logs: { 4: build('Could not resolve "./newThing"'), 601: build("Out of memory building chunk vendor") }, ...mainWith([job("build", 601, "failure")]) });
    expect((await station(gh)).result.green).toBe(false);
  });

  test("P11 main failing a test one way and the change another: routed to main by test and file, never green", async () => {
    const differentWay = BUN_LOG.replace("error: source files on daemon.ts's static graph", "error: TypeError: graph.nodes is undefined");
    const { result } = await redWithMainFailing(differentWay);
    expect(result).toMatchObject({ green: false, blocked_by_main: true });
  });
});

describe("cast flow ci: the verdict on the server", () => {
  /** A fake codecast server: it records what it is sent, and answers 500 while `down`. */
  function fakeServer() {
    const got: Array<{ path: string; body: any }> = [];
    let down = false;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json();
        got.push({ path: new URL(req.url).pathname, body: structuredClone(body) });
        return down ? new Response("boom", { status: 500 }) : Response.json({ ok: true });
      },
    });
    // The CLI's cliPost: throws on a failed answer only when asked to.
    const cliPost = async (urlPath: string, body: Record<string, any>, opts?: { throwOnError?: boolean }) => {
      const res = await fetch(`http://localhost:${server.port}${urlPath}`, { method: "POST", body: JSON.stringify(body) });
      if (!res.ok && opts?.throwOnError) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return res.ok ? res.json() : null;
    };
    return { got, cliPost, setDown: (d: boolean) => { down = d; }, stop: () => server.stop(true) };
  }

  async function run(gh: Gh, server: ReturnType<typeof fakeServer>, o: { run?: string; node?: string } = { run: "wr-1", node: "ci" }) {
    const dir = tmpDir();
    const out: string[] = [];
    const err: string[] = [];
    const log = spyOn(console, "log").mockImplementation((l: string) => { out.push(l); });
    const error = spyOn(console, "error").mockImplementation((l: string) => { err.push(l); });
    clock = NOW;
    try {
      await ciCommand({ pr: "7", dir, deadline: "60m", ...o }, server.cliPost, { gh, now: () => clock, sleep: async (ms) => { clock += ms; }, pollMs: 30_000 });
      // Progress posts are fire-and-forget: let them land before reading what the server got.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    return { out, err, verdicts: server.got.filter((g) => g.path === "/cli/workflow-runs/ci-verdict").map((g) => g.body), json: JSON.parse(fs.readFileSync(path.join(dir, "ci.json"), "utf-8")) };
  }
  const passing = () => fakeGh({ polls: [{ rollup: [check("lint", "SUCCESS", 1, 1)] }], logs: { 1: mergeLog(HEAD, MAIN) } });
  const failing = () => fakeGh({ polls: [{ rollup: [check("lint", "SUCCESS", 1, 1), status("vercel", "FAILURE")] }], logs: { 1: mergeLog(HEAD, MAIN) } });

  test("posts the run's verdict, green exactly as ci.json holds it, for the head it judged", async () => {
    const server = fakeServer();
    try {
      const green = await run(passing(), server);
      expect(green.verdicts).toEqual([{ run_id: "wr-1", node_id: "ci", green: true, head_sha: HEAD }]);
      expect(green.json.green).toBe(true);
      expect(green.out.at(-1)).toBe("CI green on #7");
      // Progress went to the same run's station while it waited.
      expect(server.got.some((g) => g.path === "/cli/workflow-runs/progress" && g.body.node_id === "ci")).toBe(true);
      server.got.length = 0;
      const red = await run(failing(), server);
      expect(red.verdicts).toEqual([{ run_id: "wr-1", node_id: "ci", green: false, head_sha: HEAD }]);
      expect(red.json.green).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("a CI edit that passed posts green: the person's Ship, not the verdict, holds it back", async () => {
    const server = fakeServer();
    try {
      const edit = fakeGh({ polls: [{ rollup: [check("lint", "SUCCESS", 1, 1)] }], logs: { 1: mergeLog(HEAD, MAIN) }, files: [".github/workflows/ci.yml"] });
      const { verdicts, json } = await run(edit, server);
      expect(verdicts).toEqual([{ run_id: "wr-1", node_id: "ci", green: true, head_sha: HEAD, ci_changed: true }]);
      expect(json).toMatchObject({ green: true, ci_changed: true });
    } finally {
      server.stop();
    }
  });

  test("a verdict the server refuses is one line on stderr; ci.json and the summary still stand", async () => {
    const server = fakeServer();
    server.setDown(true);
    try {
      const { err, out, json, verdicts } = await run(passing(), server);
      expect(verdicts).toHaveLength(1);
      expect(err.filter((l) => l.startsWith("The CI verdict could not be recorded"))).toEqual(["The CI verdict could not be recorded on the run, so Merge will refuse it: HTTP 500: boom"]);
      expect(json.green).toBe(true);
      expect(out.at(-1)).toBe("CI green on #7");
    } finally {
      server.stop();
    }
  });

  test("no post can exit the process: every one asks for an error to be thrown", async () => {
    // The CLI's cliPost exits the process on an error reply unless asked to throw; this one records that instead.
    const exits: string[] = [];
    const posts: string[] = [];
    const cliPost = async (urlPath: string, _body: Record<string, any>, opts?: { throwOnError?: boolean }) => {
      posts.push(urlPath);
      if (!opts?.throwOnError) exits.push(urlPath);
      throw new Error("Not found");
    };
    const dir = tmpDir();
    const quiet = [spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {})];
    clock = NOW;
    try {
      const gh = fakeGh({ polls: [{ rollup: [check("lint", null, 1)] }, { rollup: [check("lint", "SUCCESS", 1, 1)] }], logs: { 1: mergeLog(HEAD, MAIN) } });
      await ciCommand({ pr: "7", dir, deadline: "60m", run: "wr-1", node: "ci" }, cliPost, { gh, now: () => clock, sleep: async (ms) => { clock += ms; }, pollMs: 30_000 });
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      for (const q of quiet) q.mockRestore();
    }
    expect(posts).toContain("/cli/workflow-runs/progress");
    expect(posts).toContain("/cli/workflow-runs/ci-verdict");
    expect(exits).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "ci.json"), "utf-8")).green).toBe(true);
  });

  test("outside a run nothing is posted", async () => {
    const server = fakeServer();
    const saved = { run_id: process.env.run_id, station_id: process.env.station_id };
    delete process.env.run_id;
    delete process.env.station_id;
    try {
      const { out } = await run(passing(), server, {});
      expect(server.got).toEqual([]);
      expect(out.at(-1)).toBe("CI green on #7");
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
      server.stop();
    }
  });
});

describe("cast flow ci: the head it waits for", () => {
  const done901 = [{ databaseId: 901, status: "completed", conclusion: "success", attempt: 1, workflowName: "CI", event: "pull_request" }];

  for (const status of ["behind", "diverged"]) {
    test(`a head that moved past or away from the awaited one (${status}) stops the wait within one look, unjudged`, async () => {
      const gh = fakeGh({ polls: [{ head: NEW_HEAD, rollup: [check("lint", "SUCCESS", 11, 1, 0, 901)], runs: done901 }], compare: { [`${NEW_HEAD}...${HEAD}`]: status } });
      const { result, summary } = await station(gh, { head: HEAD });
      expect(result).toEqual(verdict({ head_sha: null, head_moved: true, observed_head: NEW_HEAD }));
      expect(summary).toBe("PR head moved to eeeeeee while waiting for aaaaaaa; a new round starts");
      expect(gh.calls.filter((c) => c.startsWith("pr view"))).toHaveLength(1);
      expect(clock).toBe(NOW);
    });
  }

  test("a head that has not caught up yet (an ancestor of the awaited one, or the awaited sha unknown) keeps the wait", async () => {
    const lagging = fakeGh({ polls: [{ head: OLDER_MAIN, rollup: [check("lint", "SUCCESS", 1, 1)] }, { rollup: [check("lint", "SUCCESS", 1, 1)] }], logs: { 1: mergeLog(HEAD, MAIN) }, compare: { [`${OLDER_MAIN}...${HEAD}`]: "ahead" } });
    expect((await station(lagging, { head: HEAD })).result).toMatchObject({ green: true, head_sha: HEAD, head_moved: false });
    const unknown = fakeGh({ polls: [{ head: OLDER_MAIN, rollup: [] }] });
    expect((await station(unknown, { head: HEAD, deadlineMs: 2 * 60_000 })).result).toMatchObject({ timed_out: true, head_sha: null, head_moved: false });
  });

  test("a moved head posts no verdict, and the command still ends with its summary", async () => {
    const posts: string[] = [];
    const cliPost = async (urlPath: string) => { posts.push(urlPath); return {}; };
    const dir = tmpDir();
    const out: string[] = [];
    const quiet = [spyOn(console, "log").mockImplementation((l: string) => { out.push(l); }), spyOn(console, "error").mockImplementation(() => {})];
    try {
      const gh = fakeGh({ polls: [{ head: NEW_HEAD, rollup: [check("lint", "SUCCESS", 11, 1, 0, 901)], runs: done901 }], compare: { [`${NEW_HEAD}...${HEAD}`]: "behind" } });
      await ciCommand({ pr: "7", dir, deadline: "60m", head: HEAD, run: "wr-1", node: "ci" }, cliPost, { gh, now: () => clock, sleep: async (ms) => { clock += ms; }, pollMs: 30_000 });
    } finally {
      for (const q of quiet) q.mockRestore();
    }
    expect(posts.filter((p) => p === "/cli/workflow-runs/ci-verdict")).toEqual([]);
    expect(out.at(-1)).toBe("PR head moved to eeeeeee while waiting for aaaaaaa; a new round starts");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "ci.json"), "utf-8"))).toMatchObject({ green: false, head_sha: null, head_moved: true, observed_head: NEW_HEAD });
  });
});

describe("cast flow ci: the second verifier's probes", () => {
  test("V1 a workflow renamed out of .github is a CI edit: the files query names the old path too", async () => {
    const gh = fakeGh({
      polls: [{ rollup: [check("test", "SUCCESS", 11)] }],
      logs: { 11: mergeLog(HEAD, MAIN) },
      // What `.[] | .filename, (.previous_filename // empty)` prints for the move.
      files: ["docs/old-workflows/lint.yml", ".github/workflows/lint.yml"],
      workflows: { ".github/workflows/ci.yml": CI_WORKFLOW, ".github/workflows/lint.yml": "name: Lint\non: pull_request\n" },
      fail: (a) => (a.includes("contents/.github/workflows/lint.yml") ? { code: 1, out: "HTTP 404: Not Found" } : null),
    });
    const { result } = await station(gh);
    expect(result.ci_changed).toBe(true);
    expect(gh.calls).toContain(`api --paginate repos/${REPO}/pulls/7/files --jq .[] | .filename, (.previous_filename // empty)`);
  });

  test("V2 unnamed failures in different steps are different failures: main's crashed lint is not the change's build", async () => {
    const mainLog = `2026-11-20T10:00:00.0Z ##[group]Run bun run lint\n2026-11-20T10:00:01.0Z Segmentation fault\n${STEP_END()}`;
    const prLog = `2026-11-20T10:00:00.0Z ##[group]Run bun run build\n2026-11-20T10:00:01.0Z error during build: Could not resolve "./newThing"\n${STEP_END()}`;
    const gh = redAfterRerun([check("verify", "FAILURE", 21)], { logs: { 20: mergeLog(HEAD, BASE_OID) + prLog, 21: mergeLog(HEAD, BASE_OID) + prLog, 61: mainLog }, ...mainWith([job("verify", 61, "failure")]) });
    const { result } = await station(gh);
    expect(result).toMatchObject({ green: false, blocked_by_main: false });
    expect(result.failing.map((f) => f.job)).toEqual(["verify"]);
    // The same step failing on main the same way is still main's; failing it another way is the change's.
    const same = redAfterRerun([check("verify", "FAILURE", 21)], { logs: { 21: prLog, 61: prLog }, ...mainWith([job("verify", 61, "failure")]) });
    expect((await station(same)).result.blocked_by_main).toBe(true);
    const otherWay = redAfterRerun([check("verify", "FAILURE", 21)], { logs: { 21: prLog, 61: prLog.replace("newThing", "otherThing") }, ...mainWith([job("verify", 61, "failure")]) });
    expect((await station(otherWay)).result.blocked_by_main).toBe(false);
  });

  test("V3 waiting for --head A while the pull request is at B: ci.json names no head", async () => {
    const gh = fakeGh({ polls: [{ head: NEW_HEAD, rollup: [check("test", "SUCCESS", 11, 3, 0, 901)], runs: [{ databaseId: 901, status: "completed", conclusion: "success", attempt: 1, workflowName: "CI", event: "pull_request" }] }] });
    const { result, summary } = await station(gh, { head: HEAD, deadlineMs: 5 * 60_000 });
    expect(result).toMatchObject({ green: false, timed_out: true, head_sha: null });
    expect(summary).toBe("CI timed out on #7 after 5m: waiting on the head to be aaaaaaa (it is eeeeeee)");
  });

  test("V4 a capped file list with a paths-filtered workflow is never a clean green", async () => {
    const files = Array.from({ length: 3000 }, (_, i) => `src/f${i}.ts`);
    const gh = fakeGh({ polls: [{ rollup: [check("test", "SUCCESS", 11)] }], logs: { 11: mergeLog(HEAD, MAIN) }, files, workflows: { ".github/workflows/ci.yml": CI_WORKFLOW, ".github/workflows/e2e.yml": "name: E2E\non:\n  pull_request:\n    paths: ['src/**']\n" } });
    const { result } = await station(gh);
    expect(result.green === false || result.ci_changed === true).toBe(true);
  });

  test("V5 a failing check from another run on the head (a workflow_run follow-up) is red", async () => {
    const gh = fakeGh({
      polls: [{ rollup: [check("test", "SUCCESS", 11), check("security", "FAILURE", 99, 3, 0, 950)], runs: [
        { databaseId: 900, status: "completed", conclusion: "success", attempt: 1, workflowName: "CI", event: "pull_request" },
        { databaseId: 950, status: "completed", conclusion: "failure", attempt: 1, workflowName: "Security", event: "workflow_run" },
      ] }],
      logs: { 11: mergeLog(HEAD, MAIN) },
    });
    const { result } = await station(gh);
    expect(result.green).toBe(false);
    expect(result.failing.map((f) => f.job)).toEqual(["security"]);
  });

  test("V6 a run that concluded skipped (every job skipped) is no failure", async () => {
    const gh = fakeGh({
      polls: [{ rollup: [check("test", "SUCCESS", 11), skippedCheck("deploy-preview", 12)], runs: [
        { databaseId: 900, status: "completed", conclusion: "success", attempt: 1, workflowName: "CI", event: "pull_request" },
        { databaseId: 951, status: "completed", conclusion: "skipped", attempt: 1, workflowName: "Preview", event: "pull_request" },
      ] }],
      logs: { 11: mergeLog(HEAD, MAIN) },
    });
    const { result, summary } = await station(gh);
    expect(result).toMatchObject({ green: true, failing: [] });
    expect(summary).toBe("CI green on #7");
  });

  test("a run waiting for a maintainer's approval says so", async () => {
    const gh = fakeGh({
      polls: [{ rollup: [], runs: [{ databaseId: 900, status: "completed", conclusion: "action_required", attempt: 1, workflowName: "CI", event: "pull_request" }] }],
      jobs: { 900: [] },
      fail: (a) => (a.startsWith("run rerun") ? { code: 1, out: "cannot rerun" } : null),
    });
    const { result } = await station(gh);
    expect(result.green).toBe(false);
    expect(result.failing).toEqual([expect.objectContaining({ job: "CI", excerpt: "CI is waiting for approval to run: a maintainer must approve this pull request's workflows on GitHub." })]);
  });

  test(".codecast/** is always CI, even when the base's profile lists nothing", async () => {
    const gh = fakeGh({ polls: [{ rollup: [check("lint", "SUCCESS", 1, 1)] }], logs: { 1: mergeLog(HEAD, MAIN) }, files: [".codecast/line.toml"] });
    expect((await station(gh)).result).toMatchObject({ green: true, ci_changed: true });
  });
});

describe("cast flow ci: job logs carry terminal escapes", () => {
  // As Actions serves it: bun's colours around the markers the parser reads.
  const colouredLog = BUN_LOG.replace(/\(fail\)/g, "\x1b[31m(fail)\x1b[0m").replace(/error:/g, "\x1b[31merror:\x1b[0m");
  const red = (escapes: "required" | "unknown") => fakeGh({
    polls: [{ rollup: [check("lint", "SUCCESS", 1, 1), check("test-cli", "FAILURE", 2)] }],
    fail: (a) => (a.startsWith("run rerun") ? { code: 1, out: "no" } : null),
    logs: { 1: mergeLog(HEAD, MAIN), 2: colouredLog },
    escapes,
  });
  const logReads = (gh: { calls: string[] }) => gh.calls.filter((c) => c.includes("/logs"));
  const named = [expect.objectContaining({ job: "test-cli", test: BUN_TEST, file: "packages/cli/src/bench/bootGraph.guard.test.ts", line: 723 })];

  test("gh 2.105, which refuses escapes without --allow-escape-sequences: the log still names the failure", async () => {
    const gh = red("required");
    const { result } = await station(gh);
    expect(result.tested_main_sha).toBe(MAIN);
    expect(result.failing).toEqual(named);
    expect(logReads(gh).every((c) => c.endsWith(" --allow-escape-sequences"))).toBe(true);
  });

  test("a gh older than the flag rejects it: one retry without it, and no later read passes it", async () => {
    const gh = red("unknown");
    const { result } = await station(gh);
    expect(result.tested_main_sha).toBe(MAIN);
    expect(result.failing).toEqual(named);
    const reads = logReads(gh);
    expect(reads.filter((c) => c.endsWith(" --allow-escape-sequences"))).toHaveLength(1);
    expect(reads.filter((c) => c.includes("jobs/2/logs") && !c.includes("--allow"))).toHaveLength(1);
  });
});
