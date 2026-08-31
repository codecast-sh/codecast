import { describe, expect, it } from "bun:test";
import {
  formatToolName,
  mcpToolNames,
  codexToolNames,
  grokToolNames,
  isShellTool,
  isReadTool,
  isEditTool,
  isWriteTool,
  isGrepTool,
  isGlobTool,
  isTodoTool,
  isAskTool,
  isAgentTool,
  toolPathFromInput,
  truncateStr,
  shortenUrl,
  getRelativePath,
  stripLineNumbers,
  isPlanWriteToolCall,
  toolSummary,
  toolVisual,
  toolIcon,
  structuredPayloadSummary,
  structuredPayloadKeysFromRaw,
  extractCodexExecActions,
  summarizeCodexExecActions,
  extractNestedActions,
  summarizeNestedActions,
  splitBrowserBatchResult,
  describeToolGroup,
  describeSmallToolGroup,
} from "./index";

const tc = (name: string, input: unknown) => ({
  name,
  input: typeof input === "string" ? input : JSON.stringify(input),
});

describe("formatToolName", () => {
  const cases: Array<[string, string]> = [
    // curated MCP table
    ["mcp__claude-in-chrome__computer", "Browser"],
    ["mcp__claude-in-chrome__tabs_create_mcp", "New Tab"],
    ["mcp__claude-in-chrome__read_console_messages", "Console"],
    // curated codex table
    ["shell_command", "Terminal"],
    ["container.exec", "Terminal"],
    ["apply_patch", "Patch"],
    ["fileChange", "Patch"],
    ["web_fetch", "Fetch"],
    // unknown mcp -> title-case the method segment
    ["mcp__some_server__do_a_thing", "Do A Thing"],
    ["mcp__server__method", "Method"],
    // grok snake_case ids collapse to the same family labels as claude/codex
    ["run_terminal_command", "Terminal"],
    ["read_file", "Read"],
    ["search_replace", "Edit"],
    ["list_dir", "List"],
    ["todo_write", "Todos"],
    ["ask_user_question", "Question"],
    ["get_command_or_subagent_output", "Wait"],
    ["spawn_subagent", "Agent"],
    ["Web search:", "Search"],
    // already-friendly names pass through unchanged
    ["Bash", "Bash"],
    ["Read", "Read"],
  ];
  it.each(cases)("formats %s -> %s", (input, expected) => {
    expect(formatToolName(input)).toBe(expected);
  });

  it("every curated table entry round-trips to its label", () => {
    for (const [id, label] of Object.entries(mcpToolNames)) {
      expect(formatToolName(id)).toBe(label);
    }
    for (const [id, label] of Object.entries(codexToolNames)) {
      expect(formatToolName(id)).toBe(label);
    }
    for (const [id, label] of Object.entries(grokToolNames)) {
      expect(formatToolName(id)).toBe(label);
    }
  });
});

describe("tool family classifiers", () => {
  it("puts grok ids in the same families as claude/codex synonyms", () => {
    expect(isShellTool("run_terminal_command")).toBe(true);
    expect(isShellTool("Bash")).toBe(true);
    expect(isShellTool("shell_command")).toBe(true);
    expect(isReadTool("read_file")).toBe(true);
    expect(isEditTool("search_replace")).toBe(true);
    expect(isWriteTool("write")).toBe(true);
    expect(isGrepTool("grep")).toBe(true);
    expect(isGlobTool("list_dir")).toBe(true);
    expect(isTodoTool("todo_write")).toBe(true);
    expect(isAskTool("ask_user_question")).toBe(true);
    expect(isAgentTool("spawn_subagent")).toBe(true);
    expect(isShellTool("read_file")).toBe(false);
  });

  it("reads grok's target_file / target_directory as the path", () => {
    expect(toolPathFromInput({ target_file: "/Users/ashot/src/codecast/a.ts" })).toBe("/Users/ashot/src/codecast/a.ts");
    expect(toolPathFromInput({ target_directory: "packages/cli/src" })).toBe("packages/cli/src");
    expect(toolPathFromInput({ file_path: "/x/a.ts" })).toBe("/x/a.ts");
  });
});

