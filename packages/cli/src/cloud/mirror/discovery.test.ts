import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { collectProjectContext, collectProjectContextAsync, contextReferences } from "./discovery.js";
import { collectMirrorFiles } from "./inventory.js";
import { parseJsonLoose, renderGitconfig, transformForHost } from "./transform.js";

let home: string;
let root: string;
const write = (rel: string, bytes: string | Buffer) => {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
};

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "context-discovery-")));
  root = path.join(home, "src/repo");
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("portable context discovery", () => {
  test("every agent namespace keeps symlinked aliases, plugin assets and memory while runtime data stays out", async () => {
    write(".agents/skills/shared/SKILL.md", "[details](references/details.md)");
    write(".agents/skills/shared/references/details.md", "docs");
    for (const base of [".claude", ".codex", ".gemini", ".config/opencode"]) {
      fs.mkdirSync(path.join(home, base), { recursive: true });
      fs.symlinkSync(path.join(home, ".agents/skills"), path.join(home, base, "skills"));
    }
    fs.symlinkSync(path.join(home, ".agents/skills"), path.join(home, ".agents/skills/shared/cycle"));
    write(".codex/plugins/cache/plugin/skills/a/assets/image.png", Buffer.from([137, 80, 78, 71, 0, 255]));
    write(".codex/plugins/cache/plugin/.plugin-appserver/bin/large", "native runtime");
    write(".claude/scripts/worker", "#!/bin/sh\n");
    write(".claude/projects/local/memory/MEMORY.md", "remember");
    write(".claude/projects/local/transcript.jsonl", "transcript");
    write(".grok/auth.json", "secret");
    write(".grok/bundled/tool", Buffer.from([0x7f, 69, 76, 70, 1]));
    const inv = await collectMirrorFiles({ home, hostHome: "/home/u" });
    const paths = inv.entries.map((e) => e.path);
    for (const base of [".agents", ".claude", ".codex", ".gemini", ".config/opencode"]) {
      expect(paths).toContain(`${base}/skills/shared/SKILL.md`);
      expect(paths).toContain(`${base}/skills/shared/references/details.md`);
    }
    expect(paths).toContain(".codex/plugins/cache/plugin/skills/a/assets/image.png");
    expect(paths).toContain(".claude/scripts/worker");
    expect(paths).toContain(".claude/projects/local/memory/MEMORY.md");
    expect(paths.some((p) => /transcript|auth.json|large|bundled\/tool/.test(p))).toBe(false);
    expect(inv.skipped.some((s) => s.reason === "symlink cycle")).toBe(true);
  });

  test("reference closure includes interpreter args and transitive support but obeys exclusions before reading", async () => {
    write(".claude/settings.json", JSON.stringify({ statusLine: { command: `bash '${home}/src/agent-scripts/start.sh'` } }));
    write("src/agent-scripts/start.sh", `source '${home}/src/agent-scripts/helper.sh'\n`);
    write("src/agent-scripts/helper.sh", "helper");
    write(".codex/AGENTS.md", `Use ~/src/agent-scripts and ~/Library/Messages/Attachments. Read ~/.ssh/test-secret.\n`);
    write(".ssh/test-secret", "secret");
    write(".claude/skills/hidden/SKILL.md", "excluded");
    const inv = await collectMirrorFiles({ home, hostHome: "/home/u", config: { cloud_mirror_exclude: ".claude/skills/hidden/**" } });
    expect(inv.entries.map((e) => e.path)).toEqual(expect.arrayContaining(["src/agent-scripts/start.sh", "src/agent-scripts/helper.sh"]));
    expect(inv.entries.some((e) => /test-secret|hidden|Library/.test(e.path))).toBe(false);
    expect(inv.skipped.some((e) => e.path.startsWith("Library/") && e.reason === "denied")).toBe(true);
    expect(contextReferences(`bun '${home}/my scripts/entry.js'`, path.join(home, "rule.md"), home)).toContain(`${home}/my scripts/entry.js`);
  });

  test("ancestor symlinks cannot escape home or route a file through a denied ancestor", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-context-"));
    fs.mkdirSync(path.join(outside, "skills"));
    fs.writeFileSync(path.join(outside, "skills/SKILL.md"), "outside");
    fs.symlinkSync(outside, path.join(home, ".claude"));
    try {
      const inv = await collectMirrorFiles({ home, hostHome: "/home/u", config: { cloud_mirror_include: ".claude/skills/SKILL.md,../outside" } });
      expect(inv.entries).toEqual([]);
      expect(inv.skipped.some((s) => s.reason.includes("outside home"))).toBe(true);
      expect(inv.skipped.some((s) => s.reason === "unsafe path")).toBe(true);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  test("project collection preserves raw bytes, instruction hierarchy, ignored docs, MCP and external support mappings", async () => {
    execFileSync("git", ["init", "-q", root]);
    write("src/AGENTS.md", `Read ${home}/src/agent-scripts/runner\n`);
    write("src/agent-scripts/runner", `cat ${home}/src/repo/AGENTS.md\n`);
    write("src/repo/AGENTS.md", "root instructions");
    write("src/repo/CLAUDE.md", "alias");
    fs.unlinkSync(path.join(root, "CLAUDE.md"));
    fs.symlinkSync("AGENTS.md", path.join(root, "CLAUDE.md"));
    write("src/repo/.gitignore", ".claude/*.md\nnotes/\n");
    write("src/repo/.claude/plan-context.md", "working context");
    write("src/repo/packages/app/AGENTS.override.md", "nested override");
    write("src/repo/notes/local.md", "ignored docs");
    write("src/repo/.mcp.json", JSON.stringify({ mcpServers: { helper: { command: `${home}/src/agent-scripts/runner` } } }));
    write("src/repo/.env", "SECRET=1");
    const sync = collectProjectContext({ root, home });
    const asyncResult = await collectProjectContextAsync({ root, home });
    expect(asyncResult).toEqual(sync);
    expect(sync.files.find((f) => f.relativePath === "CLAUDE.md")?.bytes.toString()).toBe("root instructions");
    expect(sync.files.map((f) => f.relativePath)).toEqual(expect.arrayContaining([".mcp.json", ".claude/plan-context.md", "notes/local.md", "packages/app/AGENTS.override.md"]));
    expect(sync.files.find((f) => f.relativePath === "src/AGENTS.md")).toMatchObject({ scope: "home", sourcePath: path.join(home, "src/AGENTS.md") });
    expect(sync.files.find((f) => f.relativePath === "src/agent-scripts/runner")?.bytes.toString()).toContain(home);
    expect(sync.files.some((f) => f.relativePath === ".env")).toBe(false);
    expect(() => collectProjectContext({ root, home, maxBytes: 5 })).toThrow(/context exceeds/);
  });

  test("portable scripts, case variants, JSONC and MCP definitions remap without corrupting binary assets", () => {
    const ctx = { fromHome: home, toHome: "/home/u", pathMappings: [{ from: root, to: "/home/u/work/repo" }] };
    for (const rel of ["AGENTS.MD", "scripts/run.sh", "skills/a/README.md"]) {
      expect(transformForHost(rel, Buffer.from(`read ${root}/rules.md\n`), ctx)?.toString()).toBe("read /home/u/work/repo/rules.md\n");
    }
    const binary = Buffer.from([137, 80, 78, 71, 0, 255]);
    expect(transformForHost("assets/image.png", binary, ctx)).toEqual(binary);
    const jsonc = `{"mcp":{"one":{"command":"${root}/run","url":"https://x.test/a/*literal*/"}}, // comment\n}`;
    expect(parseJsonLoose(jsonc)).toHaveProperty("mcp.one.url", "https://x.test/a/*literal*/");
    expect(JSON.parse(transformForHost("opencode.jsonc", Buffer.from(jsonc), ctx)!.toString())).toHaveProperty("mcp.one.command", "/home/u/work/repo/run");
    const rendered = renderGitconfig([{ key: "alias.x", value: "z-first" }, { key: "alias.x", value: "a-last" }], ctx).text;
    expect(rendered.indexOf("z-first")).toBeLessThan(rendered.indexOf("a-last"));
  });
});

test("portable fixture assets do not need to parse, active JSON and TOML do", () => {
  const ctx = { fromHome: home, toHome: "/home/u" };
  for (const rel of [".codex/plugins/cache/p/fixtures/empty.json", "skills/a/assets/template.toml"]) {
    expect(transformForHost(rel, Buffer.from("{unfinished " + home + "/asset"), ctx)?.toString()).toBe("{unfinished /home/u/asset");
  }
  expect(transformForHost(".claude/settings.json", Buffer.from("{unfinished"), ctx)).toBeNull();
  expect(transformForHost(".mcp.json", Buffer.from("{unfinished"), ctx)).toBeNull();
  expect(transformForHost(".codex/config.toml", Buffer.from("model ="), ctx)).toBeNull();
});

test("nested environment files and native build trees cannot enter through references or includes", async () => {
  write(".claude/skills/test/SKILL.md", "Read ~/.local/ignored/.env.production and ~/Library/Messages/example.\n");
  write(".local/ignored/.env.production", "PRIVATE=1");
  write("src/repo/ios/Pods/Dependency/README.md", "native dependency");
  const inv = await collectMirrorFiles({ home, hostHome: "/home/u", config: { cloud_mirror_include: ".local/ignored/.env.production" } });
  expect(inv.entries.some((f) => f.path.includes(".env"))).toBe(false);
  expect(collectProjectContext({ root, home }).files).toEqual([]);
});

test("unreadable source context fails but inaccessible prose examples are reported", async () => {
  write(".claude/skills/readme/SKILL.md", "Example: ~/src/agent-scripts/private.sh\n");
  write("src/agent-scripts/private.sh", "private");
  const support = path.join(home, "src/agent-scripts/private.sh");
  fs.chmodSync(support, 0o000);
  try {
    const optional = await collectMirrorFiles({ home, hostHome: "/home/u" });
    expect(optional.skipped.some((s) => s.reason.includes("optional reference inaccessible"))).toBe(true);
    write(".claude/settings.json", JSON.stringify({ statusLine: { command: `bash ${support}` } }));
    await expect(collectMirrorFiles({ home, hostHome: "/home/u" })).rejects.toThrow();
  } finally { fs.chmodSync(support, 0o600); }
});
