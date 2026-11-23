import { describe, expect, test } from "bun:test";
import { parseFailures } from "@codecast/shared/contracts/ciFailures";
import { parseDeadline } from "./ciStation.js";
import { BUN_LOG, BUN_TEST, STEP_END, bunLogBody, VITE_LOG, tests } from "./ciStation.testkit.js";

describe("parseFailures", () => {
  test("bun test: the (fail) line with the expect output above it, once though bun repeats it in its summary", () => {
    expect(parseFailures("test-cli", BUN_LOG)).toEqual([{
      job: "test-cli",
      test: BUN_TEST,
      assertion: "source files on daemon.ts's static graph (Expected: <= 616; Received: 617)",
      file: "packages/cli/src/bench/bootGraph.guard.test.ts",
      line: 723,
      excerpt: expect.stringContaining("toBeLessThanOrEqual(616)"),
    }]);
    expect(parseFailures("test-cli", BUN_LOG)[0]!.excerpt).not.toContain("##[error]");
  });

  test("bun test behind turbo's prefix and in colour", () => {
    const log = `2026-11-20T10:00:00.0Z @codecast/web:test: \x1b[31merror:\x1b[0m boom\n2026-11-20T10:00:00.1Z @codecast/web:test: \x1b[31m(fail)\x1b[0m suite > case \x1b[2m[1.00ms]\x1b[0m`;
    expect(parseFailures("test-web", log)[0]).toMatchObject({ test: "suite > case", assertion: "boom" });
  });

  test("bun test: a timeout names the timeout", () => {
    const log = `2026-11-20T10:00:00.0Z ##[group]src/bench/integration.test.ts:\n2026-11-20T10:00:05.0Z error: Test "loads" timed out after 5000ms\n2026-11-20T10:00:05.1Z (fail) bench > loads [5001.00ms]`;
    expect(parseFailures("test-cli", log)[0]).toMatchObject({ test: "bench > loads", assertion: 'Test "loads" timed out after 5000ms', file: "src/bench/integration.test.ts", line: null });
  });

  test("tsc through turbo, and eslint's stylish output", () => {
    const tsc = `2026-11-20T10:00:00.0Z @codecast/cli:typecheck: src/flowCommand.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.`;
    expect(parseFailures("typecheck", tsc)[0]).toMatchObject({ test: "src/flowCommand.ts: TS2322 Type 'string' is not assignable to type 'number'.", file: "src/flowCommand.ts", line: 12 });
    const lint = `2026-11-20T10:00:00.0Z /home/runner/work/app/app/packages/web/app/page.tsx\n2026-11-20T10:00:00.1Z   14:7  error  'unused' is assigned a value but never used  @typescript-eslint/no-unused-vars`;
    expect(parseFailures("lint", lint)[0]).toMatchObject({ test: "packages/web/app/page.tsx: 'unused' is assigned a value but never used (@typescript-eslint/no-unused-vars)", file: "packages/web/app/page.tsx", line: 14 });
  });

  test("nothing it knows: the failed step's tail up to its exit, without the runner's cleanup", () => {
    expect(parseFailures("build", VITE_LOG("out of memory"))).toEqual([{ job: "build", test: null, assertion: null, file: null, line: null, excerpt: "Set up job\nvite v5.4.0 building for production...\nerror during build: out of memory" }]);
  });

  test("bun's summary is accounted for: an error between tests (a file that no longer loads) is a failure too (P1)", () => {
    const log = `${bunLogBody}
2026-11-20T16:38:42.0Z ##[group]src/newFeature.test.ts:
2026-11-20T16:38:42.1Z # Unhandled error between tests
2026-11-20T16:38:42.2Z -------------------------------
2026-11-20T16:38:42.3Z error: Cannot find module "./newFeature" from "/home/runner/work/app/app/packages/cli/src/newFeature.test.ts"
2026-11-20T16:38:42.4Z -------------------------------
2026-11-20T16:38:42.5Z  1 error
${STEP_END()}`;
    const failures = parseFailures("test-cli", log);
    expect(tests(failures)).toEqual([["test-cli", BUN_TEST], ["test-cli", null]]);
    expect(failures[1]).toMatchObject({ assertion: "bun reported 1 error between tests", excerpt: expect.stringContaining('Cannot find module "./newFeature"') });
  });

  test("bun's closing list of failures, printed after a later file's group, repeats them and adds none", () => {
    const log = `2026-11-20T10:00:00.0Z ##[group]src/a.test.ts:\n2026-11-20T10:00:00.1Z error: boom\n2026-11-20T10:00:00.2Z (fail) a > breaks [1.00ms]\n2026-11-20T10:00:01.0Z ##[group]src/b.test.ts:\n2026-11-20T10:00:01.1Z (pass) b > works [1.00ms]\n2026-11-20T10:00:02.0Z 1 tests failed:\n2026-11-20T10:00:02.1Z (fail) a > breaks [1.00ms]\n2026-11-20T10:00:02.2Z  1 fail\n${STEP_END()}`;
    expect(parseFailures("test-cli", log).map((f) => [f.test, f.file])).toEqual([["a > breaks", "src/a.test.ts"]]);
  });

  test("more failures than the log names is a failure with no test", () => {
    const log = bunLogBody.replace(" 1 fail", " 3 fail") + `\n${STEP_END()}`;
    expect(parseFailures("test-cli", log)[1]).toMatchObject({ test: null, assertion: "bun reported 2 failures the log names no test for" });
  });

  test("every failed step is read, and only failed steps (P2, P3)", () => {
    const log = `2026-11-20T16:30:00.0Z ##[group]Run bun test e2e
2026-11-20T16:30:00.1Z bun test e2e
2026-11-20T16:30:00.2Z ##[endgroup]
${bunLogBody}
2026-11-20T16:38:50.0Z E2E passed on attempt 2
2026-11-20T16:39:00.0Z ##[group]Run bun scripts/build.ts
2026-11-20T16:39:00.1Z bun scripts/build.ts
2026-11-20T16:39:00.2Z ##[endgroup]
2026-11-20T16:39:01.0Z error: Could not resolve "./newThing"
${STEP_END()}
2026-11-20T16:39:02.0Z ##[group]Run bun run guard
2026-11-20T16:39:02.1Z bun run guard
2026-11-20T16:39:02.2Z ##[endgroup]
2026-11-20T16:39:03.0Z fatal: guard failed: packages/web/foo.ts imports the daemon
${STEP_END()}`;
    const failures = parseFailures("test-cli", log);
    // The e2e step retried and passed: its attempt-1 (fail) line is no failure of the job.
    expect(tests(failures)).toEqual([["test-cli", null], ["test-cli", null]]);
    expect(failures[0]!.excerpt).toContain('Could not resolve "./newThing"');
    expect(failures[1]!.excerpt).toContain("guard failed");
  });

  test("deadlines", () => {
    expect(parseDeadline("60m")).toBe(3_600_000);
    expect(parseDeadline("1h30m")).toBe(5_400_000);
    expect(parseDeadline("90s")).toBe(90_000);
    expect(parseDeadline("45")).toBe(2_700_000);
    for (const bad of ["1.5h", "soon", "", "0m"]) expect(parseDeadline(bad)).toBeNull();
  });
});