describe("truncateStr", () => {
  it("leaves short strings untouched", () => {
    expect(truncateStr("hello", 10)).toBe("hello");
    expect(truncateStr("hello", 5)).toBe("hello");
  });
  it("clips and appends an ellipsis past max", () => {
    expect(truncateStr("hello world", 5)).toBe("hello...");
  });
});

describe("shortenUrl", () => {
  it("drops www and keeps host for root path", () => {
    expect(shortenUrl("https://www.example.com/")).toBe("example.com");
    expect(shortenUrl("https://example.com")).toBe("example.com");
  });
  it("keeps a short path", () => {
    expect(shortenUrl("https://example.com/foo/bar")).toBe("example.com/foo/bar");
  });
  it("clips a long path", () => {
    const out = shortenUrl("https://example.com/" + "a".repeat(40));
    expect(out.startsWith("example.com/")).toBe(true);
    expect(out.endsWith("...")).toBe(true);
  });
  it("falls back to truncation for non-URLs", () => {
    expect(shortenUrl("not a url")).toBe("not a url");
    expect(shortenUrl("x".repeat(50))).toBe("x".repeat(40) + "...");
  });
});

describe("getRelativePath", () => {
  const cases: Array<[string, string]> = [
    ["/Users/ashot/src/codecast/packages/web/x.ts", "codecast/packages/web/x.ts"],
    ["/Users/ashot/Documents/notes.md", "Documents/notes.md"],
    ["/home/me/projects/app/main.rs", "app/main.rs"],
    ["/home/me/scratch/file.txt", "scratch/file.txt"],
    ["relative/already/short.ts", "relative/already/short.ts"],
    ["/a/b/c/d/e/f.ts", "d/e/f.ts"],
  ];
  it.each(cases)("%s -> %s", (input, expected) => {
    expect(getRelativePath(input)).toBe(expected);
  });
});

describe("stripLineNumbers", () => {
  it("strips the Read line-number gutter", () => {
    expect(stripLineNumbers("   42→const x = 1;")).toBe("const x = 1;");
    expect(stripLineNumbers("1→a\n  2→b")).toBe("a\nb");
  });
  it("strips the tab-separated gutter format", () => {
    expect(stripLineNumbers("   42\tconst x = 1;")).toBe("const x = 1;");
    expect(stripLineNumbers("1\ta\n  2\tb")).toBe("a\nb");
  });
  it("leaves lines without a gutter intact", () => {
    expect(stripLineNumbers("no gutter here")).toBe("no gutter here");
  });
});

describe("isPlanWriteToolCall", () => {
  it("is true only for a Write under .claude/plans/", () => {
    expect(isPlanWriteToolCall(tc("Write", { file_path: "/x/.claude/plans/p.md" }))).toBe(true);
  });
  it("is false for a Write elsewhere", () => {
    expect(isPlanWriteToolCall(tc("Write", { file_path: "/x/src/main.ts" }))).toBe(false);
  });
  it("is false for non-Write tools even under plans/", () => {
    expect(isPlanWriteToolCall(tc("Edit", { file_path: "/x/.claude/plans/p.md" }))).toBe(false);
  });
  it("is false for unparseable input", () => {
    expect(isPlanWriteToolCall(tc("Write", "{not json"))).toBe(false);
  });
});

