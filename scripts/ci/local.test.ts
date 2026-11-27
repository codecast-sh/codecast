import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asJobLog,
  CAST_CHECK_REPLACES,
  DEFAULT_DROPS,
  hostMismatch,
  localJobs,
  matrixOf,
  planJobs,
  REACHED_STEPS,
  RUNNER_SETUP,
  runnerEnv,
  selectTests,
  stepFailures,
  stepRuns,
  suiteWideBy,
  sweepTmux,
  typecheckFailures,
  unmodeledSteps,
  walksOwnTree,
  namedFiles,
  withoutAgentClients,
} from "./local";

// Planning reads the import graph of every test file in the tree: seconds, more on a loaded machine.
setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..", "..");
const CI_YML = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as any;
const plan = (changed: string[], full = false) =>
  Object.fromEntries(planJobs(changed, { base: "BASE", full, temp: "/tmp/x" }).map((p) => [p.job, p]));
const argvs = (p: { steps: Array<{ argv: string[] }> }) => p.steps.map((s) => s.argv);
const allFiles = (p: { steps: Array<{ argv: string[] }> }) => p.steps.flatMap((s) => s.argv);

describe("selectTests", () => {
  // Each test's imports with their distance. deep.ts sits two imports under a.test.ts.
  const graph: Record<string, Record<string, number>> = {
    "packages/web/a.test.ts": { "packages/web/a.test.ts": 0, "packages/web/a.ts": 1, "packages/web/deep.ts": 2 },
    "packages/web/b.test.ts": { "packages/web/b.test.ts": 0, "packages/web/b.ts": 1 },
    "packages/web/scan.test.ts": { "packages/web/scan.test.ts": 0 },
    "packages/mobile/scan.test.ts": { "packages/mobile/scan.test.ts": 0 },
  };
  const scan = `const root = path.resolve(import.meta.dir, ".."); fs.readdirSync(root)`;
  const select = (g: typeof graph, changed: string[], source: (t: string) => string = (t) => (t.endsWith("scan.test.ts") ? scan : "")) =>
    selectTests(Object.keys(g), changed, (t) => new Map(Object.entries(g[t])), source);
  const pick = (changed: string[]) => select(graph, changed).picked;

  test("a test runs when something it imports changed, through any number of files", () => {
    expect(pick(["packages/web/deep.ts"])).toEqual(["packages/web/a.test.ts", "packages/web/scan.test.ts"]);
    expect(pick(["packages/web/b.ts"])).toEqual(["packages/web/b.test.ts", "packages/web/scan.test.ts"]);
  });

  test("a changed test runs itself", () => {
    expect(pick(["packages/mobile/scan.test.ts"])).toEqual(["packages/mobile/scan.test.ts"]);
  });

  test("a test that scans its package runs on any change in that package, and only that package", () => {
    expect(pick(["packages/mobile/app/screen.tsx"])).toEqual(["packages/mobile/scan.test.ts"]);
    expect(pick(["docs/x.md"])).toEqual([]);
  });

  test("a changed hub runs only the tests that import it directly, and says how many it reached", () => {
    // hub.ts: a.test.ts imports it, the other ten reach it two imports down.
    const many: typeof graph = { "packages/web/a.test.ts": { "packages/web/a.test.ts": 0, "packages/web/hub.ts": 1 } };
    for (let i = 0; i < 10; i++) many[`packages/web/t${i}.test.ts`] = { [`packages/web/t${i}.test.ts`]: 0, "packages/web/mid.ts": 1, "packages/web/hub.ts": 2 };
    expect(select(many, ["packages/web/hub.ts"], () => "")).toEqual({ picked: ["packages/web/a.test.ts"], reached: 11 });
    // mid.ts is a hub too, and all ten import it directly.
    expect(select(many, ["packages/web/hub.ts", "packages/web/mid.ts"], () => "").picked.length).toBe(11);
  });

  test("a source scan is a directory walk from the file's own place", () => {
    expect(walksOwnTree(scan)).toBe(true);
    expect(walksOwnTree(`fs.readdirSync(mkdtempSync(join(tmpdir(), "x")))`)).toBe(false);
    expect(walksOwnTree(`readFileSync(join(import.meta.dir, "golden.json"))`)).toBe(false);
  });

  // The review's misses on PR #227's tree: each test reads its subject off disk and imports nothing of it.
  test.each([
    ["packages/web/components/conversationScroll.test.ts", "packages/web/components/ConversationView.tsx"],
    ["packages/web/plugins/handoffBoot.test.ts", "packages/web/lib/desktopHandoff.ts"],
    ["packages/web/components/DashboardLayout.createModals.test.ts", "packages/web/components/DashboardLayout.tsx"],
  ])("%s runs when %s, the file it reads, changes", (testFile, changed) => {
    const source = readFileSync(join(ROOT, testFile), "utf8");
    expect(namedFiles(source, [changed, "packages/web/lib/other.ts"])).toEqual([changed]);
    expect(plan([changed])["test-web"].steps.some((s) => s.argv.includes(`./${testFile.slice("packages/web/".length)}`))).toBe(true);
  });

  test("a file is named by its name or a path ending in it, and only by a test that reads files", () => {
    const reads = (literal: string) => `readFileSync(join(import.meta.dir, ${literal}), "utf8")`;
    expect(namedFiles(reads(`"../lib/x.ts"`), ["packages/web/lib/x.ts"])).toEqual(["packages/web/lib/x.ts"]);
    expect(namedFiles(reads(`"other/x.ts"`), ["packages/web/lib/x.ts"])).toEqual([]);
    expect(namedFiles(`const name = "x.ts";`, ["packages/web/lib/x.ts"])).toEqual([]);
  });
});

