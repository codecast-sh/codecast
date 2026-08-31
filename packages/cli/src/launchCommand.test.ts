// Cluster 1 (ct-39077): the fresh-launch binary + arg construction moved from the
// daemon's inline if/else chain into launchCommand.ts. These tests pin it to the
// exact pre-refactor behavior with an oracle that mirrors the OLD inline code, run
// over a matrix of clients/configs, plus targeted per-client assertions.
import { test, expect, describe } from "bun:test";
import { AGENT_CLIENTS, type AgentClientId } from "@codecast/shared/contracts";
import {
  buildLaunchArgs,
  buildPrintArgs,
  formatPrintCommand,
  getConfiguredAgentArgs,
  getPermissionFlags,
  launchBinary,
  resolvePrintModelAlias,
  type LaunchArgsInput,
} from "./launchCommand.js";

// Oracle: a faithful transcription of the daemon's OLD inline arg-building chain,
// so a matrix diff proves byte-identical behavior. Effort levels are the real ones
// from the registry, mirroring the daemon's CLAUDE/CODEX_EFFORT_LEVELS check.
const CLAUDE_EFFORTS = AGENT_CLIENTS.claude.modelConfig!.efforts;
const CODEX_EFFORTS = AGENT_CLIENTS.codex.modelConfig!.efforts;
const PI_EFFORTS = AGENT_CLIENTS.pi.modelConfig!.efforts;
const GROK_EFFORTS = AGENT_CLIENTS.grok.modelConfig!.efforts;

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
  } else if (agentType === "pi") {
    const extraArgs = configuredArgs;
    if (extraArgs) args.push(...extraArgs.split(/\s+/).filter(Boolean));
  } else if (agentType === "grok") {
    // grok: configured args + perm flags (codex shape; getPermissionFlags owns
    // the no-double-up rule, so the oracle appends unconditionally like codex).
    const extraArgs = configuredArgs;
    if (extraArgs) args.push(...extraArgs.split(/\s+/).filter(Boolean));
    if (permFlags) args.push(...permFlags.split(/\s+/).filter(Boolean));
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
  } else if (agentType === "pi") {
    if (input.modelAlias) args.push("--model", input.modelAlias);
    if (input.requestedEffort && (PI_EFFORTS as readonly string[]).includes(input.requestedEffort)) args.push("--thinking", input.requestedEffort);
  } else if (agentType === "grok") {
    if (input.modelAlias) args.push("-m", input.modelAlias);
    if (input.requestedEffort && (GROK_EFFORTS as readonly string[]).includes(input.requestedEffort)) args.push("--reasoning-effort", input.requestedEffort);
  }
  return { binaryArgs: args, notifyCodexBypass };
}