describe("toolSummary", () => {
  const cases: Array<[string, unknown, string]> = [
    ["Read", { file_path: "/Users/ashot/src/codecast/a.ts" }, "codecast/a.ts"],
    ["Edit", { file_path: "/Users/ashot/src/codecast/a.ts" }, "codecast/a.ts"],
    ["file_read", { path: "/home/me/code/x/b.ts" }, "x/b.ts"],
    // opencode/pi: lowercase names + camelCase filePath
    ["read", { filePath: "/Users/ashot/src/codecast/a.ts" }, "codecast/a.ts"],
    ["edit", { filePath: "/Users/ashot/src/codecast/a.ts" }, "codecast/a.ts"],
    ["write", { filePath: "/home/me/code/x/b.ts" }, "x/b.ts"],
    ["bash", { command: "ls -la" }, "ls -la"],
    ["run_terminal_command", { command: "ls -la", description: "list files" }, "ls -la"],
    ["read_file", { target_file: "/Users/ashot/src/codecast/a.ts" }, "codecast/a.ts"],
    ["search_replace", { file_path: "/Users/ashot/src/codecast/a.ts" }, "codecast/a.ts"],
    ["list_dir", { target_directory: "/Users/ashot/src/codecast/packages/cli/src" }, "codecast/packages/cli/src"],
    ["todo_write", { todos: [1, 2] }, "2 tasks"],
    ["open_page", { url: "https://example.com/foo" }, "example.com/foo"],
    ["glob", { pattern: "**/*.ts" }, "**/*.ts"],
    ["grep", { pattern: "TODO" }, "TODO"],
    ["Bash", { command: "ls -la" }, "ls -la"],
    ["shell_command", { cmd: "pwd" }, "pwd"],
    ["Glob", { pattern: "**/*.ts" }, "**/*.ts"],
    ["Grep", { pattern: "TODO" }, "TODO"],
    ["WebSearch", { query: "react 19 release" }, "react 19 release"],
    ["WebFetch", { url: "https://www.example.com/" }, "example.com"],
    ["apply_patch", { input: "*** Update File: /Users/ashot/src/codecast/p.ts\n" }, "codecast/p.ts"],
    ["mcp__claude-in-chrome__computer", { action: "screenshot" }, "Screenshot"],
    ["mcp__claude-in-chrome__navigate", { url: "back" }, "Back"],
    ["mcp__claude-in-chrome__tabs_context_mcp", {}, "Get tabs"],
    ["Task", { description: "do the thing" }, "do the thing"],
    ["TodoWrite", { todos: [1, 2, 3] }, "3 tasks"],
    ["TaskUpdate", { taskId: "12", status: "done" }, "#12 → done"],
    ["SendMessage", { recipient: "bob" }, "to bob"],
    ["Skill", { skill: "commit" }, "/commit"],
    ["TeamDelete", {}, "Cleanup"],
    ["StructuredOutput", { verdict: "SAFE", findings: [1, 2] }, "verdict: SAFE, findings[2]"],
  ];
  it.each(cases)("%s summarizes correctly", (name, input, expected) => {
    expect(toolSummary(tc(name, input))).toBe(expected);
  });

  it("returns '' for unparseable input", () => {
    expect(toolSummary(tc("Bash", "{bad"))).toBe("");
  });
  it("returns '' for a tool with no meaningful summary", () => {
    expect(toolSummary(tc("TaskList", {}))).toBe("");
  });
  it("falls back to the method segment for an unknown mcp tool", () => {
    expect(toolSummary(tc("mcp__svc__do_thing", {}))).toBe("do thing");
  });
});

describe("Codex exec envelopes", () => {
  it("recovers a single nested command and its argument from JSON-style source", () => {
    const outer = tc("exec", {
      input: 'const r = await tools.exec_command({"cmd":"rg -n \\"broker\\" backend/src","workdir":"/tmp"});\ntext(r.output);',
    });

    const actions = extractCodexExecActions(outer);
    expect(actions).toHaveLength(1);
    expect(actions[0].name).toBe("exec_command");
    expect(JSON.parse(actions[0].input)).toMatchObject({
      cmd: 'rg -n "broker" backend/src',
      workdir: "/tmp",
    });
    expect(toolSummary(outer)).toBe('Terminal · rg -n "broker" backend/src');
  });

  it("recovers parallel calls from ordinary JS object literals", () => {
    const outer = tc("exec", {
      input: `const results = await Promise.all([
        tools.exec_command({cmd: "git status --short", workdir: "/repo"}),
        tools.view_image({path: "/tmp/codecast/images/screenshot.png", detail: "original"}),
        tools.mcp__node_repl__js({code: "inspect()", title: "Inspect session UI"})
      ]);`,
    });

    const actions = extractCodexExecActions(outer);
    expect(actions.map(action => action.name)).toEqual([
      "exec_command",
      "view_image",
      "mcp__node_repl__js",
    ]);
    expect(JSON.parse(actions[0].input).cmd).toBe("git status --short");
    expect(JSON.parse(actions[1].input).path).toBe("/tmp/codecast/images/screenshot.png");
    expect(JSON.parse(actions[2].input).title).toBe("Inspect session UI");
    expect(summarizeCodexExecActions(actions)).toBe("3 actions · Terminal · Image · Browser");
    expect(toolSummary(outer)).toBe("3 actions · Terminal · Image · Browser");
  });

  it("does not mistake tool-looking text inside strings or comments for actions", () => {
    const outer = tc("exec", {
      input: `const sample = "tools.fake({cmd: 'nope'})";
        // tools.also_fake({})
        const r = await tools.exec_command({cmd: "echo tools.still_fake()"});`,
    });

    expect(extractCodexExecActions(outer).map(action => action.name)).toEqual(["exec_command"]);
  });

  it("preserves a direct string argument for nested custom tools", () => {
    const patch = "*** Begin Patch\\n*** Update File: src/a.ts\\n*** End Patch";
    const outer = tc("exec", {
      input: `await tools.apply_patch("${patch.replace(/\\/g, "\\\\")}");`,
    });
    const actions = extractCodexExecActions(outer);
    expect(actions).toHaveLength(1);
    expect(JSON.parse(actions[0].input).input).toBe(patch);
  });

  it("falls back to Actions when exec source is not present", () => {
    expect(formatToolName("exec")).toBe("Actions");
    expect(toolSummary(tc("exec", {}))).toBe("");
  });
});