describe("a config change runs a suite whole", () => {
  test.each([
    ["bun.lock", "packages/web"],
    ["package.json", "packages/cli"],
    ["tsconfig.base.json", "packages/convex"],
    ["packages/web/package.json", "packages/web"],
    ["packages/web/store/__tests__/sim/tsconfig.json", "packages/web"],
    ["packages/cli/bunfig.toml", "packages/cli"],
    ["packages/cli/src/test-helpers/isolatedTmuxServer.ts", "packages/cli"],
  ])("%s runs %s whole", (file, dir) => {
    expect(suiteWideBy(dir, [file], new Set(["packages/cli/src/test-helpers/isolatedTmuxServer.ts"]))).toBe(file);
  });

  test("another package's manifest leaves a suite to its reached files", () => {
    expect(suiteWideBy("packages/web", ["packages/cli/package.json", "packages/web/lib/x.ts"], new Set())).toBeNull();
  });

  test("a changed preload file runs every cli test", () => {
    const p = plan(["packages/cli/src/test-helpers/gitIdentity.ts"]);
    expect(p["test-cli"].wide).toEqual(["packages/cli (packages/cli/src/test-helpers/gitIdentity.ts)"]);
    expect(p["test-cli"].narrowed).toEqual([]);
  });
});

describe("planJobs", () => {
  test("a docs change runs the ungated jobs and skips the jobs docs do not gate", () => {
    const p = plan(["docs/guide.md"]);
    expect(p["ci-contract"].steps.length).toBe(1);
    expect(p["test-always"].steps.map((s) => s.name)).toContain("Always-run tests (every package)");
    for (const job of ["build", "typecheck", "lint", "test-web", "test-convex", "test-mobile"]) {
      expect(p[job].skip).toBe("nothing it gates on changed");
    }
    expect(p.verify).toBeUndefined();
    expect(p["computer-macos"]).toBeUndefined();
  });

  test("a mobile screen change runs the mobile tests that scan the screens, with --isolate from packages/mobile", () => {
    const p = plan(["packages/mobile/app/(tabs)/inbox.tsx"]);
    const [argv] = argvs(p["test-mobile"]);
    expect(argv.slice(0, 3)).toEqual(["bun", "test", "--isolate"]);
    expect(argv).toContain("./lib/popups.test.ts");
    // Guards ran in test-always; they are not run twice.
    expect(argv.some((f) => f.includes(".guard.test."))).toBe(false);
    expect(p["test-mobile"].steps[0].cwd).toBe(join(ROOT, "packages/mobile"));
    expect(p["test-web"].skip).toBeDefined();
  });

  test("by default typecheck asks cast check about the change, build waits for --full, cli runs a runner's four workers", () => {
    const p = plan(["packages/cli/src/index.ts"]);
    expect(argvs(p.typecheck)).toEqual([["cast", "check", "--changed-since", "BASE", "--json"]]);
    expect(p.build.skip).toBe("--full only: Build");
    const cli = p["test-cli"].steps.filter((s) => s.cwd === join(ROOT, "packages/cli"));
    expect(cli.length).toBeGreaterThan(0);
    expect(cli.every((s) => s.argv.includes("--parallel=4"))).toBe(true);
  });

  test("--no-typecheck leaves typechecking to CI and plans the rest as before", () => {
    const p = Object.fromEntries(planJobs(["packages/cli/src/index.ts"], { base: "BASE", full: false, temp: "/tmp/x", noTypecheck: true }).map((x) => [x.job, x]));
    expect(p.typecheck.skip).toBe("left to CI (--no-typecheck)");
    expect(p.typecheck.steps).toEqual([]);
    expect(p["test-cli"].steps.length).toBeGreaterThan(0);
  });

  test("--full runs each gated job's ci.yml steps once per matrix runner, typecheck still through cast check by program", () => {
    const p = plan(["packages/web/lib/x.ts", "packages/cli/src/x.ts"], true);
    expect(argvs(p.typecheck)).toEqual([["cast", "check", "web", "cli", "evals", "convex", "sim", "playground", "--json"]]);
    const web = p["test-web"].steps;
    expect(web.map((s) => s.name)).toEqual([1, 2, 3, 4].map((n) => `Unit tests (web package) [${n}]`).concat("Perf budgets (web) [1]"));
    expect(web.map((s) => !!s.shard)).toEqual([true, true, true, true, false]);
    expect(web[1].argv.at(-1)).toContain("test-shards.ts packages/web 2/4");
    expect(web[1].argv.at(-1)).toContain("bun test --parallel=4 --reporter=junit --reporter-outfile=/tmp/x/test-web.2/junit.xml");
    expect(web[1].cwd).toBe(join(ROOT, "packages/web"));
    expect(web[1].env).toMatchObject({ SIM_OUT: "/tmp/x/test-web.2/sim", RUNNER_TEMP: "/tmp/x/test-web.2" });
    const cli = p["test-cli"].steps.map((s) => s.name);
    expect(cli).toEqual(["Unit tests (cli package) [1/3]", "Unit tests (cli package) [2/3]", "Unit tests (cli package) [3/3]", "Unit tests (evals package) [e2e]", "E2E messaging pipeline (real tmux + fake-claude shim) [e2e]"]);
    expect(p["test-cli"].steps[0].argv.at(-1)).toContain("bun test --parallel=4 --bail=5");
    expect(p["test-cli"].steps[3].argv.at(-1)).toBe("bun test --parallel=4 src/");
    expect(p.build.steps.map((s) => s.name)).toEqual(["Build"]);
  });

  test("by default a sharded --parallel suite runs in CI's shard count, each shard on four workers", () => {
    const p = plan(["packages/web/store/inboxStore.ts", "packages/cli/src/daemon.ts"]);
    const web = p["test-web"].steps;
    expect(web.length).toBe(4);
    expect(web.every((s) => s.shard && s.argv.slice(0, 3).join(" ") === "bun test --parallel=4")).toBe(true);
    const cli = p["test-cli"].steps.filter((s) => s.cwd === join(ROOT, "packages/cli"));
    expect(cli.length).toBe(3);
    // Every reached file runs once.
    const files = web.flatMap((s) => s.argv.slice(3));
    expect(new Set(files).size).toBe(files.length);
  });

  test("an unclassified path gates every job on, as CI does", () => {
    const p = plan(["scripts/new-thing.ts"], true);
    // A job on another OS is skipped as not reproducible here, never as ungated.
    for (const job of ["build", "typecheck", "lint", "test-web", "test-cli", "test-electron"]) expect(p[job].skip).toBe(hostMismatch(job) ?? undefined);
  });

  test("every ci.yml job reads locally: no step condition or expression without a local value", () => {
    const jobs = Object.keys(CI_YML.jobs).filter((job) => !["code_paths", "verify", "computer-macos"].includes(job));
    expect(localJobs()).toEqual(jobs);
    const p = plan(["scripts/new-thing.ts"], true);
    for (const job of jobs) if (!hostMismatch(job)) expect(p[job].steps.length).toBeGreaterThan(0);
  });
});

