import { describe, expect, test } from "bun:test";
import {
  classifyGlyphlessClientPaneState,
  classifyTmuxLiveState,
  clientOwnsSessionStore,
  extractTmuxLiveRegion,
} from "./daemon.js";
import { AGENT_CLIENTS } from "@codecast/shared/contracts";

// Real settled opencode 1.18.3 TUI (captured from a live pane, whitespace trimmed
// for readability). No ❯/› glyph anywhere — readiness is the footer `ctrl+p
// commands` and the empty-input placeholder `Ask anything…`. The composer box is
// drawn with ┃ and a ▀-block bottom rule (NOT ─/━), so extractTmuxLiveRegion finds
// no separator and drops to a tight tail that misses the footer entirely.
const OPENCODE_IDLE_PANE = [
  "                              ▄",
  "              █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█",
  "              █  █ █  █ █▀▀▀ █  █ █    █  █ █  █ █▀▀▀",
  "              ▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
  "  ┃",
  '  ┃  Ask anything... "What is the tech stack of this project?"',
  "  ┃",
  "  ┃  Build · Nano Banana Pro Vertex",
  "  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
  "  tab agents  ctrl+p commands",
  "      ● Tip Add .md files to .opencode/agents/ for specialized AI personas",
  "",
  "",
  "",
  "  /private/tmp/impl39174-oc:main                                    1.18.3",
].join("\n");

// Real settled pi 0.55.4 TUI. No ❯/› glyph either — readiness is the status bar's
// context-budget segment (`0.0%/200k`). pi DOES draw ─ rules, so its live region
// resolves to the status bar.
const PI_IDLE_PANE = [
  "  ────────────────────────────────────────────────────────────────",
  "  ────────────────────────────────────────────────────────────────",
  "  /private/tmp/impl39174-pi (main)",
  "  $0.000 (sub) 0.0%/200k (auto)                     (anthropic) claude-opus-4-6 • medium",
].join("\n");

const OC_READY = AGENT_CLIENTS.opencode.promptReadyPattern;
const PI_READY = AGENT_CLIENTS.pi.promptReadyPattern;

describe("classifyGlyphlessClientPaneState (ct-39174 first-message readiness)", () => {
  test("a settled opencode pane is idle (ready to inject), not unknown", () => {
    expect(classifyGlyphlessClientPaneState(OPENCODE_IDLE_PANE, OC_READY)).toBe("idle");
  });

  test("a settled pi pane is idle (ready to inject)", () => {
    expect(classifyGlyphlessClientPaneState(PI_IDLE_PANE, PI_READY)).toBe("idle");
  });

  test("a dead shell reads exited (refuse to paste into a bare prompt)", () => {
    expect(classifyGlyphlessClientPaneState("-bash: opencode: command not found\n$ ", OC_READY)).toBe("exited");
  });

  test("a still-booting pane (marker not yet rendered) defers as unknown", () => {
    expect(classifyGlyphlessClientPaneState("   \n  loading model catalog…\n", OC_READY)).toBe("unknown");
  });

  test("an active spinner reads busy so the interrupting Escape is skipped", () => {
    const busy = OPENCODE_IDLE_PANE.replace("● Tip Add", "⠙ working  ● Tip Add");
    expect(classifyGlyphlessClientPaneState(busy, OC_READY)).toBe("busy");
  });

  // The regression: the glyph-whitelist classifier used by the injection
  // pre-flight (ensureTmuxReady) reads the SAME settled opencode pane as
  // "unknown" and threw AGENT_UNKNOWN_STATE, so the first message never injected.
  test("the ❯/›-glyph classifier misreads the opencode pane as unknown (the bug this fixes)", () => {
    expect(classifyTmuxLiveState(extractTmuxLiveRegion(OPENCODE_IDLE_PANE))).toBe("unknown");
  });
});

describe("clientOwnsSessionStore (ct-39178 opencode.db corruption guard)", () => {
  test("claude and codex have a codecast JSONL generator — not store-owned", () => {
    expect(clientOwnsSessionStore("claude")).toBe(false);
    expect(clientOwnsSessionStore("codex")).toBe(false);
  });

  test("opencode/pi/cursor/gemini own their store — never regenerate a transcript", () => {
    expect(clientOwnsSessionStore("opencode")).toBe(true);
    expect(clientOwnsSessionStore("pi")).toBe(true);
    expect(clientOwnsSessionStore("cursor")).toBe(true);
    expect(clientOwnsSessionStore("gemini")).toBe(true);
  });

  test("an unknown type defaults to the safe (regenerable) claude path", () => {
    expect(clientOwnsSessionStore(undefined)).toBe(false);
    expect(clientOwnsSessionStore(null)).toBe(false);
  });
});