describe("structuredPayloadSummary", () => {
  it("shows short scalars inline, array lengths, bare keys for the rest", () => {
    expect(
      structuredPayloadSummary({
        dimension: "completeness",
        verdict: "SAFE",
        findings: [{}, {}],
        reasoning: "a long explanation that easily exceeds the inline value limit",
        meta: { nested: true },
      }),
    ).toBe("dimension: completeness, verdict: SAFE, findings[2], reasoning, meta");
  });
  it("returns '' for an empty payload", () => {
    expect(structuredPayloadSummary({})).toBe("");
  });
  it("truncates the joined summary at 80 chars", () => {
    const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`key_number_${i}`, []]));
    const s = structuredPayloadSummary(wide);
    expect(s.length).toBeLessThanOrEqual(83); // 80 + "..."
  });
});

describe("structuredPayloadKeysFromRaw", () => {
  const payload = JSON.stringify({
    isReal: true,
    reason: "x".repeat(600),
    "quoted \\\" key": 1,
    extra: [1, 2, 3],
  });
  it("salvages top-level keys from a truncated JSON prefix", () => {
    expect(structuredPayloadKeysFromRaw(payload.slice(0, 500))).toBe("isReal, reason");
  });
  it("ignores nested keys and string values", () => {
    const raw = JSON.stringify({ dimension: "completeness", findings: [{ severity: "info" }], verdict: "SAFE" });
    expect(structuredPayloadKeysFromRaw(raw)).toBe("dimension, findings, verdict");
  });
  it("returns '' for garbage", () => {
    expect(structuredPayloadKeysFromRaw("not json at all")).toBe("");
  });
});

describe("toolVisual / toolIcon", () => {
  const cases: Array<[string, { icon: string; color: string }]> = [
    ["Bash", { icon: "terminal", color: "green" }],
    ["Read", { icon: "file-code-o", color: "blue" }],
    ["Grep", { icon: "search", color: "violet" }],
    ["Write", { icon: "pencil", color: "orange" }],
    ["WebFetch", { icon: "globe", color: "cyan" }],
    // opencode/pi lowercase tool ids resolve to the same visuals as their twins
    ["bash", { icon: "terminal", color: "green" }],
    ["run_terminal_command", { icon: "terminal", color: "green" }],
    ["read_file", { icon: "file-code-o", color: "blue" }],
    ["search_replace", { icon: "pencil", color: "orange" }],
    ["list_dir", { icon: "file-code-o", color: "blue" }],
    ["todo_write", { icon: "check-square-o", color: "magenta" }],
    ["read", { icon: "file-code-o", color: "blue" }],
    ["edit", { icon: "pencil", color: "orange" }],
    ["write", { icon: "pencil", color: "orange" }],
    ["grep", { icon: "search", color: "violet" }],
    ["glob", { icon: "search", color: "violet" }],
    ["webfetch", { icon: "globe", color: "cyan" }],
    ["TaskCreate", { icon: "tasks", color: "emerald" }],
    ["SendMessage", { icon: "comment", color: "amber" }],
    ["mcp__claude-in-chrome__computer", { icon: "desktop", color: "orange" }],
    ["mcp__claude-in-chrome__navigate", { icon: "chrome", color: "blue" }],
    ["mcp__claude-in-chrome__find", { icon: "search", color: "violet" }],
    ["mcp__some-other__thing", { icon: "plug", color: "cyan" }],
    ["StructuredOutput", { icon: "check-square-o", color: "cyan" }],
    ["TotallyUnknownTool", { icon: "cog", color: "textDim" }],
  ];
  it.each(cases)("%s -> visual", (name, expected) => {
    expect(toolVisual(name)).toEqual(expected as any);
  });

  it("toolIcon accepts both a name and a ToolCall-like", () => {
    expect(toolIcon("Bash")).toEqual({ icon: "terminal", color: "green" });
    expect(toolIcon(tc("Read", {}))).toEqual({ icon: "file-code-o", color: "blue" });
  });
});