describe("ci.yml's conditions, read for one matrix runner", () => {
  const flags = { run_test_injection: true };
  test.each([
    ["matrix.part != 'e2e'", { part: "1/3" }, true],
    ["matrix.part != 'e2e'", { part: "e2e" }, false],
    ["matrix.shard == 1", { shard: 1 }, true],
    ["matrix.shard == 1", { shard: 2 }, false],
    ["matrix.part == 'e2e' && needs.code_paths.outputs.run_test_injection == 'true'", { part: "e2e" }, true],
    ["github.event_name == 'push' && success()", {}, false],
    ["always() && matrix.part != 'e2e'", { part: "2/3" }, true],
  ])("%s on %p is %p", (cond, matrix, holds) => {
    expect(stepRuns(cond, flags, matrix, "test")).toBe(holds);
  });

  test("an expression it cannot read fails loudly", () => {
    expect(() => stepRuns("contains(github.ref, 'release')", flags, {}, "test")).toThrow("no local reading");
  });

  test("a matrix is one entry per runner: a list's values, or its include rows", () => {
    expect(matrixOf("test-web").map((m) => m.shard)).toEqual([1, 2, 3, 4]);
    expect(matrixOf("test-cli").map((m) => m.part)).toEqual(["1/3", "2/3", "3/3", "e2e"]);
    expect(matrixOf("typecheck").map((m) => m.key)).toEqual(["web", "cli-evals", "convex-sim-playground"]);
    expect(matrixOf("lint")).toEqual([{}]);
  });
});

