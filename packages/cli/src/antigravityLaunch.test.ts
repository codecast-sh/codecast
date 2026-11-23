import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { AGENT_CLIENTS } from "@codecast/shared/contracts";
import { buildLaunchArgs, buildPrintArgs, getPermissionFlags, permissionFlagsForMode } from "./launchCommand.js";
import { buildNonClaudeResumeCommand, isValidResumeSessionId, resolveResumeAgentType } from "./resumeCommand.js";
import { argvSessionId, isResumeInvocation } from "./sessionProcessMatcher.js";
import { classifyGlyphlessClientPaneState, classifyLivePaneFor, isAntigravityTrustDialog } from "./tmuxPaneState.js";
import { buildBlankLaunchArgs, classifyStartedPane, classifyTranscriptTailFor, planTrustPromptStep, sessionProcessGrepToken } from "./daemon.js";
import type { Config } from "./config/types.js";

// Pane frames captured from agy 1.5.14 in tmux (120x40), account and paths
// scrubbed: the first-launch trust dialog, the idle composer after it, the same
// pane while a shell command ran, and after the turn answered.
const pane = (name: string) => fs.readFileSync(path.join(import.meta.dir, "__fixtures__", "antigravity", `pane-${name}.txt`), "utf8");
const agy = AGENT_CLIENTS.antigravity;
const id = "42733a6f-f5ef-48ca-9f08-d571bd62efdd";

describe("launch", () => {
  test("a managed pane auto-approves tool requests unless agent_args pins a mode", () => {
    expect(getPermissionFlags("antigravity", null)).toBe("--dangerously-skip-permissions");
    expect(getPermissionFlags("antigravity", { agent_args: { antigravity: "--mode plan" } } as Config)).toBeNull();
    expect(getPermissionFlags("antigravity", { agent_args: { antigravity: "--dangerously-skip-permissions" } } as Config)).toBeNull();
    expect(getPermissionFlags("antigravity", { agent_permission_modes: { antigravity: "default" } } as Config)).toBeNull();
    expect(getPermissionFlags("antigravity", { agent_permission_modes: { antigravity: "bypass" } } as Config)).toBe("--dangerously-skip-permissions");
  });

  test("cast exec's permission modes map onto agy's own", () => {
    expect(permissionFlagsForMode("antigravity", "bypass", "")).toBe("--dangerously-skip-permissions");
    expect(permissionFlagsForMode("antigravity", "plan", "")).toBe("--mode plan");
    expect(permissionFlagsForMode("antigravity", "default", "")).toBeNull();
    expect(permissionFlagsForMode("antigravity", "acceptEdits", "")).toBeNull();
    expect(permissionFlagsForMode("antigravity", "plan", "--mode auto")).toBeNull();
  });

  test("model and effort ride --model <base> --effort <level>, after configured args", () => {
    const { binaryArgs } = buildLaunchArgs({
      agentType: "antigravity",
      configuredArgs: "--add-dir /extra",
      permFlags: getPermissionFlags("antigravity", null),
      defaultFlags: null,
      modelAlias: "gemini-4-neon",
      requestedEffort: "low",
    });
    expect(binaryArgs).toEqual(["--add-dir", "/extra", "--dangerously-skip-permissions", "--model", "gemini-4-neon", "--effort", "low"]);
    const unknownEffort = buildLaunchArgs({ agentType: "antigravity", configuredArgs: "", permFlags: null, defaultFlags: null, requestedEffort: "ultra" });
    expect(unknownEffort.binaryArgs).toEqual([]);
  });

  test("a blank pane gets the same permission flag", () => {
    expect(buildBlankLaunchArgs("antigravity", null)).toEqual(["--dangerously-skip-permissions"]);
  });

  test("cast exec: -p takes the prompt as its value, resume is --conversation", () => {
    const { binaryArgs, ignored } = buildPrintArgs({
      agentType: "antigravity",
      prompt: "say hi",
      configuredArgs: "",
      permFlags: getPermissionFlags("antigravity", null),
      defaultFlags: null,
      resumeId: id,
      outputFormat: "stream-json",
      worktree: true,
    });
    expect(binaryArgs).toEqual(["--conversation", id, "--dangerously-skip-permissions", "--output-format", "stream-json", "-p", "say hi"]);
    expect(ignored).toEqual(["--worktree"]);
  });
});