describe("launchBinary is a registry lookup matching the old binary if/else", () => {
  const noStable = { stable: () => null };
  test("codex/cursor-agent/gemini/claude", () => {
    expect(launchBinary("codex", noStable)).toBe("codex");
    expect(launchBinary("cursor", noStable)).toBe("cursor-agent");
    expect(launchBinary("gemini", noStable)).toBe("gemini");
    expect(launchBinary("claude", noStable)).toBe("claude");
  });
  test("claude launches from its fixed-path copy when macOS has one", () => {
    expect(launchBinary("claude", { stable: () => "/home/u/.codecast/bin/claude" })).toBe("/home/u/.codecast/bin/claude");
    expect(launchBinary("codex", { stable: () => "/home/u/.codecast/bin/claude" })).toBe("codex");
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
  const agentTypes: AgentClientId[] = ["claude", "codex", "cursor", "gemini", "opencode", "pi", "grok"];
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

  test("pi: passes configured args, ignores perm flags, takes --model/--thinking", () => {
    // configured agent_args.pi flow through (the bug: without a pi branch they were dropped)...
    expect(buildLaunchArgs({ agentType: "pi", configuredArgs: "--yolo", permFlags: "--ignored", defaultFlags: null }).binaryArgs)
      .toEqual(["--yolo"]);
    // ...default-param flags still apply, and no perm flags are injected.
    expect(buildLaunchArgs({ agentType: "pi", configuredArgs: "", permFlags: "--ignored", defaultFlags: "--verbose" }).binaryArgs)
      .toEqual(["--verbose"]);
    // per-session model is the full provider/model id; pi's --thinking rides the
    // effort slot and only accepts pi's own levels.
    expect(buildLaunchArgs({ agentType: "pi", configuredArgs: "", permFlags: null, defaultFlags: null, modelAlias: "openrouter/anthropic/claude-sonnet-5", requestedEffort: "xhigh" }).binaryArgs)
      .toEqual(["--model", "openrouter/anthropic/claude-sonnet-5", "--thinking", "xhigh"]);
    expect(buildLaunchArgs({ agentType: "pi", configuredArgs: "", permFlags: null, defaultFlags: null, requestedEffort: "bogus" }).binaryArgs)
      .toEqual([]);
  });

  test("grok: configured args + perm flags, -m model id, --reasoning-effort gated on grok's levels", () => {
    // Bypass perm flags flow through (grok uses claude's --permission-mode spelling).
    expect(buildLaunchArgs({ agentType: "grok", configuredArgs: "--verbose", permFlags: "--permission-mode bypassPermissions", defaultFlags: null }).binaryArgs)
      .toEqual(["--verbose", "--permission-mode", "bypassPermissions"]);
    // Model is the bare id (-m grok-4.6); effort is a launch flag.
    expect(buildLaunchArgs({ agentType: "grok", configuredArgs: "", permFlags: null, defaultFlags: null, modelAlias: "grok-4.6", requestedEffort: "xhigh" }).binaryArgs)
      .toEqual(["-m", "grok-4.6", "--reasoning-effort", "xhigh"]);
    // An effort outside GROK_EFFORT_LEVELS is dropped, never passed through.
    expect(buildLaunchArgs({ agentType: "grok", configuredArgs: "", permFlags: null, defaultFlags: null, modelAlias: "grok-4.5", requestedEffort: "bogus" }).binaryArgs)
      .toEqual(["-m", "grok-4.5"]);
  });
});

const printBase = {
  configuredArgs: "",
  permFlags: null as string | null,
  defaultFlags: null as string | null,
  prompt: "do the thing",
};

describe("buildPrintArgs maps unified flags onto each client's native print mode", () => {
  test("claude: -p positional, model/effort/output-format, bypass perms", () => {
    const { binaryArgs, ignored } = buildPrintArgs({
      ...printBase,
      agentType: "claude",
      permFlags: "--permission-mode bypassPermissions",
      modelAlias: "opus",
      requestedEffort: "high",
      outputFormat: "json",
    });
    expect(binaryArgs).toEqual([
      "--permission-mode", "bypassPermissions",
      "--model", "opus",
      "--effort", "high",
      "--output-format", "json",
      "-p", "do the thing",
    ]);
    expect(ignored).toEqual([]);
  });

  test("grok: -p takes the prompt as its value", () => {
    const { binaryArgs } = buildPrintArgs({
      ...printBase,
      agentType: "grok",
      permFlags: "--permission-mode bypassPermissions",
      modelAlias: "grok-4.6",
      requestedEffort: "high",
      outputFormat: "stream-json",
    });
    expect(binaryArgs).toEqual([
      "--permission-mode", "bypassPermissions",
      "-m", "grok-4.6",
      "--reasoning-effort", "high",
      "--output-format", "streaming-json",
      "-p", "do the thing",
    ]);
  });

  test("codex: exec subcommand, resume is a nested subcommand, json is --json", () => {
    const { binaryArgs } = buildPrintArgs({
      ...printBase,
      agentType: "codex",
      permFlags: "--dangerously-bypass-approvals-and-sandbox",
      modelAlias: "gpt-5.6-sol",
      requestedEffort: "xhigh",
      outputFormat: "json",
      resumeId: "abc",
    });
    expect(binaryArgs).toEqual([
      "exec", "resume", "abc",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m", "gpt-5.6-sol",
      "-c", "model_reasoning_effort=xhigh",
      "--json",
      "do the thing",
    ]);
  });

  test("opencode: run subcommand with --auto and --format json", () => {
    const { binaryArgs } = buildPrintArgs({
      ...printBase,
      agentType: "opencode",
      modelAlias: "anthropic/claude-sonnet-5",
      outputFormat: "json",
    });
    expect(binaryArgs).toEqual([
      "run", "--auto",
      "-m", "anthropic/claude-sonnet-5",
      "--format", "json",
      "do the thing",
    ]);
  });

  test("cursor print mode auto-approves with --force --trust", () => {
    const { binaryArgs } = buildPrintArgs({
      ...printBase,
      agentType: "cursor",
      modelAlias: "sonnet-4",
    });
    expect(binaryArgs).toEqual(["--force", "--trust", "--model", "sonnet-4", "-p", "do the thing"]);
  });

  test("cursor --permission-mode default skips auto-approve", () => {
    const { binaryArgs } = buildPrintArgs({
      ...printBase,
      agentType: "cursor",
      autoApprove: false,
    });
    expect(binaryArgs).toEqual(["-p", "do the thing"]);
  });

  test("pi: -p positional, --mode json, --thinking from effort", () => {
    const { binaryArgs } = buildPrintArgs({
      ...printBase,
      agentType: "pi",
      modelAlias: "openrouter/anthropic/claude-sonnet-5",
      requestedEffort: "xhigh",
      outputFormat: "json",
    });
    expect(binaryArgs).toEqual([
      "--model", "openrouter/anthropic/claude-sonnet-5",
      "--thinking", "xhigh",
      "--mode", "json",
      "-p", "do the thing",
    ]);
  });

  test("gemini: -p takes the prompt as its value, --yolo auto-approves", () => {
    const { binaryArgs } = buildPrintArgs({
      ...printBase,
      agentType: "gemini",
      modelAlias: "gemini-2.5-pro",
    });
    expect(binaryArgs).toEqual(["--yolo", "--model", "gemini-2.5-pro", "-p", "do the thing"]);
  });

  test("unsupported flags are listed in ignored, not passed through", () => {
    const { binaryArgs, ignored } = buildPrintArgs({
      ...printBase,
      agentType: "codex",
      maxTurns: 8,
      systemPrompt: "be brief",
      jsonSchema: "{}",
      bare: true,
    });
    expect(binaryArgs).not.toContain("--max-turns");
    expect(binaryArgs).not.toContain("--bare");
    expect(ignored).toEqual(["--max-turns", "--system-prompt", "--json-schema", "--bare"]);
  });

  test("claude honors --bare, --max-turns, --json-schema, --system-prompt", () => {
    const { binaryArgs, ignored } = buildPrintArgs({
      ...printBase,
      agentType: "claude",
      permFlags: "--permission-mode bypassPermissions",
      maxTurns: 4,
      systemPrompt: "be brief",
      jsonSchema: '{"type":"object"}',
      bare: true,
    });
    expect(binaryArgs).toEqual([
      "--permission-mode", "bypassPermissions",
      "--max-turns", "4",
      "--system-prompt", "be brief",
      "--json-schema", '{"type":"object"}',
      "--bare",
      "-p", "do the thing",
    ]);
    expect(ignored).toEqual([]);
  });
});

describe("print helpers", () => {
  test("resolvePrintModelAlias maps picker keys and passes raw ids through", () => {
    expect(resolvePrintModelAlias("claude", "opus")).toBe("opus");
    expect(resolvePrintModelAlias("claude", "default")).toBeUndefined();
    expect(resolvePrintModelAlias("claude", undefined)).toBeUndefined();
    expect(resolvePrintModelAlias("grok", "grok-4.6")).toBe("grok-4.6");
    expect(resolvePrintModelAlias("claude", "some-raw-id")).toBe("some-raw-id");
  });

  test("getPermissionFlags defaults claude and grok to bypass", () => {
    expect(getPermissionFlags("claude", null)).toBe("--permission-mode bypassPermissions");
    expect(getPermissionFlags("grok", null)).toBe("--permission-mode bypassPermissions");
    expect(getPermissionFlags("codex", null)).toBe("--dangerously-bypass-approvals-and-sandbox");
  });

  test("formatPrintCommand quotes args that need it", () => {
    expect(formatPrintCommand("claude", ["-p", "do the thing"])).toBe("claude -p 'do the thing'");
    expect(formatPrintCommand("grok", ["-m", "grok-4.6", "-p", "hi"])).toBe("grok -m grok-4.6 -p hi");
  });
});
