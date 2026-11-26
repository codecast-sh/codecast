import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asJobLog, ciSteps, planJobs, runnerEnv, scopeFlags, selectTests, stepFailures, walksOwnTree, withoutAgentClients } from "./local";

const ROOT = join(import.meta.dir, "..", "..");
const plan = (changed: string[], full = false) =>
  Object.fromEntries(planJobs(changed, { base: "BASE", full, temp: "/tmp/x" }).map((p) => [p.job, p]));
const argvs = (p: { steps: Array<{ argv: string[] }> }) => p.steps.map((s) => s.argv);

describe("selectTests", () => {
  // Each test's imports with their distance. deep.ts sits two imports under a.test.ts.
  const graph: Record<string, Record<string, number>> = {
    "packages/web/a.test.ts": { "packages/web/a.test.ts": 0, "packages/web/a.ts": 1, "packages/web/deep.ts": 2 },
    "packages/web/b.test.ts": { "packages/web/b.test.ts": 0, "packages/web/b.ts": 1 },
    "packages/web/scan.test.ts": { "packages/web/scan.test.ts": 0 },
    "packages/mobile/scan.test.ts": { "packages/mobile/scan.test.ts": 0 },
  };
  const walks = (t: string) => t.endsWith("scan.test.ts");
  const select = (g: typeof graph, changed: string[]) => selectTests(Object.keys(g), changed, (t) => new Map(Object.entries(g[t])), walks);
  const pick = (changed: string[]) => select(graph, changed);

  test("a test runs when something it imports changed, through any number of files", () => {
    expect(pick(["packages/web/deep.ts"])).toEqual(["packages/web/a.test.ts", "packages/web/scan.test.ts"]);
    expect(pick(["packages/web/b.ts"])).toEqual(["packages/web/b.test.ts", "packages/web/scan.test.ts"]);
  });

  test("a changed hub runs only the tests that import it directly", () => {
    // hub.ts: a.test.ts imports it, the other ten reach it two imports down.
    const many: typeof graph = { "packages/web/a.test.ts": { "packages/web/a.test.ts": 0, "packages/web/hub.ts": 1 } };
    for (let i = 0; i < 10; i++) many[`packages/web/t${i}.test.ts`] = { [`packages/web/t${i}.test.ts`]: 0, "packages/web/mid.ts": 1, "packages/web/hub.ts": 2 };
    expect(select(many, ["packages/web/hub.ts"])).toEqual(["packages/web/a.test.ts"]);
    // mid.ts is a hub too, and all ten import it directly.
    expect(select(many, ["packages/web/hub.ts", "packages/web/mid.ts"]).length).toBe(11);
  });

  test("a changed test runs itself", () => {
    expect(pick(["packages/mobile/scan.test.ts"])).toEqual(["packages/mobile/scan.test.ts"]);
  });

  test("a test that scans its package runs on any change in that package, and only that package", () => {
    expect(pick(["packages/mobile/app/screen.tsx"])).toEqual(["packages/mobile/scan.test.ts"]);
    expect(pick(["docs/x.md"])).toEqual([]);
  });

  test("a source scan is a directory walk from the file's own place", () => {
    expect(walksOwnTree(`const root = path.resolve(import.meta.dir, ".."); fs.readdirSync(root)`)).toBe(true);
    expect(walksOwnTree(`fs.readdirSync(mkdtempSync(join(tmpdir(), "x")))`)).toBe(false);
    expect(walksOwnTree(`readFileSync(join(import.meta.dir, "golden.json"))`)).toBe(false);
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

  test("by default typecheck asks cast check about the change and build waits for --full", () => {
    const p = plan(["packages/cli/src/index.ts"]);
    expect(argvs(p.typecheck)).toEqual([["cast", "check", "--changed-since", "BASE"]]);
    expect(p.build.skip).toBe("--full only");
    expect(p["test-cli"].steps.every((s) => s.argv.includes("--parallel"))).toBe(true);
  });

  test("--full runs each gated job's ci.yml steps, typecheck still through cast check", () => {
    const p = plan(["packages/web/lib/x.ts"], true);
    expect(argvs(p.typecheck)).toEqual([["cast", "check", "cli", "web", "sim", "convex", "evals", "playground"]]);
    const web = p["test-web"].steps;
    expect(web.map((s) => s.name)).toEqual(["Unit tests (web package)", "Perf budgets (web)"]);
    expect(web[0].argv.at(-1)).toContain("bun test --isolate --shard=$shard/4");
    expect(web[0].cwd).toBe(join(ROOT, "packages/web"));
    expect(web[0].env?.SIM_OUT).toBe("/tmp/x/sim");
    expect(p.build.steps.map((s) => s.name)).toEqual(["Build"]);
  });

  test("an unclassified path gates every job on, as CI does", () => {
    const p = plan(["scripts/new-thing.ts"], true);
    for (const job of ["build", "typecheck", "lint", "test-web", "test-cli", "test-electron"]) expect(p[job].skip).toBeUndefined();
  });

  test("every ci.yml job reads locally: no step condition or expression without a local value", () => {
    const flags = scopeFlags([]);
    for (const job of ["ci-contract", "test-always", "build", "lint", "test-convex", "test-web", "test-cli", "test-platform", "test-shared", "test-mobile", "test-electron"]) {
      expect(ciSteps(job, flags, "/tmp/x").length).toBeGreaterThan(0);
    }
  });
});

describe("failures", () => {
  const output = [
    "bun test v1.3.14 (0d9b296a)",
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
});

describe("withoutAgentClients", () => {
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
});

test("a step's environment drops what an agent session set, as a runner has none of it", () => {
  const env = runnerEnv({ HOME: "/h", PATH: "/no/such/dir", CODECAST_LAUNCH_TOKEN: "t", CLAUDE_CODE_SESSION_ID: "s", TMUX: "/tmp/x" }, "/tmp/unused");
  expect(env).toEqual({ HOME: "/h", PATH: "/no/such/dir", CI: "true" });
});
