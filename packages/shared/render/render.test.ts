import { describe, expect, it } from "bun:test";
import {
  formatToolName,
  mcpToolNames,
  codexToolNames,
  truncateStr,
  shortenUrl,
  getRelativePath,
  stripLineNumbers,
  isPlanWriteToolCall,
  toolSummary,
  toolVisual,
  toolIcon,
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
    // plain snake_case tool id
    ["read_file", "Read File"],
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

describe("toolVisual / toolIcon", () => {
  const cases: Array<[string, { icon: string; color: string }]> = [
    ["Bash", { icon: "terminal", color: "green" }],
    ["Read", { icon: "file-code-o", color: "blue" }],
    ["Grep", { icon: "search", color: "violet" }],
    ["Write", { icon: "pencil", color: "orange" }],
    ["WebFetch", { icon: "globe", color: "cyan" }],
    ["TaskCreate", { icon: "tasks", color: "emerald" }],
    ["SendMessage", { icon: "comment", color: "amber" }],
    ["mcp__claude-in-chrome__computer", { icon: "desktop", color: "orange" }],
    ["mcp__claude-in-chrome__navigate", { icon: "chrome", color: "blue" }],
    ["mcp__claude-in-chrome__find", { icon: "search", color: "violet" }],
    ["mcp__some-other__thing", { icon: "plug", color: "cyan" }],
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
