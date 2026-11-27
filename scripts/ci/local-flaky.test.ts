import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CiFailure } from "../../packages/shared/contracts/ciFailures";
import { MAX_RERUNS, settledJobs, sortFlaky, suiteOf } from "./local-flaky";

const failure = (file: string | null, test = "t", job = "test-web"): CiFailure => ({ job, test, assertion: null, file, line: null, excerpt: "" });

describe("sortFlaky", () => {
  test("a test file that passes alone is flaky under load; one that fails alone, and a failure with no file, stay red", async () => {
    const ran: string[] = [];
    const out = await sortFlaky(
      [failure("packages/web/a.test.ts", "a1"), failure("packages/web/a.test.ts", "a2"), failure("packages/cli/src/b.test.ts"), failure(null)],
      async (file) => (ran.push(file), file.endsWith("a.test.ts") ? "pass" : "fail"),
    );
    expect(ran).toEqual(["packages/web/a.test.ts", "packages/cli/src/b.test.ts"]);
    expect(out.flaky.map((f) => f.test)).toEqual(["a1", "a2"]);
    expect(out.failing.map((f) => f.file)).toEqual(["packages/cli/src/b.test.ts", null]);
  });

  test("more failing files than MAX_RERUNS is the change: nothing runs again and all stay red", async () => {
    const many = Array.from({ length: MAX_RERUNS + 1 }, (_, i) => failure(`packages/web/f${i}.test.ts`));
    let calls = 0;
    const out = await sortFlaky(many, async () => (calls++, "pass"));
    expect(calls).toBe(0);
    expect(out.failing).toEqual(many);
  });

  test("with no time left nothing runs again, and a source file a failure names is never run as a test", async () => {
    let calls = 0;
    const out = await sortFlaky([failure("packages/web/a.test.ts"), failure("packages/web/lib/x.ts")], async () => (calls++, "pass"), () => false);
    expect(calls).toBe(0);
    expect(out.flaky).toEqual([]);
    expect(out.failing.length).toBe(2);
  });
});

test("a lint error in a test file stays red when the file passes alone; a test failure beside it is flaky", async () => {
  const out = await sortFlaky([failure("packages/web/a.test.ts", "eslint", "lint"), failure("packages/web/a.test.ts", "a1")], async () => "pass");
  expect(out.failing.map((f) => f.job)).toEqual(["lint"]);
  expect(out.flaky.map((f) => f.test)).toEqual(["a1"]);
});

test("a run alone stopped before a verdict is unjudged: neither red nor flaky", async () => {
  const out = await sortFlaky([failure("packages/web/a.test.ts", "a1")], async () => "stopped");
  expect(out.failing).toEqual([]);
  expect(out.flaky).toEqual([]);
  expect(out.unjudged.map((f) => f.test)).toEqual(["a1"]);
  expect(out.unjudged[0].assertion).toContain("stopped before a verdict");
});

describe("suiteOf", () => {
  test("a test file runs from its nearest package.json, by its path from there", () => {
    const root = mkdtempSync(join(tmpdir(), "suite-of-"));
    mkdirSync(join(root, "packages/cli/src/workflow"), { recursive: true });
    writeFileSync(join(root, "packages/cli/package.json"), "{}");
    expect(suiteOf(root, "packages/cli/src/workflow/x.test.ts")).toEqual({ dir: join(root, "packages/cli"), rel: "src/workflow/x.test.ts" });
    mkdirSync(join(root, "scripts/ci"), { recursive: true });
    expect(suiteOf(root, "scripts/ci/y.test.ts")).toEqual({ dir: root, rel: "scripts/ci/y.test.ts" });
  });
});

describe("settledJobs", () => {
  // A temp directory with a space in it keeps its whole path.
  const logs = "logs /tmp/My Runs/ci-local-x/test-cli.*.log";
  test("a red job's summary counts what the reruns alone left, never the count it ran with", () => {
    const flaky = failure("packages/platform/a.test.ts", "a", "test-platform");
    const red = failure("packages/cli/b.test.ts", "b", "test-cli");
    const out = settledJobs([
      { job: "test-platform", status: "fail", seconds: 30, reason: `1 failing, ${logs}` },
      { job: "test-cli", status: "fail", seconds: 365, reason: `3 failing, ${logs}` },
      { job: "test-web", status: "fail", seconds: 9, reason: `1 failing, ${logs}` },
      { job: "lint", status: "pass", seconds: 36 },
    ], { failing: [red, red], flaky: [flaky, failure("packages/cli/c.test.ts", "c", "test-cli")], unjudged: [failure("packages/web/d.test.ts", "d", "test-web")] });
    expect(out.map((r) => [r.job, r.status, r.reason])).toEqual([
      ["test-platform", "pass", `1 flaky (passed alone), ${logs}`],
      ["test-cli", "fail", `2 failing, 1 flaky (passed alone), ${logs}`],
      ["test-web", "no verdict", `1 not judged, ${logs}`],
      ["lint", "pass", undefined],
    ]);
  });
});
