// Pins .github/workflows/ci.yml against the classifier it gates on. A gate and
// its verify assertion live in two places by necessity — GitHub evaluates `if`
// before a job starts and `needs.<job>.result` only after — so nothing but this
// test stops them drifting apart and quietly turning a skipped job into a pass
// (ct-49562).
import { describe, expect, test } from "bun:test";

import { AREAS, GATED_JOBS, jobFlag } from "./changed-path-scope";

const WORKFLOW_PATH = new URL("../../.github/workflows/ci.yml", import.meta.url);
// Bun's YAML parser: no dependency, and the same runtime CI pins.
const workflow = Bun.YAML.parse(await Bun.file(WORKFLOW_PATH).text()) as {
  jobs: Record<string, any>;
};

const jobs = workflow.jobs;
/** The verify env var carrying a job's result. */
const envVar = (job: string) => job.replace(/-/g, "_").toUpperCase();

describe("ci.yml job graph", () => {
  test("holds exactly the classifier, the contract, the gated jobs and verify", () => {
    expect(Object.keys(jobs)).toEqual([
      "code_paths",
      "ci-contract",
      ...GATED_JOBS,
      "verify",
    ]);
  });

  test("every job declares a timeout", () => {
    for (const [name, job] of Object.entries(jobs)) {
      expect(typeof job["timeout-minutes"], `${name} timeout-minutes`).toBe("number");
    }
  });

  test("every job that installs dependencies caches the bun store", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const steps: any[] = job.steps ?? [];
      if (!steps.some((step) => step.run === "bun install")) continue;
      const cache = steps.find((step) => String(step.uses ?? "").startsWith("actions/cache@"));
      expect(cache, `${name} caches ~/.bun/install/cache`).toBeDefined();
      expect(cache.with.path).toBe("~/.bun/install/cache");
      expect(cache.with.key).toBe("bun-${{ runner.os }}-${{ hashFiles('bun.lock') }}");
    }
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

describe("verify", () => {
  const verify = jobs.verify;
  const assertStep = verify.steps[0];

  test("runs whatever the gates did, and needs every other job", () => {
    expect(verify.if).toBe("always()");
    expect(verify.needs).toEqual([
      "code_paths",
      "ci-contract",
      ...GATED_JOBS,
    ]);
    expect(Object.keys(jobs)).toEqual([...verify.needs, "verify"]);
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
