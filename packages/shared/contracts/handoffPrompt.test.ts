import { describe, expect, test } from "bun:test";
import { composeContextRecoveryPrompt, composeHandoffPrompt, describeAgentRun, isContextRecoveryPrompt } from "./handoffPrompt";

const source = {
  short_id: "jx7abcd",
  title: "Fix the auth race",
  agent_type: "claude_code",
  model: "opus",
  message_count: 143,
};
const brief = "Goal: fix the race.\n\nNext steps:\n1. Run the test.";

describe("composeHandoffPrompt", () => {
  test("names the source, its agent and model, and the pickup instruction", () => {
    const out = composeHandoffPrompt({ source, brief });
    expect(out.startsWith("# Handed off from jx7abcd: Fix the auth race\n")).toBe(true);
    expect(out).toContain("Ran on Claude (opus).");
    expect(out).toContain("pick up at the first next step");
    expect(out).toContain("## Brief\n\nGoal: fix the race.");
  });

  test("read-more carries the exact commands, the window notes and the message count", () => {
    const out = composeHandoffPrompt({ source, brief });
    expect(out).toContain("143 messages");
    expect(out).toContain("cast read jx7abcd 1:20");
    expect(out).toContain("cast read jx7abcd 124:143");
    expect(out).toContain("cast read jx7abcd N:M --full");
    expect(out).toContain("cast diff jx7abcd");
    expect(out).toContain("cast state show jx7abcd");
  });

  test("no task, no plan, no direction: none of those lines appear", () => {
    const out = composeHandoffPrompt({ source, brief });
    expect(out).not.toContain("cast task context");
    expect(out).not.toContain("cast plan context");
    expect(out).not.toContain("## Direction");
  });

  test("bound task and plan add their context commands", () => {
    const out = composeHandoffPrompt({ source: { ...source, task_short_id: "ct-42", plan_short_id: "pl-7" }, brief });
    expect(out).toContain("cast task context ct-42");
    expect(out).toContain("cast plan context pl-7");
  });

  test("direction is its own trailing section; blank direction is dropped", () => {
    const out = composeHandoffPrompt({ source, brief, direction: "Ship it by noon." });
    expect(out.trimEnd().endsWith("## Direction\n\nShip it by noon.")).toBe(true);
    expect(composeHandoffPrompt({ source, brief, direction: "   " })).not.toContain("## Direction");
  });

  test("a short transcript never asks for a window below message 1", () => {
    const out = composeHandoffPrompt({ source: { ...source, message_count: 5 }, brief });
    expect(out).toContain("cast read jx7abcd 1:5");
    expect(out).not.toContain("1:20");
    expect(out).toContain("5 messages");
  });

  test("untitled sessions and unknown agents still read", () => {
    const out = composeHandoffPrompt({ source: { short_id: "x", title: null, agent_type: "codex", model: null }, brief });
    expect(out).toContain("# Handed off from x: Untitled session");
    expect(out).toContain("Ran on Codex.");
    expect(describeAgentRun(undefined, undefined)).toBe("Claude");
  });
});

describe("composeContextRecoveryPrompt", () => {
  const latest = [
    { role: "user" as const, content: "Why has no market grown?", timestamp: Date.UTC(2026, 9, 13, 15) },
    { role: "assistant" as const, content: "Checking the cold engine logs.", timestamp: Date.UTC(2026, 9, 13, 15, 1) },
  ];

  test("names the same session, keeps the role, the brief and the latest messages verbatim", () => {
    const out = composeContextRecoveryPrompt({ source, brief, roleBrief: "You are the **Market Growth lead** (@growth) in Union.", latest });
    expect(isContextRecoveryPrompt(out)).toBe(true);
    expect(out.startsWith("# Context recovered: jx7abcd · Fix the auth race\n")).toBe(true);
    expect(out).toContain("You are session jx7abcd, continuing in a fresh context");
    expect(out).toContain("## Role\n\nYou are the **Market Growth lead**");
    expect(out).toContain("## Brief\n\nGoal: fix the race.");
    expect(out).toContain("### User · 2026-10-13T15:00:00.000Z\n\n```\nWhy has no market grown?\n```");
    expect(out).toContain("### You · 2026-10-13T15:01:00.000Z");
  });

  test("points at the session's own history with read, ask and search", () => {
    const out = composeContextRecoveryPrompt({ source, brief, latest });
    expect(out).toContain("This session's earlier transcript has 143 messages");
    expect(out).toContain("cast read jx7abcd 124:143");
    expect(out).toContain('cast read jx7abcd --ask "<question>"');
    expect(out).toContain('cast search "<topic>"');
    expect(out).not.toContain("## Role");
  });

  test("a quoted message with its own code fence stays one block", () => {
    const content = "Run this:\n```bash\nbun test\n```";
    const out = composeContextRecoveryPrompt({ source, brief, latest: [{ role: "user", content, timestamp: 0 }] });
    expect(out).toContain(`\`\`\`\`\n${content}\n\`\`\`\``);
  });

  test("ordinary text is not a recovery prompt", () => {
    expect(isContextRecoveryPrompt("# Context recovered")).toBe(false);
    expect(isContextRecoveryPrompt(composeHandoffPrompt({ source, brief }))).toBe(false);
  });
});
