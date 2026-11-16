// Pins .github/workflows/ci.yml against the classifier it gates on. A gate and
// its verify assertion live in two places by necessity — GitHub evaluates `if`
// before a job starts and `needs.<job>.result` only after — so nothing but this
// test stops them drifting apart and quietly turning a skipped job into a pass
// (ct-49562).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { AREAS, ADVISORY_JOBS, GATED_JOBS, jobFlag } from "./changed-path-scope";

const WORKFLOW_PATH = new URL("../../.github/workflows/ci.yml", import.meta.url);
// Bun's YAML parser: no dependency, and the same runtime CI pins.
const workflow = Bun.YAML.parse(await Bun.file(WORKFLOW_PATH).text()) as {
  jobs: Record<string, any>;
};

const jobs = workflow.jobs;

const SETUP_BUN = "./.github/actions/setup-bun";
const SETUP_DEPS = ["install", "cache", "none"];
const setupBun = Bun.YAML.parse(
  await Bun.file(new URL("../../.github/actions/setup-bun/action.yml", import.meta.url)).text(),
) as { inputs: Record<string, any>; runs: { using: string; steps: any[] } };
/** The verify env var carrying a job's result. */
const envVar = (job: string) => job.replace(/-/g, "_").toUpperCase();

const verifyJob = jobs.verify;
const assertRun: string = verifyJob.steps[0].run;

describe("ci.yml job graph", () => {
  test("holds exactly the classifier, the contract, the always-run tests, the gated jobs, the advisory jobs and verify", () => {
    expect(Object.keys(jobs)).toEqual([
      "code_paths",
      "ci-contract",
      "test-always",
      ...GATED_JOBS,
      ...ADVISORY_JOBS,
      "verify",
    ]);
  });

  test("every job declares a timeout", () => {
    for (const [name, job] of Object.entries(jobs)) {
      expect(typeof job["timeout-minutes"], `${name} timeout-minutes`).toBe("number");
    }
  });

  // Bun, its install cache and the workspace install come from one composite
  // action, so the version and the cache key live in one file and a bump
  // touches nothing else.
  test("every job sets bun up through the one composite action", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const steps: any[] = job.steps ?? [];
      for (const step of steps) {
        const uses = String(step.uses ?? "");
        expect(uses.startsWith("oven-sh/setup-bun@"), `${name} uses setup-bun directly`).toBe(false);
        expect(uses.startsWith("actions/cache@"), `${name} caches the bun store itself`).toBe(false);
        expect(step.run, `${name} runs the root install itself`).not.toBe("bun install");
      }
      if (!steps.some((step) => /\bbun\b/.test(String(step.run ?? "")))) continue;
      const setup = steps.findIndex((step) => step.uses === SETUP_BUN);
      expect(setup, `${name} sets up bun`).toBeGreaterThan(-1);
      expect(SETUP_DEPS, `${name} deps`).toContain(steps[setup].with?.deps ?? "install");
      expect(String(steps[setup].with?.["bun-version"] ?? "0.0.0"), `${name} bun-version`).toMatch(/^\d+\.\d+\.\d+$/);
      const firstBun = steps.findIndex((step) => /\bbun\b/.test(String(step.run ?? "")));
      expect(setup, `${name} sets up bun before its first bun step`).toBeLessThan(firstBun);
    }
  });

  // The release workflows build with the same bun as CI; a pin of their own
  // is how the two drift apart.
  test("the release workflows set bun up through the same composite action", () => {
    for (const file of ["cut-cli-release", "finalize-cli-release", "cut-extension-release"]) {
      const release = Bun.YAML.parse(
        readFileSync(new URL(`../../.github/workflows/${file}.yml`, import.meta.url), "utf8"),
      ) as { jobs: Record<string, any> };
      for (const [name, job] of Object.entries(release.jobs)) {
        const steps: any[] = job.steps ?? [];
        for (const step of steps) {
          expect(String(step.uses ?? "").startsWith("oven-sh/setup-bun@"), `${file} ${name} uses setup-bun directly`).toBe(false);
          expect(step.with?.["bun-version"], `${file} ${name} pins its own bun`).toBeUndefined();
        }
        const firstBun = steps.findIndex((step) => /\bbun\b/.test(String(step.run ?? "")));
        if (firstBun < 0) continue;
        const setup = steps.findIndex((step) => step.uses === SETUP_BUN);
        expect(setup, `${file} ${name} sets up bun`).toBeGreaterThan(-1);
        expect(setup, `${file} ${name} sets up bun before its first bun step`).toBeLessThan(firstBun);
      }
    }
  });

  test("the composite action caches the bun store and installs only after", () => {
    const steps: any[] = setupBun.runs.steps;
    expect(setupBun.runs.using).toBe("composite");
    expect(Object.keys(setupBun.inputs)).toEqual(["deps", "bun-version"]);
    expect(setupBun.inputs.deps.default).toBe("install");
    expect(String(setupBun.inputs["bun-version"].default)).toMatch(/^\d+\.\d+\.\d+$/);
    const bun = steps.findIndex((step) => String(step.uses ?? "").startsWith("oven-sh/setup-bun@"));
    const cache = steps.findIndex((step) => String(step.uses ?? "").startsWith("actions/cache@"));
    const install = steps.findIndex((step) => step.run === "bun install");
    expect(bun).toBe(0);
    expect(steps[bun].with["bun-version"]).toBe("${{ inputs.bun-version }}");
    expect(cache).toBeGreaterThan(bun);
    expect(steps[cache].if).toBe("inputs.deps != 'none'");
    expect(steps[cache].with.path).toBe("~/.bun/install/cache");
    expect(steps[cache].with.key).toBe("bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}");
    expect(install).toBeGreaterThan(cache);
    expect(steps[install].if).toBe("inputs.deps == 'install'");
  });
});

