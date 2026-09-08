import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REFERENCES_SNIPPET, SNIPPET_CATALOG } from "@codecast/shared/contracts";
import { findOwnedSections } from "@platform/snippets";
import {
  GITCONFIG_BLOCK_END, GITCONFIG_BLOCK_START, MIRROR_LOCK_REL, MIRROR_STAMP_REL, applyMirrorBundle, applyStagingBundle,
  composeInstructionFile, mergeClaudeSettings, mergeCodexHooks, mergeCodexToml, mergeGitconfig, readStamp, stripGitconfigBlock, verifyMirrorStamp, withMirrorLock,
} from "./apply";
import { buildMirrorBundle, parseMirrorBundle, sha256, type BundleInput } from "./bundle";
import { ownedSectionSpecs, stripOwnedSections } from "./transform";

let home: string;

function write(rel: string, content: string | Buffer, mode = 0o644): void {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, { mode });
}
function read(rel: string): string {
  return fs.readFileSync(path.join(home, rel), "utf-8");
}
function modeOf(rel: string): number {
  return fs.statSync(path.join(home, rel)).mode & 0o777;
}

/** This box's host CLAUDE.md: every catalog section installed, no user text. */
function hostClaudeMd(): string {
  const sections = SNIPPET_CATALOG.filter((d) => d.section).map((d) => d.section!.body);
  return `${sections.join("")}${REFERENCES_SNIPPET}`.replace(/^\n+/, "");
}
function ownedCount(text: string): number {
  return ownedSectionSpecs().reduce((n, spec) => n + findOwnedSections(text, spec).length, 0);
}

const HOST_SETTINGS = {
  env: { CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" },
  model: "fable",
  hooks: {
    SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "/home/ubuntu/.claude/hooks/stable-feed.sh", timeout: 30 }] }],
    UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "/home/ubuntu/.claude/hooks/thread-state.sh", timeout: 10 }] }],
    Stop: [{ matcher: "", hooks: [{ type: "command", command: "/home/ubuntu/.claude/hooks/thread-state.sh", timeout: 10 }] }],
    SubagentStop: [{ matcher: "implementer|reviewer|critic", hooks: [{ type: "command", command: "~/.codecast/orchestration/scripts/agent-complete.sh", timeout: 10000 }] }],
  },
  skipDangerousModePermissionPrompt: true,
  agentPushNotifEnabled: true,
};
const HOST_CODEX_TOML = '[projects."/home/ubuntu/work/codecast"]\ntrust_level = "trusted"\n\n[features]\nhooks = true\n';
const HOST_CODEX_HOOKS = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/home/ubuntu/.codecast/hooks/stable-feed-codex.sh", additionalContextLimit: 0, timeout: 30 }] }] } };

function seedHost(): void {
  write(".claude/CLAUDE.md", hostClaudeMd());
  write(".claude/settings.json", JSON.stringify(HOST_SETTINGS, null, 4));
  write(".claude/hooks/stable-feed.sh", "#!/bin/sh\n", 0o755);
  write(".claude/hooks/thread-state.sh", "#!/bin/sh\n", 0o755);
  write(".codex/config.toml", HOST_CODEX_TOML);
  write(".codex/hooks.json", JSON.stringify(HOST_CODEX_HOOKS, null, 2));
  write(".codecast/config.json", JSON.stringify({ user_id: "u1" }));
}

const source = (device_id = "laptop-1") => ({ device_id, user_id: "u1", home: "/Users/ashot", platform: "darwin", cast_version: "1" });

async function bundleOf(entries: BundleInput[], opts: { device?: string; takeOver?: boolean; userId?: string; targetHome?: string } = {}) {
  const built = buildMirrorBundle(entries, {
    source: { ...source(opts.device), user_id: opts.userId ?? "u1" },
    target_home: opts.targetHome ?? home, managed_roots: [".claude", ".codex", ".grok", ".gemini", ".agents", ".config/opencode"], take_over: opts.takeOver,
  });
  return parseMirrorBundle(built.bytes);
}

const laptopUserMd = "# Ashot's rules\n\nAlways run the tests.\n\n## Memory\n\nMy own notes.\n";
function laptopEntries(): BundleInput[] {
  return [
    { path: ".claude/CLAUDE.md", kind: "claude-md", mode: "0600", bytes: Buffer.from(laptopUserMd) },
    { path: ".claude/settings.json", kind: "claude-settings", mode: "0600", bytes: Buffer.from(JSON.stringify({
      includeCoAuthoredBy: false,
      permissions: { allow: ["Bash(git *)"], additionalDirectories: ["/home/ubuntu/notes"] },
      statusLine: { type: "command", command: "/home/ubuntu/.claude/statusline.sh" },
      env: { MY_VAR: "1" },
      hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "/home/ubuntu/.claude/hooks/my-hook.sh" }] }] },
    })) },
    { path: ".claude/hooks/my-hook.sh", kind: "verbatim", mode: "0700", bytes: Buffer.from("#!/bin/sh\necho hi\n") },
    { path: ".claude/skills/mine/SKILL.md", kind: "verbatim", mode: "0600", bytes: Buffer.from("# skill\n") },
    { path: ".codex/config.toml", kind: "codex-toml", mode: "0600", bytes: Buffer.from('model = "gpt-5"\n\n[features]\nweb_search = true\n') },
    { path: ".codex/hooks.json", kind: "codex-hooks", mode: "0600", bytes: Buffer.from(JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/home/ubuntu/bin/mine.sh" }] }] } })) },
    { path: ".gitconfig", kind: "gitconfig", mode: "0600", bytes: Buffer.from("[alias]\n\tst = status\n[pull]\n\trebase = true\n") },
  ];
}

