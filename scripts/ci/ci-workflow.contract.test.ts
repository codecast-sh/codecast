// Pins .github/workflows/ci.yml against the classifier it gates on. A gate and
// its verify assertion live in two places by necessity — GitHub evaluates `if`
// before a job starts and `needs.<job>.result` only after — so nothing but this
// test stops them drifting apart and quietly turning a skipped job into a pass
// (ct-49562).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

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
  test("holds exactly the classifier, the contract, the gated jobs, the advisory jobs and verify", () => {
    expect(Object.keys(jobs)).toEqual([
      "code_paths",
      "ci-contract",
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
      const firstBun = steps.findIndex((step) => /\bbun\b/.test(String(step.run ?? "")));
      expect(setup, `${name} sets up bun before its first bun step`).toBeLessThan(firstBun);
    }
  });

  test("the composite action caches the bun store and installs only after", () => {
    const steps: any[] = setupBun.runs.steps;
    expect(setupBun.runs.using).toBe("composite");
    expect(Object.keys(setupBun.inputs)).toEqual(["deps"]);
    expect(setupBun.inputs.deps.default).toBe("install");
    const bun = steps.findIndex((step) => String(step.uses ?? "").startsWith("oven-sh/setup-bun@"));
    const cache = steps.findIndex((step) => String(step.uses ?? "").startsWith("actions/cache@"));
    const install = steps.findIndex((step) => step.run === "bun install");
    expect(bun).toBe(0);
    expect(steps[bun].with["bun-version"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cache).toBeGreaterThan(bun);
    expect(steps[cache].if).toBe("inputs.deps != 'none'");
    expect(steps[cache].with.path).toBe("~/.bun/install/cache");
    expect(steps[cache].with.key).toBe("bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}");
    expect(install).toBeGreaterThan(cache);
    expect(steps[install].if).toBe("inputs.deps == 'install'");
  });
});

describe("code_paths", () => {
  test("diffs against the merge base from a full but blobless history", () => {
    const checkout = jobs.code_paths.steps.find((step: any) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );
    expect(checkout.with["fetch-depth"]).toBe(0);
    expect(checkout.with.filter).toBe("blob:none");

    const classify = jobs.code_paths.steps.find((step: any) => step.id === "scope");
    expect(classify.env.BASE_SHA).toBe("${{ github.event.pull_request.base.sha }}");
    expect(classify.env.HEAD_SHA).toBe("${{ github.event.pull_request.head.sha }}");
    expect(classify.run).toContain("--merge-base");
    expect(classify.run).toContain("--no-renames");
    expect(classify.run).toContain("bun scripts/ci/changed-path-scope.ts");
    expect(classify.run).toContain('tee -a "$GITHUB_OUTPUT"');
  });

  test("publishes every area and every job gate the classifier emits", () => {
    const expected = [...AREAS, ...GATED_JOBS.map(jobFlag)];
    expect(Object.keys(jobs.code_paths.outputs)).toEqual(expected);
    for (const name of expected) {
      expect(jobs.code_paths.outputs[name]).toBe(`\${{ steps.scope.outputs.${name} }}`);
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

  test("the classifier and the contract test are never gated", () => {
    expect(jobs.code_paths.if).toBeUndefined();
    expect(jobs.code_paths.needs).toBeUndefined();
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