describe("code_paths", () => {
  const diffStep = jobs.code_paths.steps.find((step: any) => step.id === "diff");

  test("lists changed paths once, from a full but blobless history", () => {
    const checkout = jobs.code_paths.steps.find((step: any) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );
    expect(checkout.with["fetch-depth"]).toBe(0);
    expect(checkout.with.filter).toBe("blob:none");

    expect(diffStep.env).toEqual({
      EVENT_NAME: "${{ github.event_name }}",
      PR_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      PR_HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      PUSH_BEFORE_SHA: "${{ github.event.before }}",
      PUSH_SHA: "${{ github.sha }}",
    });
    expect(diffStep.run).toContain("--no-renames");
    expect(diffStep.run).not.toContain("set -e");
    for (const id of ["scope", "computer_scope", "injection_scope"]) {
      const classify = jobs.code_paths.steps.find((step: any) => step.id === id);
      expect(classify.run, id).toContain('bun scripts/ci/changed-path-scope.ts');
      expect(classify.run, id).toContain('< "${{ steps.diff.outputs.list }}"');
      expect(classify.run, id).toContain('tee -a "$GITHUB_OUTPUT"');
    }
  });

  // Run the diff step's shell against a scratch repository the way GitHub runs
  // it, for each event shape, and read back the list it hands the classifiers.
  describe("diff step", () => {
    const git = (cwd: string, ...args: string[]) => {
      const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr}`);
      return proc.stdout.toString().trim();
    };
    const scratch = mkdtempSync(join(tmpdir(), "ci-diff-"));
    afterAll(() => rmSync(scratch, { recursive: true, force: true }));
    const repo = join(scratch, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "ci@example.com");
    git(repo, "config", "user.name", "ci");
    const commit = (file: string) => {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), Bun.randomUUIDv7());
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", file);
      return git(repo, "rev-parse", "HEAD");
    };
    const first = commit("README.md");
    const web = commit("packages/web/a.ts");
    git(repo, "checkout", "-q", "-b", "feature", first);
    const cli = commit("packages/cli/b.ts");
    git(repo, "checkout", "-q", "main");
    const docs = commit("docs/c.md");

    const run = (env: Record<string, string>) => {
      const temp = mkdtempSync(join(scratch, "runner-"));
      const output = join(temp, "output");
      writeFileSync(output, "");
      const proc = Bun.spawnSync(["bash", "-e", "-c", diffStep.run], {
        cwd: repo,
        env: { PATH: Bun.env.PATH!, RUNNER_TEMP: temp, GITHUB_OUTPUT: output, EVENT_NAME: "", PR_BASE_SHA: "", PR_HEAD_SHA: "", PUSH_BEFORE_SHA: "", PUSH_SHA: "", ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
      const list = readFileSync(output, "utf8").match(/^list=(.*)$/m)![1];
      return readFileSync(list, "utf8").split("\n").filter(Boolean);
    };

    test("a pull request diffs its head against the merge base", () => {
      expect(run({ EVENT_NAME: "pull_request", PR_BASE_SHA: docs, PR_HEAD_SHA: cli })).toEqual(["packages/cli/b.ts"]);
    });

    test("a push diffs against the commit main pointed at before it", () => {
      expect(run({ EVENT_NAME: "push", PUSH_BEFORE_SHA: web, PUSH_SHA: docs })).toEqual(["docs/c.md"]);
      expect(run({ EVENT_NAME: "push", PUSH_BEFORE_SHA: first, PUSH_SHA: docs })).toEqual(["docs/c.md", "packages/web/a.ts"]);
    });

    test("no usable base leaves the list empty, which runs every job", () => {
      const zeros = "0000000000000000000000000000000000000000";
      expect(run({ EVENT_NAME: "push", PUSH_BEFORE_SHA: zeros, PUSH_SHA: docs })).toEqual([]);
      expect(run({ EVENT_NAME: "push", PUSH_BEFORE_SHA: "1234567890123456789012345678901234567890", PUSH_SHA: docs })).toEqual([]);
      expect(run({ EVENT_NAME: "push", PUSH_SHA: docs })).toEqual([]);
      expect(run({ EVENT_NAME: "workflow_dispatch", PUSH_SHA: docs })).toEqual([]);
      expect(run({ EVENT_NAME: "pull_request", PR_BASE_SHA: "1234567890123456789012345678901234567890", PR_HEAD_SHA: cli })).toEqual([]);
    });
  });

  test("publishes every area and every job gate the classifier emits", () => {
    const expected = [...AREAS, ...GATED_JOBS.map(jobFlag)];
    const STEP_FLAGS = ["run_test_computer", "run_test_injection"];
    expect(Object.keys(jobs.code_paths.outputs).filter((name) => !STEP_FLAGS.includes(name))).toEqual(expected);
    for (const name of expected) {
      expect(jobs.code_paths.outputs[name]).toBe(`\${{ steps.scope.outputs.${name} }}`);
    }
  });
});

// Every program `cast check` verifies locally has to be typechecked in CI too,
// or it drifts red unnoticed (bun test strips types). A program counts when one
// of the packages the typecheck job filters to runs it from its own script.
describe("typecheck", () => {
  // A known gap, not a second toolchain: packages/mobile has no `typecheck`
  // script, so nothing in CI typechecks it. `cast check mobile` is its only
  // check. Drop it from this list when the package gains the script and the
  // job's filter gains the package.
  const NOT_IN_TYPECHECK_JOB = ["mobile"];
  const checkToml = Bun.TOML.parse(
    readFileSync(new URL("../../.codecast/check.toml", import.meta.url), "utf8"),
  ) as { projects: Record<string, string> };
  const typecheckRun: string = jobs.typecheck.steps.find((step: any) =>
    String(step.run ?? "").startsWith("bun run typecheck"),
  ).run;

  test("covers every program in .codecast/check.toml", () => {
    for (const [name, tsconfig] of Object.entries(checkToml.projects)) {
      if (NOT_IN_TYPECHECK_JOB.includes(name)) continue;
      const pkgDir = tsconfig.split("/").slice(0, 2).join("/");
      const pkg = JSON.parse(readFileSync(new URL(`../../${pkgDir}/package.json`, import.meta.url), "utf8"));
      expect(typecheckRun, `${name}: ${pkg.name} filtered`).toContain(`--filter=${pkg.name}`);
      const rel = tsconfig.slice(pkgDir.length + 1);
      const script: string = pkg.scripts?.typecheck ?? "";
      const runsIt = script.includes(`-p ${rel}`) || (rel === "tsconfig.json" && /tsc --noEmit(?! -p)/.test(script));
      expect(runsIt, `${name}: ${pkg.name} typecheck script runs ${rel}`).toBe(true);
    }
  });
});

describe("gates", () => {
  test("each gated job waits for code_paths and reads its own flag", () => {
    for (const job of GATED_JOBS) {
      expect(jobs[job].needs, `${job} needs`).toEqual(["code_paths"]);
      expect(jobs[job].if, `${job} if`).toBe(
        `needs.code_paths.outputs.${jobFlag(job)} == 'true'`,
      );
    }
  });

  // continue-on-error on a gated job, or on any of its steps, turns a red
  // suite into a job that concludes "success", and verify passes it.
  test("no gated job, and no step of one, may continue on error", () => {
    for (const job of GATED_JOBS) {
      expect(jobs[job]["continue-on-error"], `${job} continue-on-error`).toBeUndefined();
      for (const [i, step] of (jobs[job].steps ?? []).entries()) {
        expect(step["continue-on-error"], `${job} step ${i} (${step.name ?? step.uses}) continue-on-error`).toBeUndefined();
      }
    }
  });

  test("the classifier, the contract test and the always-run tests are never gated", () => {
    expect(jobs.code_paths.if).toBeUndefined();
    expect(jobs.code_paths.needs).toBeUndefined();
    expect(jobs["test-always"].if).toBeUndefined();
    expect(jobs["test-always"].needs).toBeUndefined();
    expect(jobs["test-always"]["continue-on-error"]).toBeUndefined();
    expect(
      jobs["test-always"].steps.some((step: any) => step.run === "bun scripts/ci/always-run-tests.ts"),
    ).toBe(true);
    expect(jobs["ci-contract"].if).toBeUndefined();
    expect(jobs["ci-contract"].needs).toBeUndefined();
    expect(
      jobs["ci-contract"].steps.some((step: any) => step.run === "bun test scripts/ci/"),
    ).toBe(true);
  });
});


// An advisory job reports; it never gates. Two properties make that true, and
// losing either one turns a lane nobody trusts yet into a merge blocker or,
// worse, into a green that means nothing (ct-49523).
describe("advisory jobs", () => {
  test("carry continue-on-error, so a red one cannot fail the run", () => {
    for (const job of ADVISORY_JOBS) {
      expect(jobs[job]["continue-on-error"], `${job} continue-on-error`).toBe(true);
    }
  });

  test("are absent from verify, so they can never gate a merge", () => {
    for (const job of ADVISORY_JOBS) {
      expect(verifyJob.needs, `${job} in verify.needs`).not.toContain(job);
      expect(assertRun, `${job} asserted in verify`).not.toContain(job);
    }
  });

  test("wait for the classifier and read a flag it publishes", () => {
    for (const job of ADVISORY_JOBS) {
      expect(jobs[job].needs, `${job} needs`).toEqual(["code_paths"]);
      const gate = String(jobs[job].if ?? "");
      expect(gate, `${job} if`).toMatch(/^needs\.code_paths\.outputs\.(\w+) == 'true'$/);
      expect(Object.keys(jobs.code_paths.outputs)).toContain(gate.match(/outputs\.(\w+)/)![1]);
    }
  });

  test("run somewhere the ubuntu lanes cannot", () => {
    // The only reason to add an advisory lane at all is work the required jobs
    // cannot do. A second ubuntu-latest job would just be an untrusted copy.
    for (const job of ADVISORY_JOBS) {
      expect(jobs[job]["runs-on"], `${job} runs-on`).not.toBe("ubuntu-latest");
    }
  });
});

describe("verify", () => {
  const verify = verifyJob;
  const assertStep = verify.steps[0];

  test("runs whatever the gates did, and needs every other job", () => {
    expect(verify.if).toBe("always()");
    expect(verify.needs).toEqual([
      "code_paths",
      "ci-contract",
      "test-always",
      ...GATED_JOBS,
    ]);
    // Every job is either required by verify or declared advisory. A new job
    // that is neither would run without anything checking its result.
    expect(Object.keys(jobs)).toEqual([...verify.needs, ...ADVISORY_JOBS, "verify"]);
  });

  test("fails when the ungated jobs did not succeed", () => {
    expect(assertStep.env.CODE_PATHS).toBe("${{ needs.code_paths.result }}");
    expect(assertStep.env.CI_CONTRACT).toBe("${{ needs.ci-contract.result }}");
    expect(assertStep.run).toContain('if [ "$CODE_PATHS" != "success" ]; then');
    expect(assertStep.run).toContain('if [ "$CI_CONTRACT" != "success" ]; then');
    expect(assertStep.env.TEST_ALWAYS).toBe("${{ needs.test-always.result }}");
    expect(assertStep.run).toContain('if [ "$TEST_ALWAYS" != "success" ]; then');
  });

  test("pairs every gated job's result with the flag that gated it", () => {
    for (const job of GATED_JOBS) {
      const name = envVar(job);
      expect(assertStep.env[name], `${job} result`).toBe(`\${{ needs.${job}.result }}`);
      expect(assertStep.env[`${name}_SHOULD_RUN`], `${job} gate`).toBe(
        `\${{ needs.code_paths.outputs.${jobFlag(job)} }}`,
      );
      expect(assertStep.run).toContain(`check_job ${job} "$${name}" "$${name}_SHOULD_RUN"`);
    }
  });

  // Run the aggregate's own shell the way GitHub runs it (`bash -e`), so the
  // assertions are proven rather than pattern-matched.
  const runVerify = async (results: Record<string, string>, gates: Record<string, string>) => {
    const script = `${Bun.env.TMPDIR ?? "/tmp"}/ci-verify-${Bun.randomUUIDv7()}.sh`;
    await Bun.write(script, assertStep.run);
    const env: Record<string, string> = {
      CODE_PATHS: "success",
      CI_CONTRACT: "success",
      TEST_ALWAYS: "success",
      ...Object.fromEntries(GATED_JOBS.map((job) => [envVar(job), "skipped"])),
      ...Object.fromEntries(GATED_JOBS.map((job) => [`${envVar(job)}_SHOULD_RUN`, "false"])),
      ...results,
      ...Object.fromEntries(Object.entries(gates).map(([k, v]) => [`${k}_SHOULD_RUN`, v])),
    };
    const proc = Bun.spawn(["bash", "-e", script], { env, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    return { code: await proc.exited, stdout };
  };

  test("passes when every job matched its gate", async () => {
    const run = await runVerify({ BUILD: "success", TEST_CLI: "success" }, {
      BUILD: "true",
      TEST_CLI: "true",
    });
    expect(run.code).toBe(0);
  });

  test("passes a docs-only run where every gated job skipped", async () => {
    expect((await runVerify({}, {})).code).toBe(0);
  });

  test("fails a gated-in job that did not succeed", async () => {
    for (const result of ["failure", "cancelled", "skipped"]) {
      const run = await runVerify({ BUILD: result }, { BUILD: "true" });
      expect(run.code, `build ${result}`).toBe(1);
      expect(run.stdout).toContain(`build: expected success, got ${result}`);
    }
  });

  test("fails a gated-out job that ran anyway", async () => {
    // The filter is a claim about what the change touched. A job running
    // outside its gate means the classifier and the workflow disagree.
    const run = await runVerify({ LINT: "success" }, { LINT: "false" });
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("lint: expected skipped, got success");
  });

  test("fails when the classifier or the contract test did not succeed", async () => {
    expect((await runVerify({ CODE_PATHS: "failure" }, {})).code).toBe(1);
    expect((await runVerify({ CI_CONTRACT: "failure" }, {})).code).toBe(1);
    expect((await runVerify({ CODE_PATHS: "skipped" }, {})).code).toBe(1);
    expect((await runVerify({ TEST_ALWAYS: "failure" }, {})).code).toBe(1);
  });
});

// A cli case that skips anywhere but darwin passes on every ubuntu lane without
// asserting anything, so it runs only where the macOS lane names its file. The
// list is written by hand in ci.yml; this finds the files by their skip so a
// new one cannot be left off it.
describe("darwin-only cli tests", () => {
  const CLI_SRC = new URL("../../packages/cli/src/", import.meta.url);
  const NOT_DARWIN = String.raw`process\.platform\s*!==?\s*["']darwin["']`;
  const IS_DARWIN = String.raw`process\.platform\s*===?\s*["']darwin["']`;
  const SKIPS_OFF_DARWIN = [
    new RegExp(String.raw`\.skipIf\(.*${NOT_DARWIN}`),
    new RegExp(String.raw`\.(if|runIf)\(\s*${IS_DARWIN}\s*\)`),
    new RegExp(String.raw`\bif\s*\(\s*${NOT_DARWIN}\s*\)\s*return\b`),
  ];
  const step = (jobs["computer-macos"].steps as any[]).find((s) =>
    String(s.name ?? "").startsWith("Unit and e2e tests (cli files that only run on darwin)"),
  );
  const listed: string[] = String(step?.run ?? "").split(/\s+/).filter((t) => t.startsWith("src/"));

  test("every cli file with a darwin-only case runs on the macOS lane", () => {
    const darwinOnly = (readdirSync(CLI_SRC, { recursive: true }) as string[])
      .filter((f) => /\.test\.tsx?$/.test(f) && !f.startsWith("computer/"))
      .filter((f) => SKIPS_OFF_DARWIN.some((re) => re.test(readFileSync(new URL(f, CLI_SRC), "utf8"))))
      .map((f) => `src/${f}`)
      .sort();
    expect(listed).toEqual(darwinOnly);
  });
});


// The injection suites are a step of test-cli that runs only for a change to
// the injection path. The flag comes from code_paths, whose diff covers every
// commit of a push; a diff of the last commit alone skipped the suites for an
// injection change earlier in a multi-commit push.
describe("injection suites", () => {
  test("gate on the classifier's flag, not on a diff of their own", () => {
    expect(jobs.code_paths.outputs.run_test_injection).toBe("${{ steps.injection_scope.outputs.run_test_injection }}");
    const classify = jobs.code_paths.steps.find((step: any) => step.id === "injection_scope");
    expect(classify.run).toContain("--injection-only");
    const steps: any[] = jobs["test-cli"].steps;
    const suites = steps.find((step) => String(step.name ?? "").startsWith("Injection suites"));
    expect(suites.if).toBe("needs.code_paths.outputs.run_test_injection == 'true'");
    for (const step of steps) expect(String(step.run ?? ""), step.name).not.toContain("git diff");
  });
});

// Tests under scripts/ and infra/ belong to no package job.
describe("tests outside packages/", () => {
  test("run in test-always", () => {
    const step = (jobs["test-always"].steps as any[]).find((s) => String(s.name ?? "").startsWith("Tests outside packages/"));
    for (const file of ["./scripts/line.test.ts", "./infra/artifact-edge/worker.test.js", "./infra/replay-player/src/clock.test.ts", "infra/call-face-worker/turns.test.mjs"]) {
      expect(step.run, file).toContain(file);
      expect(Bun.file(new URL(`../../${file.replace(/^\.\//, "")}`, import.meta.url)).size, file).toBeGreaterThan(0);
    }
  });
});

describe("workflow concurrency", () => {
  test("a pull request's newer run cancels the older one, and a push to main keeps its own", () => {
    const top = workflow as any;
    expect(top.concurrency.group).toBe("ci-${{ github.event.pull_request.number || github.sha }}");
    expect(top.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
  });
});

describe("computer tests are opt-in", () => {
  test("the default CLI suite excludes computer tests and the dedicated command restores them", () => {
    const config = Bun.TOML.parse(readFileSync(new URL("../../packages/cli/bunfig.toml", import.meta.url), "utf8")) as any;
    const pkg = JSON.parse(readFileSync(new URL("../../packages/cli/package.json", import.meta.url), "utf8"));
    expect(config.test.pathIgnorePatterns).toContain("**/src/computer/**");
    expect(pkg.scripts["test:computer"]).toBe("bun test ./src/computer/ --isolate --path-ignore-patterns=''");
  });

  test("only computer changes build and exercise the helper in CI", () => {
    expect(jobs.code_paths.outputs.run_test_computer).toBe("${{ steps.computer_scope.outputs.run_test_computer }}");
    // Reads the same changed-path list as the scope step (see "diff step"
    // above), where a missing base yields an empty list the classifier runs on.
    const classify = jobs.code_paths.steps.find((step: any) => step.id === "computer_scope");
    expect(classify.run).toContain("--computer-only");
    expect(classify.run).toContain('< "${{ steps.diff.outputs.list }}"');
    for (const name of ["Swift unit tests (helper core)", "Build and sign the computer helper", "Unit and e2e tests (cast computer, ungranted half)"]) {
      const step = jobs["computer-macos"].steps.find((step: any) => step.name === name);
      expect(step.if).toBe("needs.code_paths.outputs.run_test_computer == 'true'");
    }
  });
});
