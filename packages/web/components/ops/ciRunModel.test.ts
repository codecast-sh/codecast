import { describe, expect, test } from "bun:test";
import { ciFailureText, failedStep, runJobs } from "./ciRunModel";
import type { OpsCiRun } from "./opsTypes";

const run: OpsCiRun = {
  _id: "r",
  repository: "o/r",
  run_id: "42",
  fetched_at: 0,
  title: "fix: freeze the clock",
  jobs: [
    { id: "1", name: "landing-units", conclusion: "failure", steps: [{ number: 1, name: "checkout", conclusion: "success" }, { number: 7, name: "Run tests", conclusion: "failure" }] },
    { id: "2", name: "lint", conclusion: "success", steps: [] },
    { id: "3", name: "deploy", conclusion: "skipped", steps: [] },
  ],
  annotations: [{ job: "landing-units", level: "failure", path: "src/a.test.tsx", line: 887, message: "Expected Mon, received today" }],
  log_job: "landing-units",
  log_tail: "FAIL a.test.tsx\n##[error]Process completed with exit code 1.",
};

describe("ciRunModel", () => {
  test("failed jobs whole, the rest counted", () => {
    expect(runJobs(run)).toMatchObject({ passed: 1, other: 1 });
    expect(runJobs(run).failed.map((j) => j.name)).toEqual(["landing-units"]);
    expect(failedStep(run.jobs[0])?.name).toBe("Run tests");
  });

  test("the failure a fix session reads: job and step, annotations, then the log tail", () => {
    expect(ciFailureText(run)).toBe([
      "run: fix: freeze the clock",
      'job landing-units failure at step 7 "Run tests"',
      "src/a.test.tsx:887 Expected Mon, received today",
      "log tail (landing-units):",
      "FAIL a.test.tsx\n##[error]Process completed with exit code 1.",
    ].join("\n"));
  });

  test("a run read with nothing in it adds nothing", () => {
    expect(ciFailureText({ ...run, title: undefined, jobs: [], annotations: [], log_tail: undefined })).toBeNull();
  });
});

describe("tailLines", () => {
  test("stops at the last error mark, dropping the next step", () => {
    const { tailLines } = require("./ciRunModel") as typeof import("./ciRunModel");
    expect(tailLines("a\n##[error]boom\nSLACK_ID=1")).toEqual(["a", "##[error]boom"]);
    expect(tailLines("a\nb")).toEqual(["a", "b"]);
  });

  test("a setup step or a runner error blames the machine, not the commit", () => {
    const { envFailure } = require("./ciRunModel") as typeof import("./ciRunModel");
    const job = (steps: { number: number; name: string; conclusion?: string }[]) => ({ id: "1", name: "e2e", conclusion: "failure", steps });
    const playwright = { jobs: [job([{ number: 7, name: "Build", conclusion: "success" }, { number: 8, name: "Install Playwright browsers", conclusion: "failure" }])], log_tail: "##[error]Playwright does not support chromium on ubuntu26.04-x64" };
    expect(envFailure(playwright)).toEqual({ step: "Install Playwright browsers", image: "ubuntu26.04" });
    expect(envFailure({ jobs: [job([{ number: 3, name: "Run tests", conclusion: "failure" }])], log_tail: "##[error]expected 2 to be 3" })).toBeNull();
    expect(envFailure({ jobs: [job([{ number: 3, name: "Run tests", conclusion: "failure" }])], log_tail: "Error: getaddrinfo EAI_AGAIN registry.npmjs.org" })).toMatchObject({ step: "Run tests" });
  });
});

describe("the log line that explains a failure", () => {
  const { firstFailureLine, isFailureLine } = require("./ciRunModel") as typeof import("./ciRunModel");
  test("the first line that says what went wrong leads, before the closing error mark", () => {
    const lines = [
      "installing dependencies for ubuntu26.04-x64 as a fallback.",
      "Cannot install dependencies for ubuntu26.04-x64 with Playwright 1.58.0!",
      "Failed to install browsers",
      "Error: ERROR: Playwright does not support chromium on ubuntu26.04-x64",
      "##[error]Process completed with exit code 1.",
    ];
    expect(firstFailureLine(lines)).toBe(1);
    expect(isFailureLine(lines[3])).toBe(true);
    expect(isFailureLine(lines[0])).toBe(false);
    expect(firstFailureLine(["ok", "##[error]boom"])).toBe(1);
    expect(firstFailureLine(["ok"])).toBe(-1);
  });
});
