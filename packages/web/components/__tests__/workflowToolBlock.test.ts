import { describe, expect, it } from "bun:test";
import { parseWorkflowLaunch, parseWorkflowScriptMeta } from "../ConversationView";

const LAUNCH_RECEIPT = `Workflow launched in background. Task ID: wq2ftfdva
Summary: Implement, independently review (revise-on-fail), and validate the 3 remaining codebase fixes (A3 gates, A4 red CI tests, A6 dead code); emit patches for final suite validation
Transcript dir: /Users/ashot/.claude/projects/-Users-ashot-src-codecast/cb30fc48-8a7a-4907-ac8a-ff3a638052ec/subagents/workflows/wf_d653e9cf-6e6
Script file: /Users/ashot/.claude/projects/-Users-ashot-src-codecast/cb30fc48-8a7a-4907-ac8a-ff3a638052ec/workflows/scripts/codecast-arch-fixes-r2-wf_d653e9cf-6e6.js
(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "..."} to iterate without resending the script.)
Run ID: wf_d653e9cf-6e6
To resume after editing the script: Workflow({scriptPath: "...", resumeFromRunId: "wf_d653e9cf-6e6"}) — completed agents return cached results.
You will be notified when it completes. Use /workflows to watch live progress.`;

describe("parseWorkflowLaunch", () => {
  it("extracts task id, summary, script file, and run id from the launch receipt", () => {
    const launch = parseWorkflowLaunch(LAUNCH_RECEIPT);
    expect(launch.taskId).toBe("wq2ftfdva");
    expect(launch.summary).toStartWith("Implement, independently review");
    expect(launch.scriptFile).toEndWith("codecast-arch-fixes-r2-wf_d653e9cf-6e6.js");
    expect(launch.runId).toBe("wf_d653e9cf-6e6");
  });

  it("matches the run id from the Run ID line, not the resume instructions", () => {
    expect(parseWorkflowLaunch("Run ID: wf_abc123-x\nresumeFromRunId: wf_zzz").runId).toBe("wf_abc123-x");
  });

  it("returns empty fields for non-launch content", () => {
    const launch = parseWorkflowLaunch("Error: script syntax error at line 3");
    expect(launch.taskId).toBeUndefined();
    expect(launch.runId).toBeUndefined();
  });
});

describe("parseWorkflowScriptMeta", () => {
  it("reads name and description from the meta literal", () => {
    const meta = parseWorkflowScriptMeta(`export const meta = {
  name: 'find-flaky-tests',
  description: "Find flaky tests and propose fixes",
  phases: [{ title: 'Scan', detail: 'grep test logs' }],
}
phase('Scan')`);
    expect(meta.name).toBe("find-flaky-tests");
    expect(meta.description).toBe("Find flaky tests and propose fixes");
  });

  it("returns undefined fields when there is no meta", () => {
    const meta = parseWorkflowScriptMeta("const x = 1");
    expect(meta.name).toBeUndefined();
    expect(meta.description).toBeUndefined();
  });
});
