import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_EXCLUDES, MIRROR_DENYLIST, MIRROR_SIZE_CAP, MIRROR_SOURCES, collectMirrorFiles, globToRegExp, isDeniedPath,
} from "./inventory";
import type { MirrorKind } from "./transform";

let home: string;
let savedHome: string | undefined;
let savedGitGlobal: string | undefined;

function write(rel: string, content: string | Buffer, mode = 0o644): void {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, { mode });
}

const hostHome = "/home/ubuntu";

async function collect(config: { cloud_mirror_exclude?: string; cloud_mirror_include?: string } = {}) {
  return collectMirrorFiles({ home, config, hostHome, gitEnv: { GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") } });
}

beforeEach(() => {
  savedHome = process.env.HOME;
  savedGitGlobal = process.env.GIT_CONFIG_GLOBAL;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mirror-inv-")));
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = path.join(home, ".gitconfig");
});

afterEach(() => {
  process.env.HOME = savedHome;
  if (savedGitGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedGitGlobal;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("globToRegExp", () => {
  test("*, ** and ? with the usual meanings", () => {
    expect(globToRegExp(".claude/skills/private-*").test(".claude/skills/private-x")).toBe(true);
    expect(globToRegExp(".claude/skills/private-*").test(".claude/skills/private-x/SKILL.md")).toBe(false);
    expect(globToRegExp(".claude/skills/private-*/**").test(".claude/skills/private-x/SKILL.md")).toBe(true);
    expect(globToRegExp("**/node_modules/**").test("node_modules/a")).toBe(true);
    expect(globToRegExp("**/node_modules/**").test(".claude/skills/x/node_modules/a/b")).toBe(true);
    expect(globToRegExp("**/*.log").test(".codex/x/y.log")).toBe(true);
    expect(globToRegExp("a?c").test("abc")).toBe(true);
    expect(globToRegExp("a?c").test("a/c")).toBe(false);
  });
});

describe("denylist", () => {
  test.each([
    ".claude/.credentials.json", ".claude.json", ".claude/history.jsonl", ".claude/projects/x/y.jsonl", ".claude/sessions/a",
    ".claude/session-env/a", ".claude/shell-snapshots/a", ".claude/file-history/a", ".claude/backups/a", ".claude/cache/a",
    ".claude/plugins/marketplaces/a", ".claude/plugins/repos/a", ".claude/plugins/cache/a", ".claude/plugins/installed_plugins.json",
    ".codex/auth.json", ".codex/state_5.sqlite", ".codex/logs_2.sqlite-wal", ".codex/sessions/a", ".codex/cache/a", ".codex/tmp/a",
    ".codex/skills/.system/x", ".codex/models_cache.json", ".codex/installation_id",
    ".gemini/oauth_creds.json", ".config/gh/hosts.yml", ".config/gcloud/x", ".ssh/id_ed25519", ".aws/credentials", ".gnupg/x",
    ".kube/config", ".docker/config.json", ".netrc", ".npmrc", ".pgpass", ".codecast/config.json",
    ".claude/skills/x/server.pem", ".claude/skills/x/id_rsa", ".claude/skills/x/private.key", ".claude/skills/x/credentials-prod.json",
  ])("%s is denied", (rel) => {
    expect(isDeniedPath(rel)).toBe(true);
  });

  test.each([
    ".claude/CLAUDE.md", ".claude/skills/x/SKILL.md", ".codex/config.toml", ".claude/plugins/known_marketplaces.json", ".claude/hooks/mine.sh",
    // Name globs (`id_*`, `*.pem`, `credentials*.json`) name files, never a directory on the way.
    ".claude/skills/id_generator/SKILL.md", ".claude/commands/id_utils/run.md", ".claude/skills/certs.pem/README.md", ".claude/skills/credentials-doc.json/x.md",
  ])("%s is allowed", (rel) => {
    expect(isDeniedPath(rel)).toBe(false);
  });

  test("a directory is only denied by a path entry, never by a name glob", () => {
    expect(isDeniedPath(".claude/skills/id_generator", true)).toBe(false);
    expect(isDeniedPath(".claude/skills/id_generator", false)).toBe(true);
    expect(isDeniedPath(".ssh", true)).toBe(true);
    expect(isDeniedPath(".claude/projects", true)).toBe(true);
  });

  test("the table lists every root the design names", () => {
    for (const p of [".ssh", ".aws", ".gnupg", ".kube", ".codecast", ".claude.json", ".codex/auth.json"]) expect(MIRROR_DENYLIST).toContain(p);
    expect(DEFAULT_EXCLUDES).toContain("**/node_modules/**");
  });
});

describe("collectMirrorFiles", () => {
  test("every present source is collected with its kind; denied and codecast-owned paths never are, even when included", async () => {
    write(".claude/CLAUDE.md", "# me\n");
    write(".claude/settings.json", "{}");
    write(".claude/settings.local.json", "{}");
    write(".claude/keybindings.json", "{}");
    write(".claude/agents/mine.md", "agent");
    write(".claude/agents/implementer.md", "owned");
    write(".claude/skills/mine/SKILL.md", "skill");
    write(".claude/skills/codecast-orchestrate/SKILL.md", "owned");
    write(".claude/commands/c.md", "cmd");
    write(".claude/prompts/p.md", "prompt");
    write(".claude/output-styles/o.md", "style");
    write(".claude/hooks/mine.sh", "#!/bin/sh\n", 0o755);
    write(".claude/hooks/stable-feed.sh", "owned", 0o755);
    write(".claude/hooks/thread-state.sh", "owned", 0o755);
    write(".claude/statusline.sh", "#!/bin/sh\n", 0o755);
    write(".claude/notes.txt", "not a script");
    write(".claude/plugins/known_marketplaces.json", "{}");
    write(".claude/plugins/installed_plugins.json", "{}");
    write(".claude/.credentials.json", "SECRET");
    write(".claude/history.jsonl", "SECRET");
    write(".claude/projects/x/y.jsonl", "SECRET");
    write(".claude/skills/mine/node_modules/x/index.js", "noise");
    write(".claude.json", "SECRET");
    write(".codex/AGENTS.md", "# codex\n");
    write(".codex/AGENTS.override.md", "# over\n");
    write(".codex/config.toml", "model = 'x'\n");
    write(".codex/hooks.json", "{}");
    write(".codex/prompts/p.md", "p");
    write(".codex/rules/r.md", "r");
    write(".codex/skills/s/SKILL.md", "s");
    write(".codex/skills/.system/x.md", "system");
    write(".codex/auth.json", "SECRET");
    write(".codex/state_5.sqlite", "db");
    write(".codex/sessions/a.jsonl", "SECRET");
    write(".grok/AGENTS.md", "# grok\n");
    write(".grok/config.toml", "x = 1\n");
    write(".grok/skills/g/SKILL.md", "g");
    write(".grok/hooks/h.json", "{}");
    write(".grok/user-settings.json", "{}");
    write(".grok/sessions/a", "SECRET");
    write(".gemini/GEMINI.md", "# gemini\n");
    write(".gemini/settings.json", "{}");
    write(".gemini/commands/c.toml", "c");
    write(".gemini/oauth_creds.json", "SECRET");
    write(".agents/skills/a/SKILL.md", "a");
    write(".config/opencode/opencode.json", "{}");
    write(".config/opencode/AGENTS.md", "# oc\n");
    write(".config/opencode/agent/a.md", "a");
    write(".config/opencode/command/c.md", "c");
    write(".config/opencode/plugins/mine.js", "js");
    write(".config/opencode/plugins/codecast-stable.js", "owned");
    write(".config/gh/hosts.yml", "SECRET");
    write(".ssh/id_ed25519", "SECRET");
    write(".aws/credentials", "SECRET");
    write(".codecast/config.json", "SECRET");
    write(".netrc", "SECRET");
    const inv = await collect({ cloud_mirror_include: ".ssh,.claude/.credentials.json,.claude.json,.codecast,.netrc,.codex/auth.json" });
    const byPath = new Map(inv.entries.map((e) => [e.path, e]));
    const expectKinds: Record<string, MirrorKind> = {
      ".claude/CLAUDE.md": "claude-md", ".claude/settings.json": "claude-settings", ".claude/settings.local.json": "claude-settings",
      ".claude/keybindings.json": "verbatim", ".claude/agents/mine.md": "verbatim", ".claude/skills/mine/SKILL.md": "verbatim",
      ".claude/commands/c.md": "verbatim", ".claude/prompts/p.md": "verbatim", ".claude/output-styles/o.md": "verbatim",
      ".claude/hooks/mine.sh": "verbatim", ".claude/statusline.sh": "verbatim", ".claude/plugins/known_marketplaces.json": "json-remap",
      ".codex/AGENTS.md": "agents-md", ".codex/AGENTS.override.md": "agents-md", ".codex/config.toml": "codex-toml", ".codex/hooks.json": "codex-hooks",
      ".codex/prompts/p.md": "verbatim", ".codex/rules/r.md": "verbatim", ".codex/skills/s/SKILL.md": "verbatim",
      ".grok/AGENTS.md": "agents-md", ".grok/config.toml": "toml-remap", ".grok/skills/g/SKILL.md": "verbatim", ".grok/hooks/h.json": "json-remap",
      ".grok/user-settings.json": "json-remap", ".gemini/GEMINI.md": "claude-md", ".gemini/settings.json": "gemini-settings", ".gemini/commands/c.toml": "verbatim",
      ".agents/skills/a/SKILL.md": "verbatim", ".config/opencode/opencode.json": "opencode-json", ".config/opencode/AGENTS.md": "agents-md",
      ".config/opencode/agent/a.md": "verbatim", ".config/opencode/command/c.md": "verbatim", ".config/opencode/plugins/mine.js": "verbatim",
    };
    for (const [p, kind] of Object.entries(expectKinds)) expect(byPath.get(p)?.kind, p).toBe(kind);
    expect(byPath.get(".claude/hooks/mine.sh")?.mode).toBe("0700");
    expect(byPath.get(".claude/agents/mine.md")?.mode).toBe("0600");
    const shipped = [...byPath.keys()];
    for (const p of shipped) {
      expect(p.includes("SECRET"), p).toBe(false);
      expect(byPath.get(p)!.bytes.toString(), p).not.toBe("SECRET");
      expect(byPath.get(p)!.bytes.toString(), p).not.toBe("owned");
    }
    for (const p of [
      ".claude/agents/implementer.md", ".claude/skills/codecast-orchestrate/SKILL.md", ".claude/hooks/stable-feed.sh", ".claude/hooks/thread-state.sh",
      ".claude/.credentials.json", ".claude/history.jsonl", ".claude/projects/x/y.jsonl", ".claude.json", ".claude/plugins/installed_plugins.json",
      ".claude/notes.txt", ".claude/skills/mine/node_modules/x/index.js",
      ".codex/auth.json", ".codex/state_5.sqlite", ".codex/sessions/a.jsonl", ".codex/skills/.system/x.md",
      ".grok/sessions/a", ".gemini/oauth_creds.json", ".config/opencode/plugins/codecast-stable.js",
      ".config/gh/hosts.yml", ".ssh/id_ed25519", ".aws/credentials", ".codecast/config.json", ".netrc",
    ]) expect(shipped, p).not.toContain(p);
    expect(inv.skipped.map((s) => s.path)).toEqual(expect.arrayContaining([".ssh", ".claude/.credentials.json", ".claude.json", ".netrc", ".codex/auth.json"]));
    expect(inv.skipped.find((s) => s.path === ".ssh")?.reason).toBe("denied");
    // .codecast is codecast-owned rather than merely denied: not shipped, not reported as a user mistake.
    expect(shipped.some((p) => p.startsWith(".codecast/"))).toBe(false);
    // Every source path in the table is exercised by this fixture or is an alternate spelling.
    const alternates = new Set([".grok/settings.json", ".config/opencode/opencode.jsonc"]);
    for (const src of MIRROR_SOURCES) {
      if (alternates.has(src.path)) continue;
      const hit = src.dir ? shipped.some((p) => p.startsWith(`${src.path}/`)) : shipped.includes(src.path);
      expect(hit, src.path).toBe(true);
    }
  });

  test("cloud_mirror_exclude globs remove entries and are reported", async () => {
    write(".claude/skills/private-x/SKILL.md", "p");
    write(".claude/skills/public/SKILL.md", "p");
    write(".codex/prompts/a.md", "a");
    const inv = await collect({ cloud_mirror_exclude: ".claude/skills/private-*/**, .codex/prompts/**" });
    expect(inv.entries.map((e) => e.path)).toEqual([".claude/skills/public/SKILL.md"]);
    expect(inv.excludesApplied.sort()).toEqual([".claude/skills/private-*/**", ".codex/prompts/**"]);
  });

  test("statusLine.command under ~/.claude adds that file with its exec bit", async () => {
    write(".claude/settings.json", JSON.stringify({ statusLine: { type: "command", command: "~/.claude/bin/status.sh --x" } }));
    write(".claude/bin/status.sh", "#!/bin/sh\n", 0o755);
    const inv = await collect();
    expect(inv.entries.find((e) => e.path === ".claude/bin/status.sh")).toMatchObject({ kind: "verbatim", mode: "0700" });
  });

  test("symlinks: in-home regular file followed; into a denied path refused with reason; out of home skipped; a cycle terminates", async () => {
    write("dotfiles/skills/real/SKILL.md", "real");
    write(".ssh/id_ed25519", "SECRET");
    write(".claude/.credentials.json", "SECRET");
    write(".claude.json", "SECRET");
    fs.mkdirSync(path.join(home, ".claude/skills"), { recursive: true });
    fs.symlinkSync(path.join(home, "dotfiles/skills/real"), path.join(home, ".claude/skills/linked"));
    fs.symlinkSync(path.join(home, ".ssh/id_ed25519"), path.join(home, ".claude/skills/key"));
    fs.symlinkSync(path.join(home, ".claude/.credentials.json"), path.join(home, ".claude/skills/creds"));
    fs.symlinkSync(path.join(home, ".claude.json"), path.join(home, ".claude/skills/cj"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-outside-"));
    fs.writeFileSync(path.join(outside, "x.md"), "outside");
    fs.symlinkSync(outside, path.join(home, ".claude/skills/out"));
    fs.symlinkSync(path.join(home, ".claude/skills"), path.join(home, ".claude/skills/loop"));
    try {
      const inv = await collect();
      expect(inv.entries.map((e) => e.path)).toEqual([".claude/skills/linked/SKILL.md"]);
      expect(inv.entries[0]!.bytes.toString()).toBe("real");
      const reasons = Object.fromEntries(inv.skipped.map((s) => [s.path, s.reason]));
      expect(reasons[".claude/skills/key"]).toMatch(/denied path \(\.ssh\/id_ed25519\)/);
      expect(reasons[".claude/skills/creds"]).toMatch(/denied path/);
      expect(reasons[".claude/skills/cj"]).toMatch(/denied path/);
      expect(reasons[".claude/skills/out"]).toBe("symlink resolves outside home");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a bundle over the cap is refused naming the biggest root", async () => {
    write(".claude/skills/big/blob.bin", Buffer.alloc(MIRROR_SIZE_CAP / 2 + 1024));
    write(".codex/skills/big/blob.bin", Buffer.alloc(MIRROR_SIZE_CAP / 2 + 1024));
    await expect(collect()).rejects.toThrow(/over the 64 MiB cap — largest: \.claude \(/);
  });

  test("gitconfig is rendered from the global config, identity reported but not shipped, global ignore rides along", async () => {
    fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Ashot\n\temail = a@b.c\n[alias]\n\tst = status\n[core]\n\texcludesfile = ~/.gitignore_global\n[credential]\n\thelper = osxkeychain\n");
    write(".gitignore_global", ".DS_Store\n");
    execFileSync("git", ["--version"]);
    const inv = await collect();
    const gc = inv.entries.find((e) => e.path === ".gitconfig");
    expect(gc?.kind).toBe("gitconfig");
    expect(gc!.bytes.toString()).toBe("[alias]\n\tst = status\n[core]\n\texcludesfile = /home/ubuntu/.gitignore_global\n");
    expect(gc!.bytes.toString()).not.toContain("a@b.c");
    expect(inv.gitIdentity).toEqual({ name: "Ashot", email: "a@b.c" });
    expect(inv.entries.find((e) => e.path === ".gitignore_global")).toMatchObject({ kind: "gitignore" });
  });

  test("a skill directory named like a key (id_generator) is collected; a key FILE inside a skill is not", async () => {
    write(".claude/skills/id_generator/SKILL.md", "gen\n");
    write(".claude/skills/id_generator/id_rsa", "SECRET");
    write(".claude/skills/certs.pem/SKILL.md", "pem dir\n");
    const inv = await collect();
    const shipped = inv.entries.map((e) => e.path);
    expect(shipped).toContain(".claude/skills/id_generator/SKILL.md");
    expect(shipped).toContain(".claude/skills/certs.pem/SKILL.md");
    expect(shipped).not.toContain(".claude/skills/id_generator/id_rsa");
    expect(inv.skipped.find((s) => s.path === ".claude/skills/id_generator/id_rsa")?.reason).toBe("denied");
  });

  test("an `includeIf gitdir:` profile resolves when collected from the repo being prepared; the repo's own config never ships", async () => {
    fs.writeFileSync(path.join(home, ".gitconfig"), `[alias]\n\tst = status\n[includeIf "gitdir:${home}/work/"]\n\tpath = ${home}/.gitconfig-work\n`);
    fs.writeFileSync(path.join(home, ".gitconfig-work"), "[pull]\n\trebase = true\n[alias]\n\tco = checkout\n");
    const repo = path.join(home, "work", "repo");
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo], { env: { ...process.env, HOME: home } });
    execFileSync("git", ["-C", repo, "config", "pull.ff", "only"], { env: { ...process.env, HOME: home } });
    execFileSync("git", ["-C", repo, "config", "alias.local", "log"], { env: { ...process.env, HOME: home } });
    const fromRepo = await collectMirrorFiles({ home, hostHome, localGitRoot: repo, gitEnv: { GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") } });
    const text = fromRepo.entries.find((e) => e.path === ".gitconfig")!.bytes.toString();
    expect(text).toContain("rebase = true");
    expect(text).toContain("co = checkout");
    expect(text).toContain("st = status");
    expect(text).not.toContain("includeif");
    expect(text).not.toContain("ff = only");
    expect(text).not.toContain("local = log");
    // A worktree of that repo resolves the same profile and excludes the same repo-local config.
    const wt = path.join(home, "work", "repo-wt");
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], { env: { ...process.env, HOME: home } });
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", wt], { env: { ...process.env, HOME: home } });
    const fromWorktree = await collectMirrorFiles({ home, hostHome, localGitRoot: wt, gitEnv: { GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") } });
    expect(fromWorktree.entries.find((e) => e.path === ".gitconfig")!.bytes.toString()).toBe(text);
    // Outside the profile's gitdir the work settings do not apply.
    const fromHome = await collect();
    const plain = fromHome.entries.find((e) => e.path === ".gitconfig")!.bytes.toString();
    expect(plain).toBe("[alias]\n\tst = status\n");
  });

  test("no global git config → no gitconfig entry and no identity", async () => {
    const inv = await collect();
    expect(inv.entries.find((e) => e.path === ".gitconfig")).toBeUndefined();
    expect(inv.gitIdentity).toEqual({});
  });
});
