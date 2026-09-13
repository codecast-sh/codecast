import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAgentLaunch, type AgentDefinitionSpec } from "@codecast/shared/contracts";
import { SAFE_MODE_DENY_RULES, SAFE_MODE_MANDATE, definitionLaunchFlags, definitionLaunchFragment } from "./agentLaunch.js";

const reviewer: AgentDefinitionSpec = {
  name: "reviewer",
  description: "d",
  tools: ["Read", "Grep"],
  disallowed_tools: ["Write"],
  system_prompt: "You review.",
};

describe("definitionLaunchFlags", () => {
  test("claude gets allow and deny lists and the appended prompt", () => {
    const flags = definitionLaunchFlags(resolveAgentLaunch(reviewer, {}, "claude"));
    expect(flags.args).toEqual(["--allowedTools", "Read,Grep", "--disallowedTools", "Write"]);
    expect(flags.appendSystemPrompt).toBe("You review.");
    expect(flags.dropped).toEqual([]);
  });
  test("read only adds the safe mode fence on claude and folds the mandate into the prompt", () => {
    const flags = definitionLaunchFlags(resolveAgentLaunch({ ...reviewer, mode: "propose" }, {}, "claude"));
    expect(flags.args.slice(2)).toEqual(["--disallowedTools", "Write", "Edit", "NotebookEdit", ...SAFE_MODE_DENY_RULES]);
    expect(flags.appendSystemPrompt).toBe(`You review.\n\n${SAFE_MODE_MANDATE}`);
  });
  test("pi honors the allowlist only and reports the denylist", () => {
    const flags = definitionLaunchFlags(resolveAgentLaunch({ ...reviewer, agent: "pi" }, {}, "claude"));
    expect(flags.args).toEqual(["--tools", "Read,Grep"]);
    expect(flags.dropped[0]).toContain("disallowed tools");
  });
  test("codex drops the whole tool policy but keeps the mandate", () => {
    const flags = definitionLaunchFlags(resolveAgentLaunch({ ...reviewer, agent: "codex", mode: "propose" }, {}, "claude"));
    expect(flags.args).toEqual([]);
    expect(flags.dropped.length).toBe(3);
    expect(flags.appendSystemPrompt).toContain(SAFE_MODE_MANDATE);
  });
});

describe("definitionLaunchFragment", () => {
  test("writes the prompt to a 0600 file and escapes the tool flags", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-prompts-"));
    const escape = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const { fragment, warning } = definitionLaunchFragment({ ...reviewer, mode: "propose" }, "claude", { dir, key: "conv-1", escape });
    expect(warning).toBeUndefined();
    expect(fragment).toContain(" '--allowedTools' 'Read,Grep'");
    expect(fragment).toContain("'Bash(git push:*)'");
    const file = path.join(dir, "conv-1.md");
    expect(fragment.endsWith(` --append-system-prompt "$(cat ${file})"`)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(`You review.\n\n${SAFE_MODE_MANDATE}`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
  test("a client with no prompt flag gets no file and a warning", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-prompts-"));
    const { fragment, warning } = definitionLaunchFragment(reviewer, "codex", { dir, key: "conv-2", escape: (s) => s });
    expect(fragment).toBe("");
    expect(warning).toContain("system prompt");
    expect(fs.existsSync(path.join(dir, "conv-2.md"))).toBe(false);
  });
});
