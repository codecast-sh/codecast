// Regression coverage for the Phase-0 registry-driven dispatch (ct-39077): every
// daemon branch site that became an AGENT_CLIENTS lookup must reproduce the exact
// per-client value the old inline branch produced. These are pure assertions
// against the shared registry plus the small daemon-exported dispatch helpers, so
// they pin the byte-identical mandate without needing a live daemon.
import { test, expect, describe } from "bun:test";
import { AGENT_CLIENTS, type AgentClientId } from "@codecast/shared/contracts";

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
