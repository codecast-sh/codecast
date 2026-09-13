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

test("missing executable dependencies fail while prose and output directories remain optional", async () => {
  write(".claude/settings.json", JSON.stringify({ env: { OUTPUT: `${home}/not-created` }, statusLine: { command: `bash '${home}/My Scripts/start.sh'` } }));
  write("My Scripts/start.sh", "#!/bin/sh\n");
  await expect(collectMirrorFiles({ home, hostHome: "/home/u" })).resolves.toBeDefined();
  fs.unlinkSync(path.join(home, "My Scripts/start.sh"));
  await expect(collectMirrorFiles({ home, hostHome: "/home/u" })).rejects.toThrow("missing active context reference");
  write("src/repo/.mcp.json", JSON.stringify({ mcpServers: { local: { command: "node", args: [`${root}/missing-server.js`] } } }));
  expect(() => collectProjectContext({ root, home })).toThrow("missing active context reference");
  write("src/repo/.mcp.json", "{ broken");
  expect(() => collectProjectContext({ root, home })).toThrow("cannot parse active context config");
});

test("account data mentioned in prose is excluded while an explicit portable include is honored", async () => {
  write(".claude/skills/readme/SKILL.md", "Example: ~/Documents and ~/Pictures/private.png\n");
  write("Documents/context.md", "explicit context");
  write("Pictures/private.png", "personal");
  const skipped = await collectMirrorFiles({ home, hostHome: "/home/u" });
  expect(skipped.entries.some((e) => e.path.startsWith("Documents/") || e.path.startsWith("Pictures/"))).toBe(false);
  expect(skipped.skipped.some((e) => e.path === "Documents" && e.reason === "account data excluded")).toBe(true);
  const explicit = await collectMirrorFiles({ home, hostHome: "/home/u", config: { cloud_mirror_include: "Documents/context.md" } });
  expect(explicit.entries.find((e) => e.path === "Documents/context.md")?.bytes.toString()).toBe("explicit context");
});

test("explicit instruction imports are required while prose links and code examples remain optional", async () => {
  write(".claude/CLAUDE.md", "@docs/missing.md\n[optional](docs/optional.md)\n");
  await expect(collectMirrorFiles({ home, hostHome: "/home/u" })).rejects.toThrow("missing active context reference");
  write(".claude/docs/missing.md", "imported");
  await expect(collectMirrorFiles({ home, hostHome: "/home/u" })).resolves.toBeDefined();
  write("src/repo/AGENTS.MD", "@\"docs/my context.md\"\n");
  expect(() => collectProjectContext({ root, home })).toThrow("missing active context reference");
  write("src/repo/docs/my context.md", "project import");
  write("src/repo/docs/guide.md", "@missing/file.md\n");
  write("src/repo/CLAUDE.local.md", "`@missing/inline.md`\n```md\n@missing/example.md\n```\nAsk @reviewer.\n");
  await expect(collectProjectContextAsync({ root, home })).resolves.toBeDefined();
});

test("native application dependencies stay configured and report unsupported host paths", async () => {
  const command = `${home}/.codex/Desktop Client.app/Contents/MacOS/client`;
  write(".codex/config.toml", `[mcp_servers.desktop]\ncommand = ${JSON.stringify(command)}\n`);
  const inventory = await collectMirrorFiles({ home, hostHome: "/home/u" });
  expect(inventory.entries.find((entry) => entry.path === ".codex/config.toml")?.bytes.toString()).toContain(command);
  expect(inventory.warnings.some((warning) => warning.includes("unsupported host dependency") && warning.includes("Desktop Client.app"))).toBe(true);
});

test("escaped references cannot introduce backslashes or control characters into logical paths", () => {
  const source = path.join(home, ".codex/AGENTS.md");
  const refs = contextReferences(`Use \\"${home}/scripts/browser-service.mjs\\" and '${home}/scripts/control\rname'.`, source, home);
  expect(refs.some((ref) => /[\\\x00-\x1f\x7f]/.test(ref))).toBe(false);
  expect(contextReferences(`${home}/scripts/run.sh\\\n`, source, home)).toContain(path.join(home, "scripts/run.sh"));
});

