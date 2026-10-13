import { describe, expect, test } from "bun:test";
import { getAgentArgs } from "./types.js";
import type { Config } from "./types.js";

// getAgentArgs is the ONE reader of per-client launch args: it prefers the open
// `agent_args` map and falls back to the deprecated `claude_args`/`codex_args`
// named fields so configs predating the map keep launching. These lock in that
// priority and the back-compat fallback.
describe("getAgentArgs", () => {
  test("agent_args map wins over the legacy named field", () => {
    const cfg = {
      agent_args: { claude: "--from-map" },
      claude_args: "--from-legacy",
    } as Config;
    expect(getAgentArgs(cfg, "claude")).toBe("--from-map");
  });

  test("falls back to legacy claude_args / codex_args when the map is absent", () => {
    expect(getAgentArgs({ claude_args: "--legacy-claude" } as Config, "claude")).toBe("--legacy-claude");
    expect(getAgentArgs({ codex_args: "--legacy-codex" } as Config, "codex")).toBe("--legacy-codex");
  });

  test("reads a map-only client that has no legacy field (cursor/gemini)", () => {
    const cfg = { agent_args: { gemini: "--yolo", cursor: "--fast" } } as Config;
    expect(getAgentArgs(cfg, "gemini")).toBe("--yolo");
    expect(getAgentArgs(cfg, "cursor")).toBe("--fast");
  });

  test("an explicit empty map entry wins and does NOT fall back to the legacy field", () => {
    const cfg = { agent_args: { claude: "" }, claude_args: "--legacy" } as Config;
    expect(getAgentArgs(cfg, "claude")).toBe("");
  });

  test("returns undefined when nothing is configured for the client", () => {
    expect(getAgentArgs({ claude_args: "--x" } as Config, "codex")).toBeUndefined();
    expect(getAgentArgs({} as Config, "cursor")).toBeUndefined();
    expect(getAgentArgs({} as Config, "claude")).toBeUndefined();
  });

  test("tolerates null / undefined config", () => {
    expect(getAgentArgs(null, "claude")).toBeUndefined();
    expect(getAgentArgs(undefined, "codex")).toBeUndefined();
  });
});