describe("describeToolGroup", () => {
  it("counts a family, singular and plural", () => {
    expect(describeToolGroup("Bash", 1)).toBe("ran 1 command");
    expect(describeToolGroup("Bash", 4)).toBe("ran 4 commands");
    expect(describeToolGroup("run_terminal_command", 1)).toBe("ran 1 command");
    expect(describeToolGroup("Read", 3)).toBe("read 3 files");
    expect(describeToolGroup("read_file", 2)).toBe("read 2 files");
    expect(describeToolGroup("Grep", 2)).toBe("2 searches");
    expect(describeToolGroup("search_replace", 1)).toBe("1 edit");
  });

  it("falls back to the formatted tool name", () => {
    expect(describeToolGroup("mcp__claude-in-chrome__navigate", 1)).toBe("Navigate");
    expect(describeToolGroup("mcp__claude-in-chrome__navigate", 2)).toBe("Navigate ×2");
  });
});

describe("describeSmallToolGroup", () => {
  it("names a lone command instead of counting it", () => {
    expect(describeSmallToolGroup([tc("Bash", { command: "npm test" })])).toBe("ran npm test");
    expect(describeSmallToolGroup([tc("run_terminal_command", { command: "ls -la" })])).toBe("ran ls -la");
  });

  it("spends a whole line on a lone subject, and splits it across a pair", () => {
    const long = tc("Bash", { command: "cd packages/web && npx tsc --noEmit -p tsconfig.json --pretty false" });
    expect(describeSmallToolGroup([long])).toBe(
      "ran cd packages/web && npx tsc --noEmit -p tsconfig.json --pretty false",
    );
    expect(describeSmallToolGroup([long, long])).toBe(
      "ran cd packages/web && npx tsc --n... · cd packages/web && npx tsc --n...",
    );
  });

  it("states a repeated verb once", () => {
    expect(describeSmallToolGroup([
      tc("Bash", { command: "git status" }),
      tc("Bash", { command: "npm test" }),
    ])).toBe("ran git status · npm test");
    expect(describeSmallToolGroup([
      tc("Read", { file_path: "/Users/me/src/app/lib/foo.ts" }),
      tc("Bash", { command: "npm test" }),
    ])).toBe("read app/lib/foo.ts · ran npm test");
  });

  it("keeps a clipped path's filename, dropping leading directories", () => {
    const deep = tc("Edit", { file_path: "/Users/me/src/codecast/packages/cli/src/stateCommand.ts" });
    expect(describeSmallToolGroup([deep])).toBe("edited codecast/packages/cli/src/stateCommand.ts");
    expect(describeSmallToolGroup([deep, deep])).toBe(
      "edited cli/src/stateCommand.ts · cli/src/stateCommand.ts",
    );
  });

  it("collapses a multi-line command onto one line", () => {
    expect(describeSmallToolGroup([tc("Bash", { command: "cat <<'EOF'\n  hello\nEOF" })]))
      .toBe("ran cat <<'EOF' hello EOF");
  });

  it("gives up when a subject is missing, leaving the caller to count", () => {
    expect(describeSmallToolGroup([tc("Bash", { command: "" })])).toBe("");
    expect(describeSmallToolGroup([tc("Task", { description: "audit the feed" })])).toBe("");
    expect(describeSmallToolGroup([])).toBe("");
  });
});