describe("resume", () => {
  test("only a conversation uuid reaches the shell", () => {
    expect(isValidResumeSessionId("antigravity", id)).toBe(true);
    expect(isValidResumeSessionId("antigravity", "$(touch /tmp/x)")).toBe(false);
    expect(isValidResumeSessionId("antigravity", "my-conversation-title")).toBe(false);
  });

  test("the resume line carries the permission flag and model, like the launch", () => {
    const cmd = buildNonClaudeResumeCommand("antigravity", id, { permFlags: "--dangerously-skip-permissions", model: "gemini-4-neon", effort: "high" });
    expect(cmd).toContain(`agy --conversation ${id}`);
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).toContain("--model gemini-4-neon");
    expect(cmd).toContain("--effort high");
  });

  test("an antigravity hint wins over a missing local transcript", () => {
    expect(resolveResumeAgentType("antigravity", undefined)).toBe("antigravity");
  });

  test("a running agy names its conversation on its command line", () => {
    expect(argvSessionId(`agy --dangerously-skip-permissions --conversation ${id}`)).toBe(id);
    expect(isResumeInvocation("antigravity", `agy --conversation ${id}`)).toBe(true);
    expect(isResumeInvocation("antigravity", "agy --dangerously-skip-permissions")).toBe(false);
    expect(sessionProcessGrepToken("antigravity", "claude")).toBe("agy");
  });
});

describe("pane", () => {
  test("injection readiness: trust is answered, a running turn is busy, an idle composer is ready", () => {
    expect(classifyGlyphlessClientPaneState(pane("trust"), agy.promptReadyPattern)).toBe("trust");
    expect(classifyGlyphlessClientPaneState(pane("idle"), agy.promptReadyPattern)).toBe("idle");
    expect(classifyGlyphlessClientPaneState(pane("busy"), agy.promptReadyPattern)).toBe("busy");
    expect(classifyGlyphlessClientPaneState(pane("done"), agy.promptReadyPattern)).toBe("idle");
    // The reaper's view goes through the same busy-first rule.
    expect(classifyLivePaneFor("antigravity", pane("busy"))).toBe("busy");
    expect(classifyLivePaneFor("antigravity", pane("done"))).toBe("idle");
  });

  test("a fresh launch is ready only once the composer and its footer are painted", () => {
    expect(classifyStartedPane(pane("trust"), agy.promptReadyPattern, agy.paneReadiness)).toBe("trust");
    expect(classifyStartedPane(pane("idle"), agy.promptReadyPattern, agy.paneReadiness)).toBe("ready");
    const halfPainted = pane("idle").replace(/\? for shortcuts/, "");
    expect(classifyStartedPane(halfPainted, agy.promptReadyPattern, agy.paneReadiness)).toBe("booting");
  });

  test("the trust dialog's preselected Yes is confirmed by the shared highlight walker", () => {
    expect(isAntigravityTrustDialog(pane("trust"))).toBe(true);
    expect(isAntigravityTrustDialog(pane("idle"))).toBe(false);
    expect(planTrustPromptStep(pane("trust").split("\n"))).toEqual({ action: "confirm", option: "> Yes, I trust this folder" });
  });

  test("turn state from the transcript tail routes to agy's classifier", () => {
    const classify = classifyTranscriptTailFor("antigravity");
    expect(classify).toBeDefined();
    expect(classify!('{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"pong"}')).toBe("idle");
  });
});
