import { describe, expect, test } from "bun:test";
import {
  AGENT_SWITCH_NOTICE_PREFIX,
  agentDisplayName,
  formatAgentSwitchNotice,
  isAgentSwitchNotice,
  isModelSwitchCommandName,
  isModelSwitchStdout,
  modelDisplayLabel,
  modelSwitchStdoutLabel,
  parseAgentSwitchNotice,
} from "./agentSwitch";

describe("agent switch notice", () => {
  test("names Claude and Codex from either spelling", () => {
    expect(agentDisplayName("claude_code")).toBe("Claude");
    expect(agentDisplayName("claude")).toBe("Claude");
    expect(agentDisplayName("codex")).toBe("Codex");
  });

  test("formats a provider switch with a was-clause", () => {
    const body = formatAgentSwitchNotice({
      toAgent: "codex",
      fromAgent: "claude_code",
    });
    expect(body.startsWith(`${AGENT_SWITCH_NOTICE_PREFIX} Codex (was Claude).`)).toBe(true);
    expect(isAgentSwitchNotice(body)).toBe(true);
    expect(parseAgentSwitchNotice(body)).toEqual({
      toLabel: "Codex",
      fromLabel: "Claude",
    });
  });

  test("includes the model when one is named", () => {
    const body = formatAgentSwitchNotice({
      toAgent: "claude_code",
      fromAgent: "claude_code",
      toModel: "opus",
      fromModel: "sonnet",
    });
    expect(parseAgentSwitchNotice(body)).toEqual({
      toLabel: "Claude · Opus",
      fromLabel: "Claude · Sonnet",
    });
  });

  test("a same-agent same-model notice has no was-clause", () => {
    const body = formatAgentSwitchNotice({
      toAgent: "codex",
      fromAgent: "codex",
      toModel: "gpt-5.4",
      fromModel: "gpt-5.4",
    });
    expect(parseAgentSwitchNotice(body)).toEqual({ toLabel: "Codex · GPT-5.4" });
  });

  test("rejects ordinary user text", () => {
    expect(isAgentSwitchNotice("please switch to codex")).toBe(false);
    expect(parseAgentSwitchNotice("please switch to codex")).toBeNull();
  });
});

describe("model display", () => {
  test("maps stored claude ids and picker keys to the picker label", () => {
    expect(modelDisplayLabel("claude_code", "opus")).toBe("Opus");
    expect(modelDisplayLabel("claude_code", "claude-opus-4-8")).toBe("Opus");
    expect(modelDisplayLabel("codex", "gpt-5.4")).toBe("GPT-5.4");
    expect(modelDisplayLabel("claude_code", "default")).toBeUndefined();
  });
});

describe("slash-command model echoes", () => {
  test("recognizes /model and /effort", () => {
    expect(isModelSwitchCommandName("model")).toBe(true);
    expect(isModelSwitchCommandName("effort")).toBe(true);
    expect(isModelSwitchCommandName("compact")).toBe(false);
  });

  test("reads the pretty name out of Claude's stdout echo", () => {
    const stdout =
      "<local-command-stdout>Set model to \u001b[1mOpus 4.8\u001b[22m and saved as your default for new sessions</local-command-stdout>";
    expect(isModelSwitchStdout(stdout)).toBe(true);
    expect(modelSwitchStdoutLabel(stdout)).toBe("Opus 4.8");
  });

  test("reads an effort echo", () => {
    const stdout =
      "<local-command-stdout>Set effort level to \u001b[1mmax\u001b[22m (this session only)</local-command-stdout>";
    expect(modelSwitchStdoutLabel(stdout)).toBe("max effort");
  });

  test("ignores a sentence that merely quotes the phrase", () => {
    expect(isModelSwitchStdout("the log said: Set model to Opus 4.8")).toBe(false);
  });
});
