import { describe, expect, test } from "bun:test";
import { parseAgyModels } from "./modelInventory.js";
import { buildLaunchArgs } from "./launchCommand.js";
import { clientInstallSnippet } from "./cloud/hostTools.js";
import { INSTALLABLE_CLIENTS } from "./remote/agentAuth.js";

// `agy models` on a starter-quota account (agy 1.5.14, 2026-11-21).
const STARTER = `Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`;

describe("antigravity model inventory and launch flags", () => {
  test("`agy models` becomes the account's base ids, best first", () => {
    expect(parseAgyModels(STARTER)).toEqual(["gemini-3.8-flash", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]);
  });

  const launch = (modelAlias: string) =>
    buildLaunchArgs({ agentType: "antigravity", configuredArgs: "", permFlags: null, defaultFlags: null, modelAlias, requestedEffort: "high" }).binaryArgs;
  test("--effort rides a Gemini model and never a Claude or GPT-OSS one, which agy refuses", () => {
    expect(launch("gemini-4-neon")).toEqual(["--model", "gemini-4-neon", "--effort", "high"]);
    expect(launch("claude-sonnet-4-6")).toEqual(["--model", "claude-sonnet-4-6"]);
    expect(launch("gpt-oss-120b-medium")).toEqual(["--model", "gpt-oss-120b-medium"]);
  });

  test("cloud hosts install agy with Google's installer and probe the agy binary", () => {
    expect(INSTALLABLE_CLIENTS).toContain("agy");
    expect(clientInstallSnippet("agy", "1.5.14")).toBe(
      "command -v agy >/dev/null 2>&1 || (curl -fsSL --connect-timeout 10 --max-time 300 https://antigravity.google/cli/install.sh | bash) >/dev/null 2>&1",
    );
  });
});
