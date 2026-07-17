// Cluster 1 (ct-39077): the fresh-launch binary + arg construction moved from the
// daemon's inline if/else chain into launchCommand.ts. These tests pin it to the
// exact pre-refactor behavior with an oracle that mirrors the OLD inline code, run
// over a matrix of clients/configs, plus targeted per-client assertions.
import { test, expect, describe } from "bun:test";
import { AGENT_CLIENTS, type AgentClientId } from "@codecast/shared/contracts";
import {
  buildLaunchArgs,
  launchBinary,
  getConfiguredAgentArgs,
  type LaunchArgsInput,
} from "./launchCommand.js";

// Oracle: a faithful transcription of the daemon's OLD inline arg-building chain,
// so a matrix diff proves byte-identical behavior. Effort levels are the real ones
// from the registry, mirroring the daemon's CLAUDE/CODEX_EFFORT_LEVELS check.
const CLAUDE_EFFORTS = AGENT_CLIENTS.claude.modelConfig!.efforts;
const CODEX_EFFORTS = AGENT_CLIENTS.codex.modelConfig!.efforts;

function oracle(input: LaunchArgsInput): { binaryArgs: string[]; notifyCodexBypass: boolean } {
  const { agentType, configuredArgs, permFlags, defaultFlags } = input;
  const args: string[] = [];
  let notifyCodexBypass = false;
  if (agentType === "codex") {
    const extraArgs = configuredArgs;
    if (extraArgs) args.push(...extraArgs.split(/\s+/).filter(Boolean));
    if (permFlags) {
      args.push(...permFlags.split(/\s+/).filter(Boolean));
      if (!extraArgs && !input.hasCodexPermissionMode) notifyCodexBypass = true;
    }
  } else if (agentType === "cursor") {
    // binary only
  } else if (agentType === "gemini") {
    // binary only
  } else if (agentType === "opencode") {
    const extraArgs = configuredArgs;
    if (extraArgs) args.push(...extraArgs.split(/\s+/).filter(Boolean));
    if (!extraArgs.includes("--auto")) args.push("--auto");
  } else {
    const extraArgs = configuredArgs;
    if (extraArgs) args.push(...extraArgs.split(/\s+/).filter(Boolean));
    if (permFlags && !extraArgs.includes("--dangerously-skip-permissions") && !extraArgs.includes("--permission-mode") && !extraArgs.includes("--allow-dangerously-skip-permissions")) {
      args.push(...permFlags.split(/\s+/).filter(Boolean));
    }
    if (input.assignedClaudeSessionId && !extraArgs.includes("--session-id")) {
      args.push("--session-id", input.assignedClaudeSessionId);
    }
  }
  if (defaultFlags) args.push(...defaultFlags.split(/\s+/).filter(Boolean));
  if (agentType === "claude") {
    if (input.modelAlias) args.push("--model", input.modelAlias);
    if (input.requestedEffort && (CLAUDE_EFFORTS as readonly string[]).includes(input.requestedEffort)) args.push("--effort", input.requestedEffort);
  } else if (agentType === "codex") {
    if (input.modelAlias) args.push("-m", input.modelAlias);
    if (input.requestedEffort && (CODEX_EFFORTS as readonly string[]).includes(input.requestedEffort)) args.push("-c", `model_reasoning_effort=${input.requestedEffort}`);
  } else if (agentType === "opencode") {
    if (input.modelAlias) args.push("-m", input.modelAlias);
  }
  return { binaryArgs: args, notifyCodexBypass };
}

describe("launchBinary is a registry lookup matching the old binary if/else", () => {
  test("codex/cursor-agent/gemini/claude", () => {
    expect(launchBinary("codex")).toBe("codex");
    expect(launchBinary("cursor")).toBe("cursor-agent");
    expect(launchBinary("gemini")).toBe("gemini");
    expect(launchBinary("claude")).toBe("claude");
  });
});

describe("getConfiguredAgentArgs reads the legacy per-client named fields", () => {
  test("codex/claude read their field; cursor/gemini are empty", () => {
    const config = { codex_args: "--full-auto", claude_args: "--chrome" } as any;
    expect(getConfiguredAgentArgs("codex", config)).toBe("--full-auto");
    expect(getConfiguredAgentArgs("claude", config)).toBe("--chrome");
    expect(getConfiguredAgentArgs("cursor", config)).toBe("");
    expect(getConfiguredAgentArgs("gemini", config)).toBe("");
    expect(getConfiguredAgentArgs("codex", null)).toBe("");
  });
});

