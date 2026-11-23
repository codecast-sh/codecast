import { describe, test, expect } from "bun:test";
import { detectCliFlags } from "./parser.js";
import { codexLaunchFlags } from "./codexSessionMeta.js";

// Only a session a person runs at a terminal can hold a line typed there (convex lib/messageProvenance reads the mark).
describe("launch marks - who types a session's prompts", () => {
  const first = (entrypoint?: string) => JSON.stringify({ type: "user", ...(entrypoint ? { entrypoint } : {}), message: { role: "user", content: "ship it" } });
  test("Claude Code's interactive cli is marked --interactive; -p is --print; the Agent SDK, an unknown and a missing entrypoint carry neither", () => {
    expect(detectCliFlags(first("cli"))).toBe("--interactive");
    expect(detectCliFlags(first("sdk-cli"))).toBe("--print");
    for (const e of ["sdk-ts", "sdk-py", "claude-vscode", undefined]) expect(detectCliFlags(first(e))).toBeNull();
  });

  test("Codex's terminal UI and VS Code extension are marked --interactive; exec and spawned threads --print; an app-server thread neither", () => {
    expect(codexLaunchFlags({ originator: "codex_cli_rs", source: "cli" })).toBe("--interactive");
    expect(codexLaunchFlags({ originator: "codex_cli_rs", source: "vscode" })).toBe("--interactive");
    expect(codexLaunchFlags({ originator: "codex_exec", source: "exec" })).toBe("--print");
    expect(codexLaunchFlags({ originator: "codex_cli_rs", source: { subagent: "review" } })).toBe("--print");
    expect(codexLaunchFlags({ originator: "codecast", source: "vscode" })).toBeUndefined();
    expect(codexLaunchFlags(undefined)).toBeUndefined();
  });
});