describe("every ci.yml step a default run leaves out is named", () => {
  test("each step of a reached-test or typecheck job is modeled or dropped with a reason", () => {
    expect(unmodeledSteps()).toEqual([]);
  });

  test("a step ci.yml gains in such a job is caught", () => {
    const grown = structuredClone(CI_YML);
    grown.jobs["test-web"].steps.push({ name: "Bundle size budget", run: "bun run size" });
    grown.jobs.typecheck.steps.push({ name: "Typecheck mobile", run: "bun run typecheck --filter=mobile" });
    expect(unmodeledSteps(grown)).toEqual(["typecheck › Typecheck mobile", "test-web › Bundle size budget"]);
  });

  test("no entry names a step ci.yml no longer has", () => {
    const steps = (job: string) => (CI_YML.jobs[job]?.steps ?? []).map((s: any) => s.name);
    for (const table of [REACHED_STEPS, DEFAULT_DROPS]) for (const [job, named] of Object.entries(table)) for (const name of Object.keys(named)) expect(steps(job)).toContain(name);
    for (const name of CAST_CHECK_REPLACES) expect(steps("typecheck")).toContain(name);
    const all = Object.values<any>(CI_YML.jobs).flatMap((j) => j.steps.map((s: any) => s.name));
    for (const name of Object.keys(RUNNER_SETUP)) expect(all).toContain(name);
  });
});

describe("failures", () => {
  const output = [
    "bun test v1.4.4 (38afee6c8)",
    "",
    "lib/popups.test.ts:",
    "79 |   expect(hits).toEqual([]);",
    "error: expect(received).toEqual(expected)",
    "",
    `      at <anonymous> (${ROOT}/packages/mobile/lib/popups.test.ts:79:18)`,
    "(fail) no screen opens a system alert or action sheet [11.12ms]",
    "",
    " 3 pass",
    " 1 fail",
  ].join("\n");

  test("a red bun test step reads as CI's station reads it, with repo-relative files", () => {
    const [failure, ...rest] = stepFailures("test-mobile", { name: "bun test", cwd: join(ROOT, "packages/mobile") }, output, 1);
    expect(rest).toEqual([]);
    expect(failure).toMatchObject({
      job: "test-mobile",
      test: "no screen opens a system alert or action sheet",
      assertion: "expect(received).toEqual(expected)",
      file: "packages/mobile/lib/popups.test.ts",
      line: 79,
    });
  });

  test("always-run-tests' package groups place each test file header under its package", () => {
    const log = asJobLog({ name: "Always-run tests", cwd: ROOT }, "::group::packages/shared: 4 files\nratchet/maxLines.ratchet.test.ts:\n", 1);
    expect(log).toContain("##[group]packages/shared/ratchet/maxLines.ratchet.test.ts:");
  });

  test("a red step that names no test is still one failure", () => {
    const failures = stepFailures("lint", { name: "Lint", cwd: ROOT }, "something broke", 2);
    expect(failures.length).toBe(1);
    expect(failures[0].excerpt).toContain("something broke");
  });

  test("a type error is the change's, mobile's labeled local only; a project cast check could not check is the station's", () => {
    const { failing, unjudged } = typecheckFailures([
      { project: "web", errors: 0, diagnostics: "\n" },
      { project: "mobile", errors: 1, diagnostics: "../web/components/priorities/parts.tsx(7,18): error TS2307: Cannot find module 'next/link'.\n" },
      { project: "sim", error: "ENOENT: no such file or directory, stat 'capacity.lock'" },
    ]);
    expect(failing).toMatchObject([
      { job: "typecheck", file: "packages/web/components/priorities/parts.tsx", line: 7, test: "local only (CI doesn't typecheck mobile): packages/web/components/priorities/parts.tsx: TS2307 Cannot find module 'next/link'." },
    ]);
    expect(unjudged).toMatchObject([{ job: "ci-station", test: "typecheck: sim", assertion: "ENOENT: no such file or directory, stat 'capacity.lock'" }]);
  });
});

