// Regression coverage for the Phase-0 registry-driven dispatch (ct-39077): every
// daemon branch site that became an AGENT_CLIENTS lookup must reproduce the exact
// per-client value the old inline branch produced. These are pure assertions
// against the shared registry plus the small daemon-exported dispatch helpers, so
// they pin the byte-identical mandate without needing a live daemon.
import { test, expect, describe } from "bun:test";
import { AGENT_CLIENTS, type AgentClientId } from "@codecast/shared/contracts";
import {
  parseTranscriptFor,
  parseSessionFile,
  parseCodexSessionFile,
  parseGeminiSessionFile,
  parseCursorTranscriptFile,
} from "./parser.js";
import { classifyTranscriptTailFor, sessionProcessGrepToken } from "./daemon.js";

// ── Cluster 3: fresh-launch prompt-readiness pattern ────────────────────────
// The old ternary (daemon.ts fresh-launch site) was:
//   agentType === "codex"  ? />\s*$/
//   : agentType === "gemini" ? />\s*$|gemini/i
//   : /❯|⏵/            (claude AND cursor fall here)
describe("promptReadyPattern reproduces the fresh-launch ternary", () => {
  const oldTernary = (agentType: AgentClientId): RegExp =>
    agentType === "codex" ? />\s*$/ : agentType === "gemini" ? />\s*$|gemini/i : /❯|⏵/;

  for (const id of ["claude", "codex", "cursor", "gemini"] as AgentClientId[]) {
    test(`${id}: registry pattern === old ternary source+flags`, () => {
      const reg = AGENT_CLIENTS[id].promptReadyPattern;
      const old = oldTernary(id);
      expect(reg.source).toBe(old.source);
      expect(reg.flags).toBe(old.flags);
    });
  }

  // A few concrete pane samples to lock behavior, not just literals.
  test("codex matches a trailing '>' but not the bare chevron", () => {
    expect(AGENT_CLIENTS.codex.promptReadyPattern.test("some output\n> ")).toBe(true);
    expect(AGENT_CLIENTS.codex.promptReadyPattern.test("›")).toBe(false);
  });
  test("gemini matches a trailing '>' or the word gemini", () => {
    expect(AGENT_CLIENTS.gemini.promptReadyPattern.test("ready\n> ")).toBe(true);
    expect(AGENT_CLIENTS.gemini.promptReadyPattern.test("Gemini CLI")).toBe(true);
  });
  test("claude and cursor match the ❯/⏵ glyphs", () => {
    for (const id of ["claude", "cursor"] as AgentClientId[]) {
      expect(AGENT_CLIENTS[id].promptReadyPattern.test("❯ ")).toBe(true);
      expect(AGENT_CLIENTS[id].promptReadyPattern.test("⏵ ")).toBe(true);
    }
  });
});

// ── Cluster 6: status-reconcile classifier gate ─────────────────────────────
// The old gate was `agentType !== "claude" && agentType !== "codex"` -> skip, with
// `agentType === "codex" ? classifyCodexTranscriptTail : classifyTranscriptTail`.
// classifyTranscriptTailFor must resolve claude/codex to a classifier and
// cursor/gemini to undefined (the "defer" signal) — byte-for-byte the same gate.
describe("classifyTranscriptTailFor reproduces the reconcile gate", () => {
  test("claude and codex resolve to a classifier; cursor and gemini do not", () => {
    expect(typeof classifyTranscriptTailFor("claude")).toBe("function");
    expect(typeof classifyTranscriptTailFor("codex")).toBe("function");
    expect(classifyTranscriptTailFor("cursor")).toBeUndefined();
    expect(classifyTranscriptTailFor("gemini")).toBeUndefined();
  });

  test("claude classifier reads a claude JSONL tail (end_turn -> idle, tool_use -> active)", () => {
    const classify = classifyTranscriptTailFor("claude")!;
    expect(classify('{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[]}}')).toBe("idle");
    expect(classify('{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[]}}')).toBe("active");
  });

  test("codex classifier reads a codex event_msg tail (task_complete -> idle, task_started -> active)", () => {
    const classify = classifyTranscriptTailFor("codex")!;
    expect(classify('{"type":"event_msg","payload":{"type":"task_complete"}}')).toBe("idle");
    expect(classify('{"type":"event_msg","payload":{"type":"task_started"}}')).toBe("active");
  });
});

// ── Cluster 8: parseTranscriptFor dispatch ──────────────────────────────────
// parseTranscriptFor must route to exactly the per-client parser the old fixed
// call sites used, byte-for-byte identical output.
describe("parseTranscriptFor dispatches to the per-client parser", () => {
  const claudeJsonl = '{"type":"assistant","uuid":"u1","timestamp":"2026-01-01T00:00:00Z","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"hello"}]}}';
  const codexJsonl = '{"type":"response_item","timestamp":"2026-01-01T00:00:00Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}';
  const geminiJson = JSON.stringify({
    sessionId: "abc", projectHash: "ph", startTime: "2026-01-01T00:00:00Z", lastUpdated: "2026-01-01T00:00:00Z",
    messages: [{ id: "m1", timestamp: "2026-01-01T00:00:00Z", type: "user", content: [{ text: "yo" }] }],
  });
  const cursorTranscript = "user:\nhello there\nassistant:\nhi back";

  test("claude -> parseSessionFile", () => {
    expect(parseTranscriptFor("claude", claudeJsonl)).toEqual(parseSessionFile(claudeJsonl));
  });
  test("codex -> parseCodexSessionFile", () => {
    expect(parseTranscriptFor("codex", codexJsonl)).toEqual(parseCodexSessionFile(codexJsonl));
  });
  test("gemini -> parseGeminiSessionFile", () => {
    expect(parseTranscriptFor("gemini", geminiJson)).toEqual(parseGeminiSessionFile(geminiJson));
  });
  test("cursor -> parseCursorTranscriptFile", () => {
    expect(parseTranscriptFor("cursor", cursorTranscript)).toEqual(parseCursorTranscriptFile(cursorTranscript));
  });
});

// ── Cluster 5: process-table grep token ─────────────────────────────────────
// Old ternary #1: gemini -> "gemini", codex -> "codex", else -> "claude".
// Old ternary #2: gemini -> "gemini", codex -> "codex", else -> "/claude\b|claude-code".
// codex/gemini must now come from the registry binary; claude/cursor keep the
// caller's claude pattern (cursor falls through to it exactly as before).
describe("sessionProcessGrepToken reproduces both per-client grep ternaries", () => {
  const oldTernary1 = (a: AgentClientId) => (a === "gemini" ? "gemini" : a === "codex" ? "codex" : "claude");
  const oldTernary2 = (a: AgentClientId) => (a === "gemini" ? "gemini" : a === "codex" ? "codex" : "/claude\\b|claude-code");
  for (const id of ["claude", "codex", "cursor", "gemini"] as AgentClientId[]) {
    test(`${id}: matches both old ternaries`, () => {
      expect(sessionProcessGrepToken(id, "claude")).toBe(oldTernary1(id));
      expect(sessionProcessGrepToken(id, "/claude\\b|claude-code")).toBe(oldTernary2(id));
    });
  }
  test("codex and gemini tokens are sourced from the registry binary", () => {
    expect(sessionProcessGrepToken("codex", "claude")).toBe(AGENT_CLIENTS.codex.binary);
    expect(sessionProcessGrepToken("gemini", "claude")).toBe(AGENT_CLIENTS.gemini.binary);
  });
});