describe("buildLaunchArgs matches the oracle across a matrix", () => {
  const agentTypes: AgentClientId[] = ["claude", "codex", "cursor", "gemini", "opencode"];
  const configuredArgsCases = ["", "--chrome", "--permission-mode acceptEdits", "--dangerously-skip-permissions", "--session-id fixed"];
  const permFlagsCases = [null, "--permission-mode bypassPermissions", "--dangerously-bypass-approvals-and-sandbox"];
  const defaultFlagsCases = [null, "--verbose", "--foo bar"];
  const modelAliasCases = [undefined, "opus", "gpt-5.6"];
  const effortCases = [undefined, "high", "xhigh", "bogus"];
  const sessionIdCases = [undefined, "sess-123"];
  const modeCases = [false, true];

  test("full cartesian product is byte-identical to the oracle", () => {
    let count = 0;
    for (const agentType of agentTypes)
      for (const configuredArgs of configuredArgsCases)
        for (const permFlags of permFlagsCases)
          for (const defaultFlags of defaultFlagsCases)
            for (const modelAlias of modelAliasCases)
              for (const requestedEffort of effortCases)
                for (const assignedClaudeSessionId of sessionIdCases)
                  for (const hasCodexPermissionMode of modeCases) {
                    const input: LaunchArgsInput = {
                      agentType, configuredArgs, permFlags, defaultFlags,
                      modelAlias, requestedEffort, assignedClaudeSessionId, hasCodexPermissionMode,
                    };
                    expect(buildLaunchArgs(input)).toEqual(oracle(input));
                    count++;
                  }
    expect(count).toBeGreaterThan(1000);
  });
});

describe("buildLaunchArgs — targeted per-client behavior", () => {
  test("codex: configured args THEN perm flags THEN model/effort", () => {
    const { binaryArgs, notifyCodexBypass } = buildLaunchArgs({
      agentType: "codex",
      configuredArgs: "--full-auto",
      permFlags: "--dangerously-bypass-approvals-and-sandbox",
      defaultFlags: null,
      modelAlias: "gpt-5.6",
      requestedEffort: "high",
    });
    expect(binaryArgs).toEqual(["--full-auto", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5.6", "-c", "model_reasoning_effort=high"]);
    // configured args present -> no bypass notification
    expect(notifyCodexBypass).toBe(false);
  });

  test("codex: default full-access with no config -> notifyCodexBypass true", () => {
    expect(buildLaunchArgs({ agentType: "codex", configuredArgs: "", permFlags: "--dangerously-bypass-approvals-and-sandbox", defaultFlags: null }).notifyCodexBypass).toBe(true);
    // ...but suppressed when a permission mode is configured
    expect(buildLaunchArgs({ agentType: "codex", configuredArgs: "", permFlags: "--dangerously-bypass-approvals-and-sandbox", defaultFlags: null, hasCodexPermissionMode: true }).notifyCodexBypass).toBe(false);
    // ...and never for non-codex
    expect(buildLaunchArgs({ agentType: "claude", configuredArgs: "", permFlags: "--permission-mode bypassPermissions", defaultFlags: null }).notifyCodexBypass).toBe(false);
  });

  test("claude: perm flags skipped when configured args already pin permission", () => {
    const { binaryArgs } = buildLaunchArgs({ agentType: "claude", configuredArgs: "--permission-mode acceptEdits", permFlags: "--permission-mode bypassPermissions", defaultFlags: null });
    expect(binaryArgs).toEqual(["--permission-mode", "acceptEdits"]);
  });

  test("claude: --session-id appended unless already configured", () => {
    expect(buildLaunchArgs({ agentType: "claude", configuredArgs: "", permFlags: null, defaultFlags: null, assignedClaudeSessionId: "abc" }).binaryArgs).toEqual(["--session-id", "abc"]);
    expect(buildLaunchArgs({ agentType: "claude", configuredArgs: "--session-id mine", permFlags: null, defaultFlags: null, assignedClaudeSessionId: "abc" }).binaryArgs).toEqual(["--session-id", "mine"]);
  });

  test("claude model/effort use --model/--effort; bogus effort dropped", () => {
    expect(buildLaunchArgs({ agentType: "claude", configuredArgs: "", permFlags: null, defaultFlags: null, modelAlias: "opus", requestedEffort: "high" }).binaryArgs).toEqual(["--model", "opus", "--effort", "high"]);
    expect(buildLaunchArgs({ agentType: "claude", configuredArgs: "", permFlags: null, defaultFlags: null, modelAlias: "opus", requestedEffort: "bogus" }).binaryArgs).toEqual(["--model", "opus"]);
  });

  test("cursor/gemini contribute only default-param flags (no model/effort/perm)", () => {
    for (const agentType of ["cursor", "gemini"] as AgentClientId[]) {
      expect(buildLaunchArgs({ agentType, configuredArgs: "", permFlags: "--ignored", defaultFlags: "--verbose", modelAlias: "opus", requestedEffort: "high" }).binaryArgs).toEqual(["--verbose"]);
    }
  });

  test("opencode: launches auto-approved with the picker's -m model (no effort flag)", () => {
    // managed opencode is driven from the web -> auto-approve, since the daemon can't
    // answer TUI permission prompts. modelAlias is opencode's provider/model.
    expect(buildLaunchArgs({ agentType: "opencode", configuredArgs: "", permFlags: null, defaultFlags: null, modelAlias: "anthropic/claude-opus-4-5", requestedEffort: "high" }).binaryArgs)
      .toEqual(["--auto", "-m", "anthropic/claude-opus-4-5"]);
    // no model -> just --auto
    expect(buildLaunchArgs({ agentType: "opencode", configuredArgs: "", permFlags: null, defaultFlags: null }).binaryArgs).toEqual(["--auto"]);
    // user already pinned --auto -> not doubled
    expect(buildLaunchArgs({ agentType: "opencode", configuredArgs: "--auto --pure", permFlags: null, defaultFlags: null }).binaryArgs).toEqual(["--auto", "--pure"]);
  });
});