let refreshRuns = 0;
const refresh = () => { refreshRuns++; };
function apply(bundle: Awaited<ReturnType<typeof bundleOf>>, extra: Partial<Parameters<typeof applyMirrorBundle>[1]> = {}) {
  return applyMirrorBundle(bundle, { home, configUserId: "u1", previousStamp: readStamp(home), refresh, pinnedEnvKeys: [], ...extra });
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mirror-apply-")));
  refreshRuns = 0;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("composeInstructionFile", () => {
  test("user text first, then each of the host's owned blocks exactly once in original order (every catalog section)", () => {
    const host = hostClaudeMd();
    const n = ownedCount(host);
    expect(n).toBe(SNIPPET_CATALOG.filter((d) => d.section).length + 1);
    const out = composeInstructionFile(laptopUserMd, host);
    expect(out.startsWith("# Ashot's rules\n\nAlways run the tests.\n\n## Memory\n\nMy own notes.\n\n## ")).toBe(true);
    expect(ownedCount(out)).toBe(n);
    expect((out.match(/<!-- \/codecast-/g) ?? []).length).toBe(n);
    expect(out.indexOf("My own notes.")).toBeLessThan(out.indexOf("<!-- /codecast-"));
    // The owned tail is the host's text verbatim, in the same order.
    expect(out.slice(out.indexOf("## Visual Canvas"))).toBe(host.slice(host.indexOf("## Visual Canvas")));
    // A laptop user portion that still carries a stale codecast section loses it.
    const withOwned = laptopUserMd + SNIPPET_CATALOG.find((d) => d.slug === "visual")!.section!.body;
    expect(ownedCount(composeInstructionFile(withOwned, host))).toBe(n);
    expect(stripOwnedSections(withOwned)).not.toContain("Visual Canvas");
  });
  test("no host file → just the user portion; empty user portion → just the host blocks", () => {
    expect(composeInstructionFile(laptopUserMd, null)).toBe(laptopUserMd);
    expect(ownedCount(composeInstructionFile("", hostClaudeMd()))).toBe(ownedCount(hostClaudeMd()));
  });
});

describe("merges", () => {
  test("mergeClaudeSettings keeps host codecast hooks (matcher '' first, orchestration group kept), pins, host-only keys; adds the laptop's", () => {
    const laptop = JSON.parse(laptopEntries()[1]!.bytes.toString());
    const merged = mergeClaudeSettings(laptop, HOST_SETTINGS, home, ["OPENAI_API_KEY"]);
    expect(merged.model).toBe("fable");
    expect(merged.skipDangerousModePermissionPrompt).toBe(true);
    expect(merged.agentPushNotifEnabled).toBe(true);
    expect(merged.includeCoAuthoredBy).toBe(false);
    expect(merged.env).toEqual({ MY_VAR: "1", CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" });
    expect(merged.permissions).toEqual({ allow: ["Bash(git *)"], additionalDirectories: ["/home/ubuntu/notes"] });
    expect(merged.statusLine).toEqual({ type: "command", command: "/home/ubuntu/.claude/statusline.sh" });
    const hooks = merged.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    expect(hooks.SessionStart![0]!.matcher).toBe("");
    expect(hooks.SessionStart![0]!.hooks.map((h) => h.command)).toEqual(["/home/ubuntu/.claude/hooks/stable-feed.sh"]);
    expect(hooks.SessionStart![1]!.hooks.map((h) => h.command)).toEqual(["/home/ubuntu/.claude/hooks/my-hook.sh"]);
    // Host groups keep their exact shape (orchestration's PostCompact group has no matcher key).
    expect(Object.keys(hooks.SubagentStop![0]!)).toEqual(["matcher", "hooks"]);
    expect(hooks.UserPromptSubmit![0]!.hooks.map((h) => h.command)).toEqual(["/home/ubuntu/.claude/hooks/thread-state.sh"]);
    expect(hooks.Stop![0]!.hooks.map((h) => h.command)).toEqual(["/home/ubuntu/.claude/hooks/thread-state.sh"]);
    expect(hooks.SubagentStop![0]!.matcher).toBe("implementer|reviewer|critic");
    expect(JSON.stringify(merged)).not.toContain("/Users/");
  });

  test("a manifest-listed env key the agent-auth push installed survives the laptop's env", () => {
    const merged = mergeClaudeSettings({ env: { OPENAI_API_KEY: "laptop", A: "1" } }, { env: { OPENAI_API_KEY: "host" } }, home, ["OPENAI_API_KEY"]);
    expect(merged.env).toEqual({ OPENAI_API_KEY: "host", A: "1", CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" });
  });

  test("a model pin the laptop's model must not override, and a laptop model when the host has none", () => {
    expect(mergeClaudeSettings({ model: "opus" }, { model: "fable" }, home).model).toBe("fable");
    expect(mergeClaudeSettings({ model: "opus" }, {}, home).model).toBe("opus");
  });

  test("mergeCodexHooks keeps the ~/.codecast/hooks/stable-feed-codex.sh entry beside the laptop's", () => {
    const merged = mergeCodexHooks(JSON.parse(laptopEntries()[5]!.bytes.toString()), HOST_CODEX_HOOKS, home) as any;
    expect(merged.hooks.SessionStart[0].hooks.map((h: any) => h.command)).toEqual(["/home/ubuntu/.codecast/hooks/stable-feed-codex.sh"]);
    expect(merged.hooks.SessionStart[1].hooks.map((h: any) => h.command)).toEqual(["/home/ubuntu/bin/mine.sh"]);
    expect(merged.hooks.SessionStart[0].hooks[0].additionalContextLimit).toBe(0);
    expect(Object.keys(merged.hooks.SessionStart[0])).toEqual(["hooks"]);
  });

  test("mergeCodexToml keeps host [projects.*] and `[features] hooks = true`, takes the rest from the laptop", () => {
    const merged = mergeCodexToml('model = "gpt-5"\n\n[projects."/Users/ashot/x"]\ntrust_level = "trusted"\n\n[features]\nweb_search = true\nhooks = false\n', HOST_CODEX_TOML);
    expect(merged).toBe('model = "gpt-5"\n\n[features]\nweb_search = true\nhooks = true\n\n[projects."/home/ubuntu/work/codecast"]\ntrust_level = "trusted"\n');
    expect(mergeCodexToml('model = "x"\n', HOST_CODEX_TOML)).toBe('model = "x"\n\n[features]\nhooks = true\n\n[projects."/home/ubuntu/work/codecast"]\ntrust_level = "trusted"\n');
    expect(mergeCodexToml('model = "x"\n', null)).toBe('model = "x"\n');
  });

  test("Codex merge pins trust while portable MCP ownership is reconciled before the pin pass", () => {
    const input = 'model = "gpt-5"\n[mcp_servers.local]\ncommand = "node"\n';
    const merged = mergeCodexToml(input, HOST_CODEX_TOML);
    expect(merged).toContain('[mcp_servers.local]\ncommand = "node"');
    expect(merged).toContain('[projects."/home/ubuntu/work/codecast"]');
    expect(mergeCodexToml(merged, HOST_CODEX_TOML)).toBe(merged);
  });

  test("stripGitconfigBlock removes only the marker block and its separating blank line", () => {
    const withBlock = mergeGitconfig("[alias]\n\tst = status\n", "[user]\n\tname = host\n") + "[extra]\n\tx = 1\n";
    expect(stripGitconfigBlock(withBlock)).toBe("[user]\n\tname = host\n[extra]\n\tx = 1\n");
    expect(stripGitconfigBlock(mergeGitconfig("[alias]\n\tst = status\n", null))).toBe("");
    expect(stripGitconfigBlock("[user]\n\tname = host\n")).toBe("[user]\n\tname = host\n");
  });

  test("mergeGitconfig replaces a previous block and leaves text outside it", () => {
    const first = mergeGitconfig("[alias]\n\tst = status\n", "[user]\n\tname = host\n\temail = host@x\n");
    expect(first).toBe(`[user]\n\tname = host\n\temail = host@x\n\n${GITCONFIG_BLOCK_START}\n[alias]\n\tst = status\n${GITCONFIG_BLOCK_END}\n`);
    const second = mergeGitconfig("[pull]\n\trebase = true\n", first + "[extra]\n\tx = 1\n");
    expect(second).toBe(`[user]\n\tname = host\n\temail = host@x\n\n${GITCONFIG_BLOCK_START}\n[pull]\n\trebase = true\n${GITCONFIG_BLOCK_END}\n[extra]\n\tx = 1\n`);
    expect(mergeGitconfig("", null)).toBe(`${GITCONFIG_BLOCK_START}\n${GITCONFIG_BLOCK_END}\n`);
  });
});

describe("applyMirrorBundle", () => {
  test("first apply on this box's home: merges, modes, stamp; second apply is a no-op; refresh runs each time", async () => {
    seedHost();
    const r = await apply(await bundleOf(laptopEntries()));
    expect(r.refused).toBeUndefined();
    expect(r.errors).toEqual([]);
    expect(r.applied.sort()).toEqual([".claude/CLAUDE.md", ".claude/hooks/my-hook.sh", ".claude/settings.json", ".claude/skills/mine/SKILL.md", ".codex/config.toml", ".codex/hooks.json", ".gitconfig"]);
    expect(refreshRuns).toBe(1);
    const md = read(".claude/CLAUDE.md");
    expect(md.startsWith("# Ashot's rules")).toBe(true);
    expect(ownedCount(md)).toBe(ownedCount(hostClaudeMd()));
    const settings = JSON.parse(read(".claude/settings.json"));
    expect(settings.model).toBe("fable");
    expect(settings.agentPushNotifEnabled).toBe(true);
    expect(settings.hooks.SessionStart.map((g: any) => g.hooks.map((h: any) => h.command))).toEqual([["/home/ubuntu/.claude/hooks/stable-feed.sh"], ["/home/ubuntu/.claude/hooks/my-hook.sh"]]);
    expect(read(".codex/config.toml")).toContain('[projects."/home/ubuntu/work/codecast"]');
    expect(read(".codex/config.toml")).toContain("hooks = true");
    expect(read(".gitconfig")).toContain(GITCONFIG_BLOCK_START);
    expect(modeOf(".claude/hooks/my-hook.sh")).toBe(0o700);
    expect(modeOf(".claude/skills/mine/SKILL.md")).toBe(0o600);
    expect(modeOf(".claude/skills/mine")).toBe(0o700);
    expect(modeOf(".claude/skills")).toBe(0o700);
    expect(modeOf(MIRROR_STAMP_REL)).toBe(0o600);
    // An existing directory keeps its mode (seeded by mkdirSync with the default 0755 minus umask).
    expect(modeOf(".claude")).toBe(0o755 & ~process.umask());
    const stamp = readStamp(home)!;
    expect(stamp.source_device_id).toBe("laptop-1");
    expect(stamp.files[".claude/skills/mine/SKILL.md"]!.sha).toBe(sha256("# skill\n"));
    expect(stamp.managed_roots).toContain(".claude");

    const mtimes = new Map(Object.keys(stamp.files).map((p) => [p, fs.statSync(path.join(home, p)).mtimeMs]));
    const again = await apply(await bundleOf(laptopEntries()));
    expect(again.applied).toEqual([]);
    expect(again.unchanged).toBe(7);
    expect(again.host_edited).toEqual([]);
    expect(refreshRuns).toBe(2);
    for (const [p, m] of mtimes) expect(fs.statSync(path.join(home, p)).mtimeMs, p).toBe(m);
  });

  test("guards: other user, unprovisioned host, other device unless take_over — nothing written", async () => {
    seedHost();
    const before = read(".claude/CLAUDE.md");
    const other = await apply(await bundleOf(laptopEntries(), { userId: "u2" }));
    expect(other.refused).toBe("other_user");
    const unprov = await apply(await bundleOf(laptopEntries()), { configUserId: undefined });
    expect(unprov.refused).toBe("unprovisioned");
    expect(read(".claude/CLAUDE.md")).toBe(before);
    expect(readStamp(home)).toBeNull();
    expect(refreshRuns).toBe(0);

    await apply(await bundleOf(laptopEntries()));
    const second = await apply(await bundleOf(laptopEntries(), { device: "laptop-2" }));
    expect(second.refused).toBe("other_device");
    expect(readStamp(home)!.source_device_id).toBe("laptop-1");
    const took = await apply(await bundleOf(laptopEntries(), { device: "laptop-2", takeOver: true }));
    expect(took.refused).toBeUndefined();
    expect(readStamp(home)!.source_device_id).toBe("laptop-2");
  });

  test("a bundle remapped for another home is refused (other_home) — nothing written; a trailing slash is not a difference", async () => {
    seedHost();
    const before = read(".claude/settings.json");
    const r = await apply(await bundleOf(laptopEntries(), { targetHome: "/home/someone-else" }));
    expect(r.refused).toBe("other_home");
    expect(read(".claude/settings.json")).toBe(before);
    expect(readStamp(home)).toBeNull();
    expect(refreshRuns).toBe(0);
    const slashed = await apply(await bundleOf(laptopEntries(), { targetHome: `${home}/` }));
    expect(slashed.refused).toBeUndefined();
  });

  test("host-edited verbatim files are kept and reported on EVERY later apply — unrelated laptop changes included — including simultaneous laptop edits", async () => {
    seedHost();
    await apply(await bundleOf(laptopEntries()));
    const skill = ".claude/skills/mine/SKILL.md";
    write(skill, "# edited on the host\n");
    const r = await apply(await bundleOf(laptopEntries()));
    expect(r.host_edited).toEqual([skill]);
    expect(read(skill)).toBe("# edited on the host\n");
    // The stamp remembers what the MIRROR wrote, flagged, not the host's bytes.
    expect(readStamp(home)!.files[skill]).toMatchObject({ sha: sha256("# skill\n"), written: sha256("# skill\n"), host_edited: true, kind: "verbatim" });

    // Third apply, an unrelated laptop change (a new command): the edit survives.
    const unrelated = [...laptopEntries(), { path: ".claude/commands/x.md", kind: "verbatim" as const, mode: "0600" as const, bytes: Buffer.from("cmd\n") }];
    const r3 = await apply(await bundleOf(unrelated));
    expect(r3.applied).toEqual([".claude/commands/x.md"]);
    expect(r3.host_edited).toEqual([skill]);
    expect(read(skill)).toBe("# edited on the host\n");
    // Fourth, the same bundle again: still kept.
    const r4 = await apply(await bundleOf(unrelated));
    expect(r4.host_edited).toEqual([skill]);
    expect(read(skill)).toBe("# edited on the host\n");

    // The laptop copy changes: laptop wins, the flag clears.
    const changed = laptopEntries();
    changed[3]!.bytes = Buffer.from("# laptop v2\n");
    const r5 = await apply(await bundleOf(changed));
    expect(r5.host_edited).toEqual([skill]);
    expect(r5.applied).toEqual([]);
    expect(read(skill)).toBe("# edited on the host\n");
    expect(readStamp(home)!.complete).toBe(false);

    // The host puts the mirrored bytes back: no longer an edit, tracked normally again.
    write(skill, "# host edit again\n");
    expect((await apply(await bundleOf(changed))).host_edited).toEqual([skill]);
    write(skill, "# laptop v2\n");
    const r7 = await apply(await bundleOf(changed));
    expect(r7.host_edited).toEqual([]);
    expect(readStamp(home)!.files[skill]!.host_edited).toBeUndefined();
  });

  test("merged instruction user edits remain visible conflicts", async () => {
    seedHost();
    await apply(await bundleOf(laptopEntries()));
    write(".claude/CLAUDE.md", read(".claude/CLAUDE.md").replace("Always run the tests.", "Host says: never run tests."));
    const r = await apply(await bundleOf(laptopEntries()));
    expect(r.host_edited).toEqual([".claude/CLAUDE.md"]);
    expect(r.applied).toEqual([]);
    expect(read(".claude/CLAUDE.md")).toContain("Host says: never run tests.");
  });

  test("prune removes only stamped paths under managed roots, never a host-created or codecast-owned file", async () => {
    seedHost();
    write(".claude/skills/host-only/SKILL.md", "host's own\n");
    await apply(await bundleOf(laptopEntries()));
    const without = laptopEntries().filter((e) => e.path !== ".claude/skills/mine/SKILL.md" && e.path !== ".claude/hooks/my-hook.sh");
    const r = await apply(await bundleOf(without));
    expect(r.pruned.sort()).toEqual([".claude/hooks/my-hook.sh", ".claude/skills/mine/SKILL.md"]);
    expect(fs.existsSync(path.join(home, ".claude/skills/mine/SKILL.md"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude/skills/host-only/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude/hooks/stable-feed.sh"))).toBe(true);
    expect(readStamp(home)!.files[".claude/skills/mine/SKILL.md"]).toBeDefined();
    // The directory the prune emptied goes too; a directory with other files stays.
    expect(fs.existsSync(path.join(home, ".claude/skills/mine"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude/skills"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude/hooks"))).toBe(true);

    // A pruned-candidate the host edited meanwhile is kept — on this apply and
    // every later one: it is the host's file now and leaves the stamp.
    await apply(await bundleOf(laptopEntries()));
    write(".claude/skills/mine/SKILL.md", "host edit\n");
    const r2 = await apply(await bundleOf(without));
    expect(r2.pruned).toEqual([".claude/hooks/my-hook.sh"]);
    expect(r2.host_edited).toEqual([".claude/skills/mine/SKILL.md"]);
    expect(read(".claude/skills/mine/SKILL.md")).toBe("host edit\n");
    expect(readStamp(home)!.files[".claude/skills/mine/SKILL.md"]).toBeDefined();
    const r3 = await apply(await bundleOf(without));
    expect(r3.pruned).toEqual([]);
    expect(r3.host_edited).toEqual([".claude/skills/mine/SKILL.md"]);
    expect(read(".claude/skills/mine/SKILL.md")).toBe("host edit\n");

    // A file flagged host-edited while still shipped, then dropped by the laptop: kept as well.
    await apply(await bundleOf(laptopEntries()));
    write(".claude/skills/mine/SKILL.md", "host edit 2\n");
    expect((await apply(await bundleOf(laptopEntries()))).host_edited).toEqual([".claude/skills/mine/SKILL.md"]);
    const r4 = await apply(await bundleOf(without));
    expect(r4.pruned).toEqual([".claude/hooks/my-hook.sh"]);
    expect(read(".claude/skills/mine/SKILL.md")).toBe("host edit 2\n");
    expect((await apply(await bundleOf(without))).pruned).toEqual([]);
    expect(read(".claude/skills/mine/SKILL.md")).toBe("host edit 2\n");
  });

  test("prune never deletes a merged kind the host co-owns (codex trust + hooks, settings pins, CLAUDE.md sections); the gitconfig kind loses only its block", async () => {
    seedHost();
    write(".gitconfig", "[user]\n\tname = host\n\temail = host@x\n");
    await apply(await bundleOf(laptopEntries()));
    expect(read(".gitconfig")).toContain(GITCONFIG_BLOCK_START);
    const verbatimOnly = laptopEntries().filter((e) => e.kind === "verbatim");
    const r = await apply(await bundleOf(verbatimOnly));
    expect(r.pruned).toEqual([".claude/CLAUDE.md", ".claude/settings.json", ".codex/config.toml", ".codex/hooks.json", ".gitconfig"]);
    expect(r.errors).toEqual([]);
    expect(read(".codex/config.toml")).toContain('[projects."/home/ubuntu/work/codecast"]');
    expect(read(".codex/config.toml")).toContain("hooks = true");
    expect(JSON.parse(read(".claude/settings.json")).model).toBe("fable");
    expect(ownedCount(read(".claude/CLAUDE.md"))).toBe(ownedCount(hostClaudeMd()));
    expect(fs.existsSync(path.join(home, ".codex/hooks.json"))).toBe(true);
    expect(read(".gitconfig")).toBe("[user]\n\tname = host\n\temail = host@x\n");
    const stamp = readStamp(home)!;
    for (const p of [".codex/config.toml", ".claude/settings.json", ".claude/CLAUDE.md", ".codex/hooks.json", ".gitconfig"]) expect(stamp.files[p], p).toBeDefined();
    // Nothing more to strip the second time.
    expect((await apply(await bundleOf(verbatimOnly))).pruned).toEqual([]);
    // A host whose ~/.gitconfig held only the block ends up without the file.
    fs.writeFileSync(path.join(home, ".gitconfig"), "");
    await apply(await bundleOf(laptopEntries()));
    await apply(await bundleOf(verbatimOnly));
    expect(fs.existsSync(path.join(home, ".gitconfig"))).toBe(false);
  });

  test("a codecast-owned path in the bundle is refused per file; a symlinked parent or destination is refused per file", async () => {
    seedHost();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-out-"));
    fs.mkdirSync(path.join(home, ".claude/skills"), { recursive: true });
    fs.symlinkSync(outside, path.join(home, ".claude/skills/linkdir"));
    fs.writeFileSync(path.join(outside, "target.md"), "keep");
    fs.symlinkSync(path.join(outside, "target.md"), path.join(home, ".claude/link.md"));
    try {
      const r = await apply(await bundleOf([
        { path: ".claude/skills/codecast-orchestrate/SKILL.md", kind: "verbatim", mode: "0600", bytes: Buffer.from("x") },
        { path: ".claude/skills/linkdir/x.md", kind: "verbatim", mode: "0600", bytes: Buffer.from("x") },
        { path: ".claude/link.md", kind: "verbatim", mode: "0600", bytes: Buffer.from("x") },
        { path: ".claude/ok.md", kind: "verbatim", mode: "0600", bytes: Buffer.from("fine") },
      ]));
      expect(r.errors.map((e) => e.path).sort()).toEqual([".claude/link.md", ".claude/skills/codecast-orchestrate/SKILL.md", ".claude/skills/linkdir/x.md"]);
      expect(r.applied).toEqual([".claude/ok.md"]);
      expect(fs.readFileSync(path.join(outside, "target.md"), "utf-8")).toBe("keep");
      expect(fs.readdirSync(outside)).toEqual(["target.md"]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("withMirrorLock serialises two applies and breaks a stale lock whose pid is dead", async () => {
    const order: string[] = [];
    const a = withMirrorLock(home, async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 300)); order.push("a-end"); });
    await new Promise((r) => setTimeout(r, 50));
    const b = withMirrorLock(home, async () => { order.push("b-start"); order.push("b-end"); });
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
    expect(fs.existsSync(path.join(home, MIRROR_LOCK_REL))).toBe(false);

    // A dead holder: spawn a process, let it exit, use its pid.
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await new Promise((r) => dead.on("close", r));
    write(MIRROR_LOCK_REL, JSON.stringify({ pid: dead.pid, token: "stale" }));
    const started = Date.now();
    await withMirrorLock(home, async () => { order.push("c"); });
    expect(order).toContain("c");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fs.existsSync(path.join(home, MIRROR_LOCK_REL))).toBe(false);

    // Two waiters both judge a dead holder stale: only the stale lock goes, the
    // one the winner created in its place is respected by the loser.
    write(MIRROR_LOCK_REL, JSON.stringify({ pid: dead.pid, token: "stale" }));
    const seq: string[] = [];
    const w1 = withMirrorLock(home, async () => { seq.push("w1-start"); await new Promise((r) => setTimeout(r, 400)); seq.push("w1-end"); });
    const w2 = withMirrorLock(home, async () => { seq.push("w2-start"); seq.push("w2-end"); });
    await Promise.all([w1, w2]);
    expect(seq).toEqual(["w1-start", "w1-end", "w2-start", "w2-end"]);
    expect(fs.existsSync(path.join(home, MIRROR_LOCK_REL))).toBe(false);
  });
});

describe("applyStagingBundle (--into)", () => {
  test("writes verbatim files with receiveFile's rules; the parser already refuses .git and ..", async () => {
    const into = path.join(home, "inputs");
    fs.mkdirSync(into, { mode: 0o700 });
    const built = buildMirrorBundle([
      { path: ".env", kind: "verbatim", mode: "0600", bytes: Buffer.from("SECRET=1\n") },
      { path: "secrets/nested/key", kind: "verbatim", mode: "0600", bytes: Buffer.from("k\n") },
      { path: "bin/run.sh", kind: "verbatim", mode: "0700", bytes: Buffer.from("#!/bin/sh\n") },
      { path: ".claude/settings.local.json", kind: "claude-settings", mode: "0600", bytes: Buffer.from("{\"env\":{}}") },
    ], { source: source(), target_home: into, managed_roots: [] });
    const r = applyStagingBundle(await parseMirrorBundle(built.bytes), { into });
    expect(r.errors).toEqual([]);
    expect(r.copied.sort()).toEqual([".claude/settings.local.json", ".env", "bin/run.sh", "secrets/nested/key"]);
    expect(fs.readFileSync(path.join(into, ".claude/settings.local.json"), "utf-8")).toBe("{\"env\":{}}");
    expect(fs.statSync(path.join(into, "bin/run.sh")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(into, "secrets/nested")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(into, ".env")).mode & 0o777).toBe(0o600);
    await expect(parseMirrorBundle(buildMirrorBundle([{ path: "ok", kind: "verbatim", mode: "0600", bytes: Buffer.alloc(0) }], { source: source(), target_home: into, managed_roots: [] }).bytes)).resolves.toBeTruthy();
    expect(() => buildMirrorBundle([{ path: ".git/config", kind: "verbatim", mode: "0600", bytes: Buffer.alloc(0) }], { source: source(), target_home: into, managed_roots: [] })).toThrow(/unsafe/);
    expect(() => buildMirrorBundle([{ path: "../x", kind: "verbatim", mode: "0600", bytes: Buffer.alloc(0) }], { source: source(), target_home: into, managed_roots: [] })).toThrow(/unsafe/);
  });

  test("a symlinked destination directory is refused without touching its target", async () => {
    const into = path.join(home, "inputs");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "stage-out-"));
    fs.mkdirSync(into);
    fs.symlinkSync(outside, path.join(into, "secrets"));
    try {
      const built = buildMirrorBundle([{ path: "secrets/key", kind: "verbatim", mode: "0600", bytes: Buffer.from("k") }], { source: source(), target_home: into, managed_roots: [] });
      const r = applyStagingBundle(await parseMirrorBundle(built.bytes), { into });
      expect(r.copied).toEqual([]);
      expect(r.errors[0]!.path).toBe("secrets/key");
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("prune refuses symlink ancestors and unsafe previous stamp paths without touching outside bytes", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-outside-"));
  try {
    const rel = ".claude/skills/mine/SKILL.md";
    await apply(await bundleOf([{ path: rel, kind: "verbatim", mode: "0600", bytes: Buffer.from("original") }]));
    fs.rmSync(path.join(home, ".claude/skills/mine"), { recursive: true });
    fs.writeFileSync(path.join(outside, "SKILL.md"), "original");
    fs.symlinkSync(outside, path.join(home, ".claude/skills/mine"));
    const result = await apply(await bundleOf([]));
    expect(result.errors.some((e) => e.path === rel && /symlink/.test(e.error))).toBe(true);
    expect(readStamp(home)?.complete).toBe(false);
    expect(verifyMirrorStamp(home)?.complete).toBe(false);
    expect(fs.readFileSync(path.join(outside, "SKILL.md"), "utf8")).toBe("original");
    const previousStamp = readStamp(home)!;
    previousStamp.files["../escape"] = { sha: sha256("x"), written: sha256("x"), mode: "0600" };
    previousStamp.managed_roots.push("..");
    const bad = await apply(await bundleOf([]), { previousStamp });
    expect(bad.errors.some((e) => e.path === "../escape" && /unsafe/.test(e.error))).toBe(true);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("partial apply and failed refresh cannot stamp a complete bundle", async () => {
  write(".claude/blocked", "file");
  const first = await apply(await bundleOf([{ path: ".claude/blocked/child", kind: "verbatim", mode: "0600", bytes: Buffer.from("x") }]));
  expect(first.errors.length).toBeGreaterThan(0);
  expect(readStamp(home)?.hash).toBe("");
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
  const refreshed = await apply(await bundleOf([]), { refresh: () => { throw new Error("refresh failed"); } });
  expect(refreshed.errors.some((e) => e.error.includes("refresh failed"))).toBe(true);
  expect(readStamp(home)?.hash).toBe("");
  const changed = await apply(await bundleOf([{ path: ".claude/settings.json", kind: "claude-settings", mode: "0600", bytes: Buffer.from('{"env":{"MIRRORED":"expected"}}') }]), {
    refresh: () => write(".claude/settings.json", '{"env":{"MIRRORED":"unexpected"}}'),
  });
  expect(changed.errors.some((e) => e.error.includes("mirrored content changed during refresh"))).toBe(true);
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
});

test("portable MCP edits and removals preserve unrelated host MCP and trust", async () => {
  seedHost();
  write('.codex/config.toml', HOST_CODEX_TOML + '\n[mcp_servers.host]\ncommand = "host-tool"\n');
  const file = (text: string) => [{ path: '.codex/config.toml', kind: 'codex-toml' as const, mode: '0600' as const, bytes: Buffer.from(text) }];
  await apply(await bundleOf(file('[mcp_servers.local]\ncommand = "first"\n')));
  expect(read('.codex/config.toml')).toContain('command = "host-tool"');
  await apply(await bundleOf(file('[mcp_servers.local]\ncommand = "second"\n')));
  expect(read('.codex/config.toml')).toContain('command = "second"');
  await apply(await bundleOf(file('model = "next"\n')));
  expect(read('.codex/config.toml')).not.toContain('[mcp_servers.local]');
  expect(read('.codex/config.toml')).toContain('command = "host-tool"');
  expect(read('.codex/config.toml')).toContain('trust_level = "trusted"');
});

test("removed instruction aliases delete only their link and dangling tombstones report drift", async () => {
  write(".claude/AGENTS.md", "rules\n");
  fs.symlinkSync("AGENTS.md", path.join(home, ".claude/CLAUDE.md"));
  const entries: BundleInput[] = [
    { path: ".claude/AGENTS.md", kind: "agents-md", mode: "0600", bytes: Buffer.from("rules\n") },
    { path: ".claude/CLAUDE.md", kind: "claude-md", mode: "0600", bytes: Buffer.from("rules\n") },
  ];
  expect((await apply(await bundleOf(entries))).errors).toEqual([]);
  const removed = await apply(await bundleOf(entries.slice(0, 1)));
  expect(removed.pruned).toEqual([".claude/CLAUDE.md"]);
  expect(fs.lstatSync(path.join(home, ".claude/CLAUDE.md"), { throwIfNoEntry: false })).toBeUndefined();
  expect(read(".claude/AGENTS.md")).toBe("rules\n");
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
  fs.symlinkSync("missing.md", path.join(home, ".claude/CLAUDE.md"));
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
  const drifted = await apply(await bundleOf(entries.slice(0, 1)));
  expect(drifted.host_edited).toEqual([".claude/CLAUDE.md"]);
  expect(readStamp(home)?.complete).toBe(false);
  expect(fs.readlinkSync(path.join(home, ".claude/CLAUDE.md"))).toBe("missing.md");
});

test("host MCP disabled pins keep canonical fields fresh, then command changes and pin removal recover without conflict", async () => {
  const { emptyOverrides, reconcilePins, readHostMcpOverrides, writeHostMcpOverrides } = await import("../hostMcpOverrides");
  seedHost();
  const definition = (command: string, timeout = 10) => `[mcp_servers."computer.ui"]\ncommand = "${command}"\nenabled = true\nstartup_timeout_sec = ${timeout}\n`;
  const file = (text: string): BundleInput[] => [{ path: ".codex/config.toml", kind: "codex-toml", mode: "0600", bytes: Buffer.from(text) }];
  const initial = await bundleOf(file(definition("mac-only")));
  expect((await apply(initial)).errors).toEqual([]);
  writeHostMcpOverrides(home, reconcilePins(emptyOverrides(), "codex", [{ name: "computer.ui", command: "mac-only", status: "unsupported" }], "now"));
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
  const disabled = await apply(initial);
  expect(disabled.host_edited).toEqual([]);
  expect(disabled.errors).toEqual([]);
  expect(read(".codex/config.toml")).toContain("enabled = false");
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
  const updated = await apply(await bundleOf(file(definition("mac-only", 30))));
  expect(updated.host_edited).toEqual([]);
  expect(updated.errors).toEqual([]);
  expect(read(".codex/config.toml")).toContain("startup_timeout_sec = 30");
  expect(read(".codex/config.toml")).toContain("enabled = false");
  const portable = await apply(await bundleOf(file(definition("portable"))));
  expect(portable.host_edited).toEqual([]);
  expect(portable.errors).toEqual([]);
  expect(readHostMcpOverrides(home).codex).toEqual({});
  expect(read(".codex/config.toml")).toContain("enabled = true");
  writeHostMcpOverrides(home, reconcilePins(emptyOverrides(), "codex", [{ name: "computer.ui", command: "portable", status: "unsupported" }], "now"));
  await apply(await bundleOf(file(definition("portable"))));
  writeHostMcpOverrides(home, emptyOverrides());
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
  const recovered = await apply(await bundleOf(file(definition("portable"))));
  expect(recovered.errors).toEqual([]);
  expect(recovered.host_edited).toEqual([]);
  expect(read(".codex/config.toml")).toContain("enabled = true");
  expect(read(".codex/config.toml")).toContain("trust_level");
});

test("Claude MCP pins omit the consumed server definition rather than inventing an enabled property", async () => {
  const { emptyOverrides, reconcilePins, writeHostMcpOverrides } = await import("../hostMcpOverrides");
  writeHostMcpOverrides(home, reconcilePins(emptyOverrides(), "claude", [{ name: "mac", command: "mac-only", status: "unsupported" }], "now"));
  const result = await apply(await bundleOf([{ path: ".claude/.mcp.json", kind: "json-remap", mode: "0600", bytes: Buffer.from(JSON.stringify({ mcpServers: { mac: { command: "mac-only" }, portable: { command: "linux-tool" } } })) }]));
  expect(result.errors).toEqual([]);
  expect(JSON.parse(read(".claude/.mcp.json"))).toEqual({ mcpServers: { portable: { command: "linux-tool" } } });
});

test("selective Claude MCP ownership updates and removes definitions while preserving host login, trust and edits", async () => {
  const root = path.join(home, "work/app");
  const local = { command: "portable-tool", args: ["first"] };
  const initialHost = { oauthAccount: { accessToken: "fixture-host-auth" }, numStartups: 17, mcpServers: { host: { command: "host-tool" } }, projects: { [root]: { hasTrustDialogAccepted: true, mcpServers: { host: { command: "project-host-tool" } } } } };
  write(".claude.json", JSON.stringify(initialHost));
  const file = (value: unknown): BundleInput[] => [{ path: ".claude.json", kind: "claude-mcp", mode: "0600", bytes: Buffer.from(JSON.stringify(value)) }];
  const first = { mcpServers: { local }, projects: { [root]: { mcpServers: { local } } } };
  expect((await apply(await bundleOf(file(first)))).errors).toEqual([]);
  expect(JSON.parse(read(".claude.json"))).toMatchObject(initialHost);
  const next = { mcpServers: { local: { command: "portable-tool", args: ["second"] } } };
  const updated = await apply(await bundleOf(file(next)));
  expect(updated.host_edited).toEqual([]);
  expect(updated.errors).toEqual([]);
  expect(JSON.parse(read(".claude.json")).projects[root]).toEqual(initialHost.projects[root]);
  const edited = JSON.parse(read(".claude.json"));
  edited.mcpServers.local.args = ["remote edit"];
  write(".claude.json", JSON.stringify(edited));
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
  const conflict = await apply(await bundleOf(file({ mcpServers: { local: { command: "portable-tool", args: ["third"] } } })));
  expect(conflict.host_edited).toEqual([".claude.json"]);
  expect(JSON.parse(read(".claude.json")).mcpServers.local.args).toEqual(["remote edit"]);
  expect(readStamp(home)?.complete).toBe(false);
  edited.mcpServers.local.args = ["third"];
  write(".claude.json", JSON.stringify(edited));
  expect((await apply(await bundleOf(file({ mcpServers: { local: { command: "portable-tool", args: ["third"] } } })))).host_edited).toEqual([]);
  expect((await apply(await bundleOf([]))).errors).toEqual([]);
  expect(JSON.parse(read(".claude.json"))).toEqual(initialHost);
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
  expect(readStamp(home)?.files[".claude.json"]?.source).not.toContain("fixture-host-auth");
});

test("Claude global and project pins mask only matching commands and recover when removed or changed", async () => {
  const { emptyOverrides, reconcilePins, readHostMcpOverrides, writeHostMcpOverrides } = await import("../hostMcpOverrides");
  const root = path.join(home, "work/app");
  const value = (command = "mac-only", timeout = 10) => ({ mcpServers: { mac: { command, timeout } }, projects: { [root]: { mcpServers: { mac: { command: "portable" } } } } });
  const file = (projection: unknown): BundleInput[] => [{ path: ".claude.json", kind: "claude-mcp", mode: "0600", bytes: Buffer.from(JSON.stringify(projection)) }];
  const pins = reconcilePins(emptyOverrides(), "claude", [{ name: "mac", command: "mac-only", status: "unsupported" }], "now");
  expect((await apply(await bundleOf(file(value())))).errors).toEqual([]);
  writeHostMcpOverrides(home, pins);
  const disabled = await apply(await bundleOf(file(value("mac-only", 20))));
  expect(disabled.errors).toEqual([]);
  expect(disabled.host_edited).toEqual([]);
  expect(JSON.parse(read(".claude.json")).mcpServers.mac).toBeUndefined();
  expect(JSON.parse(read(".claude.json")).projects[root].mcpServers.mac.command).toBe("portable");
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
  writeHostMcpOverrides(home, emptyOverrides());
  expect((await apply(await bundleOf(file(value("mac-only", 30))))).host_edited).toEqual([]);
  expect(JSON.parse(read(".claude.json")).mcpServers.mac.timeout).toBe(30);
  writeHostMcpOverrides(home, pins);
  expect((await apply(await bundleOf(file(value())))).errors).toEqual([]);
  const changed = await apply(await bundleOf(file(value("linux-tool"))));
  expect(changed.errors).toEqual([]);
  expect(changed.host_edited).toEqual([]);
  expect(JSON.parse(read(".claude.json")).mcpServers.mac.command).toBe("linux-tool");
  expect(readHostMcpOverrides(home).claude).toEqual({});
});

test("chunked verification covers a binary final chunk and mode drift on an unchanged bundle", async () => {
  const bytes = Buffer.alloc(2 * 64 * 1024 + 17, 0xff);
  const file: BundleInput = { path: ".agents/skills/asset.bin", kind: "verbatim", mode: "0600", bytes };
  const built = await bundleOf([file]);
  expect((await apply(built)).errors).toEqual([]);
  expect((await apply(built)).applied).toEqual([]);
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
  const drifted = Buffer.from(bytes);
  drifted[drifted.length - 1] = 0;
  write(file.path, drifted);
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
  expect((await apply(built)).host_edited).toEqual([file.path]);
  expect(fs.readFileSync(path.join(home, file.path)).equals(drifted)).toBe(true);
  write(file.path, bytes);
  fs.chmodSync(path.join(home, file.path), 0o700);
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
  expect((await apply(built)).applied).toEqual([file.path]);
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
});

test("pruning one harness keeps stale-pin removals already reconciled for the other harness", async () => {
  const { emptyOverrides, reconcilePins, readHostMcpOverrides, writeHostMcpOverrides } = await import("../hostMcpOverrides");
  const unsupported = [{ name: "mac", command: "mac-only", status: "unsupported" as const }];
  writeHostMcpOverrides(home, reconcilePins(reconcilePins(emptyOverrides(), "codex", unsupported, "now"), "claude", unsupported, "now"));
  const claude = (command: string): BundleInput => ({ path: ".claude.json", kind: "claude-mcp", mode: "0600", bytes: Buffer.from(JSON.stringify({ mcpServers: { mac: { command } } })) });
  expect((await apply(await bundleOf([claude("mac-only"), { path: ".codex/config.toml", kind: "codex-toml", mode: "0600", bytes: Buffer.from('[mcp_servers.mac]\ncommand = "mac-only"\n') }]))).errors).toEqual([]);
  const changed = await apply(await bundleOf([claude("portable")]));
  expect(changed.errors).toEqual([]);
  expect(changed.host_edited).toEqual([]);
  expect(readHostMcpOverrides(home)).toEqual(emptyOverrides());
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
});

test("identical project documentation aliases are satisfied without writes and remain byte/mode/target verified", async () => {
  const root = "work/app";
  const target = `${root}/packages/convex/convex/README.md`;
  const alias = `${root}/convex/README.md`;
  write(target, "# context\n", 0o600);
  fs.mkdirSync(path.dirname(path.join(home, alias)), { recursive: true });
  const link = path.relative(path.dirname(path.join(home, alias)), path.join(home, target));
  fs.symlinkSync(link, path.join(home, alias));
  const make = (include = true) => parseMirrorBundle(buildMirrorBundle(include ? [{ path: alias, kind: "verbatim", mode: "0600", bytes: Buffer.from("# context\n") }] : [], { source: source(), target_home: home, managed_roots: [root], project_roots: [root] }).bytes);
  const targetStat = fs.statSync(path.join(home, target));
  const first = await apply(await make());
  expect(first.errors).toEqual([]);
  expect(first.applied).toEqual([]);
  expect(first.unchanged).toBe(1);
  expect(fs.readlinkSync(path.join(home, alias))).toBe(link);
  expect(fs.statSync(path.join(home, target)).ino).toBe(targetStat.ino);
  expect(readStamp(home)?.files[alias]?.satisfied_alias).toEqual({ project: root, target });
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
  expect((await apply(await make())).errors).toEqual([]);
  write(target, "host edit\n");
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
  expect((await apply(await make())).errors.some((error) => /bytes or mode/.test(error.error))).toBe(true);
  expect(read(target)).toBe("host edit\n");
  write(target, "# context\n");
  fs.chmodSync(path.join(home, target), 0o700);
  expect((await apply(await make())).errors.some((error) => /bytes or mode/.test(error.error))).toBe(true);
  expect(modeOf(target)).toBe(0o700);
  fs.chmodSync(path.join(home, target), 0o600);
  expect((await apply(await make())).errors).toEqual([]);
  write(`${root}/other.md`, "# context\n", 0o600);
  fs.unlinkSync(path.join(home, alias));
  fs.symlinkSync("../other.md", path.join(home, alias));
  expect(verifyMirrorStamp(home)?.complete).toBe(false);
  expect((await apply(await make())).errors.some((error) => /target changed/.test(error.error))).toBe(true);
  fs.unlinkSync(path.join(home, alias));
  fs.symlinkSync(link, path.join(home, alias));
  expect((await apply(await make())).errors).toEqual([]);
  const pruned = await apply(await make(false));
  expect(pruned.errors).toEqual([]);
  expect(pruned.pruned).toEqual([alias]);
  expect(fs.lstatSync(path.join(home, alias), { throwIfNoEntry: false })).toBeUndefined();
  expect(read(target)).toBe("# context\n");
  expect(verifyMirrorStamp(home)?.complete).toBe(true);
});

test.each(["outside project", "outside home", "ancestor symlink", "chained symlink", "missing", "different bytes", "different mode", "non-verbatim"])("project alias satisfaction refuses %s without writing through it", async (scenario) => {
  const root = "work/app";
  const alias = `${root}/README.md`;
  let target = `${root}/docs/README.md`;
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mirror-alias-outside-")));
  try {
    if (scenario === "outside project") target = "work/sibling/README.md";
    write(target, scenario === "different bytes" ? "host edit" : "same", scenario === "different mode" ? 0o700 : 0o600);
    fs.mkdirSync(path.join(home, root), { recursive: true });
    let destination = path.join(home, target);
    if (scenario === "outside home") { destination = path.join(outside, "README.md"); fs.writeFileSync(destination, "same", { mode: 0o600 }); }
    if (scenario === "ancestor symlink") { fs.symlinkSync("docs", path.join(home, root, "linked")); destination = path.join(home, root, "linked/README.md"); }
    if (scenario === "chained symlink") { fs.symlinkSync("docs/README.md", path.join(home, root, "second.md")); destination = path.join(home, root, "second.md"); }
    if (scenario === "missing") destination = path.join(home, root, "absent.md");
    fs.symlinkSync(destination, path.join(home, alias));
    const built = await parseMirrorBundle(buildMirrorBundle([{ path: alias, kind: scenario === "non-verbatim" ? "json-remap" : "verbatim", mode: "0600", bytes: Buffer.from("same") }], { source: source(), target_home: home, managed_roots: ["work"], project_roots: ["work", root] }).bytes);
    const result = await apply(built);
    expect(result.errors.length).toBe(1);
    expect(result.applied).toEqual([]);
    expect(readStamp(home)?.complete).toBe(false);
    expect(fs.readlinkSync(path.join(home, alias))).toBe(destination);
    expect(read(target)).toBe(scenario === "different bytes" ? "host edit" : "same");
    expect(modeOf(target)).toBe(scenario === "different mode" ? 0o700 : 0o600);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});
