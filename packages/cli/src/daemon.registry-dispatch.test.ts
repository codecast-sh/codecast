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
  parseOpencodeSessionFile,
  parseGrokSessionFile,
} from "./parser.js";
import { classifyGlyphlessClientPaneState, classifyTranscriptTailFor, sessionProcessGrepToken } from "./daemon.js";

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

  // grok renders a real ❯ composer, but the glyph stays visible for the WHOLE
  // turn (live pane capture, v1.0.5) — so grok classifies through the busy-first
  // whole-pane path, never the glyph whitelist. These samples pin that order.
  test("grok: busy chrome wins over the always-visible ❯ composer", () => {
    const p = AGENT_CLIENTS.grok.promptReadyPattern;
    // Settled composer (real capture shape): ready.
    const settled = "│ ❯ \nShift+Tab:mode  │  Ctrl+x:shortcuts";
    expect(p.test(settled)).toBe(true);
    expect(classifyGlyphlessClientPaneState(settled, p)).toBe("idle");
    // Mid-turn: ❯ still on screen + busy chrome — must be busy, not idle. Each
    // marker alone must trip it (the header spinner can be cropped out of a
    // short capture window).
    for (const busyLine of ["⠼ MCP (0/1) │ 7.4K / 500K", "Waiting for response… 4s", "[stop]", "Esc:cancel"]) {
      expect(classifyGlyphlessClientPaneState(`${busyLine}\n│ ❯ `, p)).toBe("busy");
    }
    // grok's IDLE hint text contains the word "interrupt" — it must NOT read
    // busy (the reason a generic /interrupt/ heuristic is banned for grok).
    expect(classifyGlyphlessClientPaneState("send a message to interrupt\n│ ❯ ", p)).toBe("idle");
  });

  // opencode is a NEW client (no old-ternary equivalent): its TUI shows no ❯/›, so
  // readiness keys off the settled-pane footer/placeholder captured from a real run.
  test("opencode matches the settled TUI footer/placeholder, not a loading pane", () => {
    const p = AGENT_CLIENTS.opencode.promptReadyPattern;
    expect(p.test("┃  Ask anything...\ntab agents  ctrl+p commands")).toBe(true);
    expect(p.test("Ask anything... \"Fix a TODO\"")).toBe(true);
    // A booting pane (bottom status bar only) must NOT read as ready.
    expect(p.test("/private/tmp/scratch:main                     1.0.167")).toBe(false);
  });
});

