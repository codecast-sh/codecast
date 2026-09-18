import { describe, expect, test } from "bun:test";
import { buildHandoffRequest, formatHandoffRoster, handoffMode, resolveHandoffAgent } from "./handoffCommand.js";

const c = { green: "", cyan: "", dim: "", bold: "", yellow: "", reset: "" };

describe("handoffMode — the old document stays the default", () => {
  test("no flags, or -o alone, is the document", () => {
    expect(handoffMode({})).toBe("document");
    expect(handoffMode({ toFile: "/tmp/h.md" })).toBe("document");
    expect(handoffMode({ session: "abc" })).toBe("document");
  });

  test("--to, --model alone, --dry-run alone, or -m alone spawn", () => {
    expect(handoffMode({ to: "codex" })).toBe("spawn");
    expect(handoffMode({ model: "opus" })).toBe("spawn");
    expect(handoffMode({ dryRun: true })).toBe("spawn");
    expect(handoffMode({ message: "carry on" })).toBe("spawn");
  });
});

describe("resolveHandoffAgent", () => {
  test("--to same and an absent --to leave the agent to the server (the source's own)", () => {
    expect(resolveHandoffAgent("same")).toBeUndefined();
    expect(resolveHandoffAgent("SAME")).toBeUndefined();
    expect(resolveHandoffAgent(undefined)).toBeUndefined();
    expect(resolveHandoffAgent("")).toBeUndefined();
  });

  test("client names normalize to the convex spelling", () => {
    expect(resolveHandoffAgent("claude")).toBe("claude_code");
    expect(resolveHandoffAgent("Claude")).toBe("claude_code");
    expect(resolveHandoffAgent("claude_code")).toBe("claude_code");
    expect(resolveHandoffAgent("codex")).toBe("codex");
    expect(resolveHandoffAgent("gemini")).toBe("gemini");
  });

  test("an unknown agent fails loudly and lists the choices", () => {
    expect(() => resolveHandoffAgent("chatgpt")).toThrow('Unknown agent "chatgpt". One of: same, claude, codex');
  });
});

describe("buildHandoffRequest", () => {
  test("--to same --model opus sends the model and no agent", () => {
    expect(buildHandoffRequest({ to: "same", model: "opus" }, "src1234")).toEqual({
      conversation_id: "src1234",
      model: "opus",
    });
  });

  test("--model only (no --to) is the same as --to same", () => {
    expect(buildHandoffRequest({ model: "sonnet" }, "src1234")).toEqual({ conversation_id: "src1234", model: "sonnet" });
  });

  test("--to codex with direction, effort, account, device and dry-run", () => {
    expect(buildHandoffRequest(
      { to: "codex", effort: "high", account: "work", device: "nose", message: "  say hello and stop  ", dryRun: true },
      "src1234",
    )).toEqual({
      conversation_id: "src1234",
      agent_type: "codex",
      effort: "high",
      cc_account: "work",
      device: "nose",
      direction: "say hello and stop",
      dry_run: true,
    });
  });

  test("a blank -m sends no direction", () => {
    expect(buildHandoffRequest({ to: "gemini", message: "   " }, "x")).toEqual({ conversation_id: "x", agent_type: "gemini" });
  });
});

describe("formatHandoffRoster", () => {
  const result = {
    source: { conversation_id: "c1", short_id: "src1234", title: "T", agent_type: "claude_code", model: "opus", message_count: 10, project_path: "/Users/me/src/app" },
    prompt: "# Handed off…",
    brief: "…",
    brief_source: "model" as const,
    session: { conversation_id: "c2", short_id: "chl5678", agent_type: "codex", model: null, effort: null, project_path: "/Users/me/src/app" },
  };

  test("names both sessions, the agent, the dir, the pin, and tells the source to end its turn", () => {
    const out = formatHandoffRoster(result, c, "/Users/me");
    expect(out).toContain("handed off src1234 → chl5678 on Codex in ~/src/app");
    expect(out).toContain("brief: model-written");
    expect(out).toContain('pinned done: "Handed off to chl5678 on Codex"');
    expect(out).toContain("End your turn now. chl5678 continues the work; cast read chl5678");
  });

  test("a dry run prints the prompt and nothing else", () => {
    expect(formatHandoffRoster({ ...result, session: null }, c)).toBe("# Handed off…");
  });

  test("a fallback brief says so", () => {
    expect(formatHandoffRoster({ ...result, brief_source: "fallback" }, c)).toContain("brief: fallback");
  });
});