test("service credentials, password stores and shell startup files cannot enter through references, includes or aliases", async () => {
  const denied = [".app-store-connect/AuthKey_test.p8", ".cloudflared/tunnel.json", ".convex/config.json", ".railway/config.json", ".fly/config.yml", ".bashrc", ".bash_profile", ".zshrc", "Dropbox/txt/pass.txt", "OneDrive/private.md", "keys/signing.p12", "other/pass.txt"];
  for (const rel of denied) write(rel, "private account data");
  write(".claude/skills/privacy/SKILL.md", denied.map((rel) => `Read ~/${rel}`).join("\n"));
  fs.symlinkSync(path.join(home, ".railway"), path.join(home, ".claude/skills/privacy/service-alias"));
  write("src/repo/scripts/tool.sh", "#!/bin/sh\nprintf 'portable script'\n");
  write("src/repo/docs/guide.md", denied.map((rel) => `Read ~/${rel}`).join("\n"));
  const config = { cloud_mirror_include: denied.join(",") };
  const inv = await collectMirrorFiles({ home, hostHome: "/home/u", config });
  expect(inv.entries.map((entry) => entry.path)).toEqual([".claude/skills/privacy/SKILL.md"]);
  expect(inv.skipped.some((entry) => entry.path.includes("service-alias") && entry.reason.includes("denied"))).toBe(true);
  const project = await collectProjectContextAsync({ root, home, config });
  expect(project.files.map((entry) => entry.relativePath)).toEqual(["docs/guide.md", "scripts/tool.sh"]);
});

test("unfamiliar credential files are excluded by content while active MCP definitions are scrubbed and retained", async () => {
  write(".claude/skills/security/SKILL.md", "Read ~/unknown/key.data and ~/unknown/connector.json and ~/unknown/run.sh.\n");
  write("unknown/key.data", "-----BEGIN PRIVATE KEY-----\nTEST_PRIVATE_MATERIAL\n-----END PRIVATE KEY-----\n");
  write("unknown/connector.json", JSON.stringify({ user: { accessToken: "opaque-random-credential-12345", refreshToken: "opaque-refresh-credential-12345" } }));
  write("unknown/run.sh", "export PROVIDER_API_KEY='opaque-random-credential-12345'\n");
  write(".mcp.json", JSON.stringify({ mcpServers: { tool: { command: "node", env: { API_KEY: "opaque-random-credential-12345", LANG: "C" } } } }));
  const inv = await collectMirrorFiles({ home, hostHome: "/home/u" });
  expect(inv.entries.some((entry) => entry.path.startsWith("unknown/"))).toBe(false);
  expect(inv.skipped.filter((entry) => /credential|private key/.test(entry.reason))).toHaveLength(3);
  const entry = inv.entries.find((entry) => entry.path === ".mcp.json")!;
  const transformed = transformForHost(entry.path, entry.bytes, { fromHome: home, toHome: "/home/u" })!.toString();
  expect(transformed).toContain('"tool"');
  expect(transformed).not.toContain("opaque-random");
  expect(transformForHost("unfamiliar.json", Buffer.from('{"auth":{"accessToken":"opaque-random-credential-12345"}}'), { fromHome: home, toHome: "/home/u" })).toBeNull();
});

test("required hooks fail if credentials or a deny rule prevent copying their dependencies", async () => {
  write("scripts/hook.sh", "export SERVICE_API_KEY='opaque-random-credential-12345'\n");
  write(".claude/settings.json", JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: `${home}/scripts/hook.sh` }] }] } }));
  await expect(collectMirrorFiles({ home, hostHome: "/home/u" })).rejects.toThrow("active context reference contains credential material");
  write("src/repo/.claude/settings.json", JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: `${home}/scripts/hook.sh` }] }] } }));
  expect(() => collectProjectContext({ root, home })).toThrow("active context reference contains credential material");
  write(".claude/settings.json", JSON.stringify({ statusLine: { command: `${home}/.railway/hook.sh` } }));
  await expect(collectMirrorFiles({ home, hostHome: "/home/u" })).rejects.toThrow("active context reference is denied");
  write("src/repo/.claude/settings.json", JSON.stringify({ statusLine: { command: `${home}/.railway/hook.sh` } }));
  await expect(collectProjectContextAsync({ root, home })).rejects.toThrow("active context reference is denied");
});

test("host-owned hooks removed by the settings transform are not required source dependencies", async () => {
  write("src/repo/.claude/settings.json", JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: `${home}/.codecast/orchestration/scripts/agent-complete.sh` }] }] } }));
  const context = await collectProjectContextAsync({ root, home });
  const settings = context.files.find((file) => file.relativePath === ".claude/settings.json")!;
  expect(JSON.parse(transformForHost(settings.relativePath, settings.bytes, { fromHome: home, toHome: "/home/u" })!.toString())).not.toHaveProperty("hooks");
});