// ── Cluster 6: status-reconcile classifier gate ─────────────────────────────
// The old gate was `agentType !== "claude" && agentType !== "codex"` -> skip, with
// `agentType === "codex" ? classifyCodexTranscriptTail : classifyTranscriptTail`.
// classifyTranscriptTailFor must resolve claude/codex to a classifier and
// cursor/gemini to undefined (the "defer" signal) — byte-for-byte the same gate.
describe("classifyTranscriptTailFor reproduces the reconcile gate", () => {
  test("claude, codex and opencode resolve to a classifier; cursor and gemini do not", () => {
    expect(typeof classifyTranscriptTailFor("claude")).toBe("function");
    expect(typeof classifyTranscriptTailFor("codex")).toBe("function");
    expect(typeof classifyTranscriptTailFor("opencode")).toBe("function");
    expect(classifyTranscriptTailFor("cursor")).toBeUndefined();
    expect(classifyTranscriptTailFor("gemini")).toBeUndefined();
  });

  test("opencode classifier reads the newest message (completed -> idle, streaming -> active, user -> active)", () => {
    const classify = classifyTranscriptTailFor("opencode")!;
    expect(classify('{"role":"assistant","time":{"created":1,"completed":2}}')).toBe("idle");
    expect(classify('{"role":"assistant","time":{"created":1}}')).toBe("active");
    expect(classify('{"role":"user","time":{"created":1}}')).toBe("active");
    // Also accepts the assembled export snapshot — decides off the last message.
    expect(classify(JSON.stringify({ messages: [
      { info: { role: "user", time: { created: 1 } } },
      { info: { role: "assistant", time: { created: 2, completed: 3 } } },
    ] }))).toBe("idle");
    expect(classify("half-written{")).toBe("unknown");
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

  // grok's updates.jsonl envelope: {timestamp, method, params:{update:{sessionUpdate}}}.
  const grokLine = (update: Record<string, unknown>) =>
    JSON.stringify({ timestamp: 1772550000, method: "_x.ai/session/update", params: { sessionId: "s", update } });

  test("grok resolves to a classifier and reads the xAI turn markers", () => {
    const classify = classifyTranscriptTailFor("grok")!;
    // turn_completed is the durable turn-end signal -> idle, whatever stop_reason.
    expect(classify(grokLine({ sessionUpdate: "turn_completed", prompt_id: "p0", stop_reason: "end_turn" }))).toBe("idle");
    expect(classify(grokLine({ sessionUpdate: "turn_completed", prompt_id: "p0", stop_reason: "cancelled" }))).toBe("idle");
    // Post-turn housekeeping after the marker is scanned past.
    expect(classify([
      grokLine({ sessionUpdate: "turn_completed", prompt_id: "p0", stop_reason: "end_turn" }),
      grokLine({ sessionUpdate: "session_summary_generated" }),
    ].join("\n"))).toBe("idle");
    // Mid-turn shapes.
    expect(classify(grokLine({ sessionUpdate: "tool_call", toolCallId: "t1", title: "bash" }))).toBe("active");
    expect(classify(grokLine({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } }))).toBe("active");
    // A streaming chunk with no terminal marker defers (a crashed stream must
    // never read as active forever — claude convention).
    expect(classify(grokLine({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "…" } }))).toBe("unknown");
    // An unresolved pending_interaction = parked on a question/permission.
    expect(classify(grokLine({ sessionUpdate: "pending_interaction", interaction_id: "i1" }))).toBe("active");
    expect(classify([
      grokLine({ sessionUpdate: "turn_completed", prompt_id: "p0", stop_reason: "end_turn" }),
      grokLine({ sessionUpdate: "pending_interaction", interaction_id: "i1" }),
      grokLine({ sessionUpdate: "interaction_resolved", interaction_id: "i1" }),
    ].join("\n"))).toBe("idle");
    // Torn tail (mid-write) is skipped, never a failure.
    expect(classify(grokLine({ sessionUpdate: "turn_completed", prompt_id: "p0" }) + '\n{"timestamp":177')).toBe("idle");
    expect(classify("half-written{")).toBe("unknown");
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
  const opencodeSnapshot = JSON.stringify({
    info: { id: "ses_x" },
    messages: [{ info: { id: "msg_1", role: "user", time: { created: 1 } }, parts: [{ id: "prt_1", type: "text", text: "yo" }] }],
  });
  test("opencode -> parseOpencodeSessionFile", () => {
    expect(parseTranscriptFor("opencode", opencodeSnapshot)).toEqual(parseOpencodeSessionFile(opencodeSnapshot));
  });
  const grokUpdates = [
    '{"timestamp":1772550001,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi"},"_meta":{"modelId":"grok-4.6","promptIndex":0}}}}',
    '{"timestamp":1772550002,"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}',
    '{"timestamp":1772550003,"method":"_x.ai/session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p0","stop_reason":"end_turn"}}}',
  ].join("\n");
  test("grok -> parseGrokSessionFile", () => {
    expect(parseTranscriptFor("grok", grokUpdates)).toEqual(parseGrokSessionFile(grokUpdates));
    expect(parseGrokSessionFile(grokUpdates).length).toBeGreaterThan(0);
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
  test("codex, gemini and grok tokens are sourced from the registry binary", () => {
    expect(sessionProcessGrepToken("codex", "claude")).toBe(AGENT_CLIENTS.codex.binary);
    expect(sessionProcessGrepToken("gemini", "claude")).toBe(AGENT_CLIENTS.gemini.binary);
    // grok is a compiled Rust binary (ps comm "grok") — it must never fall
    // through to the claude pattern.
    expect(sessionProcessGrepToken("grok", "/claude\\b|claude-code")).toBe("grok");
  });
});