describe("browser_batch envelopes", () => {
  const batch = tc("mcp__claude-in-chrome__browser_batch", {
    actions: [
      { name: "computer", input: { action: "left_click", coordinate: [660, 178], tabId: 5 } },
      { name: "computer", input: { action: "wait", duration: 3, tabId: 5 } },
      { name: "computer", input: { action: "screenshot", tabId: 5 } },
    ],
  });

  it("recovers the inner tools under their standalone MCP names", () => {
    const actions = extractNestedActions(batch);
    expect(actions.map(a => a.name)).toEqual([
      "mcp__claude-in-chrome__computer",
      "mcp__claude-in-chrome__computer",
      "mcp__claude-in-chrome__computer",
    ]);
    expect(actions.map(a => toolSummary(a))).toEqual(["Click (660, 178)", "Wait 3s", "Screenshot"]);
  });

  it("summarises a browser batch by its steps (labelled when the tool is not the pointer)", () => {
    expect(toolSummary(batch)).toBe("3 steps · Click (660, 178) · Wait 3s · Screenshot");
    const mixed = tc("mcp__claude-in-chrome__browser_batch", {
      actions: [
        { name: "navigate", input: { url: "https://example.com/x" } },
        { name: "computer", input: { action: "wait", duration: 6 } },
        { name: "get_page_text", input: {} },
      ],
    });
    expect(summarizeNestedActions(extractNestedActions(mixed))).toBe("3 steps · Navigate example.com/x · Wait 6s · Page Text Extract text");
    expect(formatToolName("mcp__claude-in-chrome__browser_batch")).toBe("Browser");
  });

  it("is empty for a non-wrapper and for unparseable input", () => {
    expect(extractNestedActions(tc("Bash", { command: "ls" }))).toEqual([]);
    expect(extractNestedActions({ name: "mcp__claude-in-chrome__browser_batch", input: "{\"actions\": [" })).toEqual([]);
  });

  it("splits a per-step result whether the extension sent lines or one glued string", () => {
    const lines = "[computer:left_click] Clicked at (660, 178)\n[computer:wait] Waited for 3 seconds\n[computer:screenshot] Successfully captured screenshot (1568x762, jpeg) - ID: ss_1\n\nTab Context:\n- Executed on tabId: 5";
    const glued = "[computer:left_click] Clicked at (660, 178)[computer:wait] Waited for 3 seconds[computer:screenshot] Successfully captured screenshot (1568x762, jpeg) - ID: ss_1\n\nTab Context:\n- Executed on tabId: 5";
    for (const content of [lines, glued]) {
      expect(splitBrowserBatchResult(content, 3)).toEqual([
        { output: "Clicked at (660, 178)", ok: true },
        { output: "Waited for 3 seconds", ok: true },
        { output: "Successfully captured screenshot (1568x762, jpeg) - ID: ss_1", ok: true },
      ]);
    }
  });

  it("marks the failing step, keeps earlier steps ok, and leaves later ones unrun", () => {
    const content = "[navigate] Navigated to https://x.test/a\n[computer:wait] Waited for 6 seconds\n\nactions[2] (get_page_text) failed: Permission denied for reading page content on this domain (2 completed, 0 remaining)";
    expect(splitBrowserBatchResult(content, 4)).toEqual([
      { output: "Navigated to https://x.test/a", ok: true },
      { output: "Waited for 6 seconds", ok: true },
      { output: "Permission denied for reading page content on this domain", ok: false },
      { output: "" },
    ]);
  });

  it("binds a first-step failure with no tagged output to step 0", () => {
    const content = "actions[0] (find) failed: There is no \"Fix\" element visible (0 completed, 0 remaining)";
    expect(splitBrowserBatchResult(content, 1)).toEqual([
      { output: "There is no \"Fix\" element visible", ok: false },
    ]);
  });

  it("returns blank outcomes for a result that has not arrived", () => {
    expect(splitBrowserBatchResult("", 2)).toEqual([{ output: "" }, { output: "" }]);
  });
});