describe("a job this host cannot reproduce", () => {
  test("a job on another OS whose own steps need it is skipped, read from runs-on", () => {
    expect(hostMismatch("test-electron", "darwin")).toBe("CI runs it on ubuntu-latest, not reproducible on darwin");
    expect(hostMismatch("test-electron", "linux")).toBeNull();
  });

  test("a job that only installs a tool on its runner (setup) still runs here", () => {
    expect(hostMismatch("test-always", "darwin")).toBeNull();
    expect(hostMismatch("test-cli", "darwin")).toBeNull();
  });

  test("any OS family and any such step, not one job", () => {
    const workflow = {
      jobs: {
        win: { "runs-on": "windows-latest", steps: [{ name: "Deps", run: "sudo apt-get install -y x" }] },
        mac: { "runs-on": "macos-15", steps: [{ name: "Test", run: "bun test" }] },
      },
    };
    expect(hostMismatch("win", "darwin", workflow)).toBe("CI runs it on windows-latest, not reproducible on darwin");
    expect(hostMismatch("mac", "linux", workflow)).toBeNull();
  });

  test.skipIf(process.platform === "linux")("the plan skips it, so it is neither a failure nor no verdict", () => {
    const p = plan(["packages/electron/main.js"]);
    expect(p["test-electron"]).toMatchObject({ skip: `CI runs it on ubuntu-latest, not reproducible on ${process.platform}`, steps: [] });
  });
});

describe("a runner's environment", () => {
  test("a PATH directory holding an agent client is replaced by one holding everything else", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-local-test-"));
    const [tools, plain] = [join(root, "tools"), join(root, "plain")];
    for (const dir of [tools, plain]) mkdirSync(dir);
    for (const name of ["claude", "codex", "cast"]) writeFileSync(join(tools, name), "");
    writeFileSync(join(plain, "tmux"), "");
    const [shadow, kept] = withoutAgentClients(`${tools}:${plain}:/no/such/dir`, join(root, "path")).split(":");
    expect(kept).toBe(plain);
    expect(existsSync(join(shadow, "cast"))).toBe(true);
    expect(existsSync(join(shadow, "claude")) || existsSync(join(shadow, "codex"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("a step's environment drops what an agent session set and gives tmux the run's own directory", () => {
    const run = mkdtempSync(join(tmpdir(), "ci-local-test-"));
    const env = runnerEnv({ HOME: "/h", PATH: "/no/such/dir", CODECAST_LAUNCH_TOKEN: "t", CLAUDE_CODE_SESSION_ID: "s", TMUX: "/tmp/x", TMUX_TMPDIR: "/tmp" }, run);
    expect(env).toEqual({ HOME: "/h", PATH: "/no/such/dir", CI: "true", TMUX_TMPDIR: join(run, "tmux") });
    rmSync(run, { recursive: true, force: true });
  });

  // Never against the person's own server: both servers here live in temporary directories.
  test.skipIf(!Bun.which("tmux"))("a bare `tmux kill-server` in a step reaches the run's server and no other; the sweep kills the run's", () => {
    const root = mkdtempSync("/tmp/cl-");
    const person = { PATH: process.env.PATH, TMUX_TMPDIR: join(root, "person") };
    mkdirSync(person.TMUX_TMPDIR, { mode: 0o700 });
    const step = runnerEnv({ PATH: process.env.PATH }, join(root, "run"));
    const tmux = (env: Record<string, string | undefined>, ...args: string[]) => Bun.spawnSync(["tmux", ...args], { env, stdout: "ignore", stderr: "ignore" }).exitCode;
    try {
      expect(tmux(person, "new-session", "-d", "-s", "p", "sleep 30")).toBe(0);
      expect(tmux(step, "new-session", "-d", "-s", "r", "sleep 30")).toBe(0);
      expect(tmux(step, "kill-server")).toBe(0);
      expect(tmux(step, "has-session", "-t", "r")).not.toBe(0);
      expect(tmux(person, "has-session", "-t", "p")).toBe(0);
      expect(tmux(step, "new-session", "-d", "-s", "r2", "sleep 30")).toBe(0);
      expect(sweepTmux(step.TMUX_TMPDIR!, new Set(), step)).toBeGreaterThan(0);
      expect(tmux(step, "has-session", "-t", "r2")).not.toBe(0);
      expect(tmux(person, "has-session", "-t", "p")).toBe(0);
    } finally {
      tmux(person, "kill-server");
      tmux(step, "kill-server");
      rmSync(root, { recursive: true, force: true });
    }
  });
});