test("Claude plugin catalogs and install registries stay host-owned while installed portable context remains stable", async () => {
  const runtime = [".claude/plugins/marketplaces/catalog/plugins/tool/README.md", ".claude/plugins/installed_plugins.json", ".claude/plugins/known_marketplaces.json"];
  for (const rel of runtime) write(rel, "{}");
  write(".claude/skills/helper/SKILL.md", "portable skill");
  write(".claude/docs/guide.md", "portable guide");
  write(".claude/plugins/cache/tool/1.0/skills/helper/SKILL.md", "installed skill");
  write(".claude/plugins/cache/tool/1.0/assets/icon.svg", "<svg/>");
  fs.symlinkSync(path.join(home, ".claude/plugins/marketplaces/catalog"), path.join(home, ".claude/docs/catalog-alias"));
  fs.symlinkSync(path.join(home, runtime[1]!), path.join(root, "registry-alias.json"));
  write("src/repo/AGENTS.md", `See ${runtime.map((rel) => `~/${rel}`).join(" and ")} or [registry](registry-alias.json).`);
  const config = { cloud_mirror_include: [...runtime, ".claude/docs/catalog-alias"].join(",") };
  const before = await collectMirrorFiles({ home, hostHome: "/home/u", config });
  expect(before.entries.map((entry) => entry.path)).toEqual([
    ".claude/docs/guide.md", ".claude/plugins/cache/tool/1.0/assets/icon.svg",
    ".claude/plugins/cache/tool/1.0/skills/helper/SKILL.md", ".claude/skills/helper/SKILL.md",
  ]);
  for (const rel of runtime) { write(rel, '{"updated":true}'); fs.chmodSync(path.join(home, rel), 0o755); }
  const after = await collectMirrorFiles({ home, hostHome: "/home/u", config });
  expect(after.entries).toEqual(before.entries);
  const project = await collectProjectContextAsync({ root, home, config });
  expect(project.files.map((file) => file.relativePath)).toEqual(["AGENTS.md"]);
});

test("Grok runtime registries stay excluded through includes and aliases while portable context remains", async () => {
  write(".grok/grove/pin_gc_orphans.json", JSON.stringify({ orphans: { "session-id": "runtime state" } }));
  write(".grok/last-copy.txt", "copied conversation");
  write(".grok/skills/helper/SKILL.md", "portable skill");
  write(".grok/docs/guide.md", "portable guide");
  fs.symlinkSync(path.join(home, ".grok/grove/pin_gc_orphans.json"), path.join(home, ".grok/docs/registry.json"));
  const result = await collectMirrorFiles({ home, hostHome: "/home/u", config: { cloud_mirror_include: ".grok/grove/pin_gc_orphans.json,.grok/docs/registry.json,.grok/last-copy.txt" } });
  expect(result.entries.map((entry) => entry.path)).toEqual([".grok/docs/guide.md", ".grok/skills/helper/SKILL.md"]);
});

test("Antigravity skills remain portable while binary conversations and runtime snapshots stay excluded", async () => {
  for (const rel of ["conversations/thread.pb", "implicit/thread.pb", "brain/task/task.md", "brain/task/image.png", "code_tracker/active/source.ts", "installation_id", "user_settings.pb"]) write(`.gemini/antigravity/${rel}`, "runtime state");
  write(".gemini/antigravity/skills/helper/SKILL.md", "portable skill");
  const result = await collectMirrorFiles({ home, hostHome: "/home/u", config: { cloud_mirror_include: ".gemini/antigravity/conversations/thread.pb,.gemini/antigravity/brain/task/task.md" } });
  expect(result.entries.map((entry) => entry.path)).toEqual([".gemini/antigravity/skills/helper/SKILL.md"]);
});

test("Claude state contributes only scrubbed MCP definitions and malformed source still fails", async () => {
  write(".claude.json", JSON.stringify({ oauthAccount: { accessToken: "private-session-token" }, history: ["private conversation"],
    mcpServers: { electron: { command: "node", env: { API_KEY: "opaque-credential-12345", LANG: "C" } } },
    projects: { [root]: { mcpServers: { linear: { type: "http", url: "https://mcp.example.test" } }, trust: true, history: ["private project history"] } } }));
  const inv = await collectMirrorFiles({ home, hostHome: "/home/u" });
  const entry = inv.entries.find((e) => e.path === ".claude.json")!;
  expect(entry.kind).toBe("claude-mcp");
  const projected = JSON.parse(entry.bytes.toString());
  expect(Object.keys(projected).sort()).toEqual(["mcpServers", "projects"]);
  expect(projected.mcpServers.electron).toEqual({ command: "node", env: { LANG: "C" } });
  expect(projected.projects[root]).toEqual({ mcpServers: { linear: { type: "http", url: "https://mcp.example.test" } } });
  expect(entry.bytes.toString()).not.toContain("private-session-token");
  expect(entry.bytes.toString()).not.toContain("private conversation");
  expect(entry.bytes.toString()).not.toContain("private project history");
  expect(entry.bytes.toString()).not.toContain("oauthAccount");
  write(".claude.json", "{malformed");
  await expect(collectMirrorFiles({ home, hostHome: "/home/u" })).rejects.toThrow("cannot parse Claude MCP source");
});
