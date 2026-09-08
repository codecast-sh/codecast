import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyMirrorBundle, cleanTrackedFiles, matchesGitBlob, readStamp, verifyMirrorStamp, withMirrorLock } from "./apply";
import { buildMirrorBundle, parseMirrorBundle } from "./bundle";
import { CLAUDE_RUNTIME_ROOTS } from "./discovery";
import { buildHomeMirror, mirrorHomeToHost, runMirrorTick, type LocalMirrorStamps, type MirrorDeps } from "./push";
import { projectDestination, readProjectRegistrations, registerProjectContext } from "./projectRefresh";
import { startMirrorScheduler } from "./scheduler";
import { claudeProjectDirName } from "../../projectPathResolver";
import { execFileSync } from "node:child_process";
import { unregisterProjectContext } from "./projectRefresh";

const scratch: string[] = [];
const temp = () => { const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mirror-refresh-"))); scratch.push(p); return p; };
const write = (root: string, rel: string, text: string) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
afterEach(() => { for (const p of scratch.splice(0)) fs.rmSync(p, { force: true, recursive: true }); });

test("next generation releases unchanged and drifted Claude catalogs while ordinary source removals still prune", async () => {
  const local = temp();
  const remote = temp();
  const catalogPaths = [
    ".claude/plugins/marketplaces/official/plugins/tool/README.md",
    ".claude/plugins/marketplaces/official/plugins/tool/unchanged.md",
    ".claude/plugins/installed_plugins.json",
    ".claude/plugins/known_marketplaces.json",
  ];
  const removed = ".claude/skills/removed/SKILL.md";
  const portable = ".claude/plugins/cache/official/tool/1.0/docs/README.md";
  const entries = [...catalogPaths, removed, portable].map((rel) => ({ path: rel, kind: "verbatim" as const, mode: "0600" as const, bytes: Buffer.from(rel.endsWith(".json") ? "{}" : "portable context\n") }));
  for (const entry of entries) write(local, entry.path, entry.bytes.toString());
  const initial = buildMirrorBundle(entries, { source: { device_id: "d", user_id: "u", home: local, platform: process.platform, cast_version: "test" }, target_home: remote, managed_roots: [".claude"] });
  const apply = async (bytes: Buffer) => applyMirrorBundle(await parseMirrorBundle(bytes), { home: remote, configUserId: "u", previousStamp: readStamp(remote), refresh: () => {} });
  expect((await apply(initial.bytes)).errors).toEqual([]);
  write(remote, catalogPaths[0]!, "host refreshed catalog\n");
  write(remote, catalogPaths[2]!, '{"plugins":{}}');
  expect(verifyMirrorStamp(remote)?.complete).toBe(false);
  const preserved = catalogPaths.map((rel) => ({ rel, bytes: read(remote, rel), stat: fs.statSync(path.join(remote, rel)) }));
  fs.unlinkSync(path.join(local, removed));
  write(local, portable, "updated portable context\n");
  const next = await buildHomeMirror({ home: local, hostHome: remote, config: { user_id: "u" }, deviceId: "d", gitEnv: { GIT_CONFIG_GLOBAL: path.join(local, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" } });
  expect(next.header.unmanaged_roots).toEqual([...CLAUDE_RUNTIME_ROOTS]);
  expect(next.header.files.some((file) => catalogPaths.includes(file.path))).toBe(false);
  const result = await apply(next.bytes);
  expect(result.errors).toEqual([]);
  expect(result.host_edited).toEqual([]);
  expect(result.pruned).toEqual([removed]);
  expect(read(remote, portable)).toBe("updated portable context\n");
  for (const { rel, bytes, stat } of preserved) {
    expect(read(remote, rel)).toBe(bytes);
    expect(fs.statSync(path.join(remote, rel)).ino).toBe(stat.ino);
    expect(fs.statSync(path.join(remote, rel)).mtimeMs).toBe(stat.mtimeMs);
    expect(readStamp(remote)?.files[rel]).toBeUndefined();
  }
  expect(fs.existsSync(path.join(remote, removed))).toBe(false);
  expect(verifyMirrorStamp(remote)?.complete).toBe(true);
  write(remote, catalogPaths[1]!, "another host catalog refresh\n");
  expect(verifyMirrorStamp(remote)?.complete).toBe(true);
  expect((await apply(next.bytes)).host_edited).toEqual([]);
});

test("selective Claude project MCP definitions fan out to actual worktree keys without copying account state", async () => {
  const local = temp();
  const remote = temp();
  const sourceRoot = path.join(local, "src/app with spaces");
  const targetRoots = [path.join(remote, "work/app"), path.join(remote, "worktrees/feature 'quoted'")];
  write(sourceRoot, "AGENTS.md", "Project rules\n");
  write(local, ".claude.json", JSON.stringify({ oauthAccount: { accessToken: "fixture-laptop-auth" }, mcpServers: { global: { command: "portable-tool" } }, projects: { [sourceRoot]: { hasTrustDialogAccepted: true, mcpServers: { local: { command: "portable-tool", args: ["--root", sourceRoot] } } } } }));
  for (const root of targetRoots) fs.mkdirSync(root, { recursive: true });
  write(remote, ".claude.json", JSON.stringify({ oauthAccount: { accessToken: "fixture-host-auth" }, projects: { [targetRoots[0]!]: { hasTrustDialogAccepted: true } } }));
  const build = () => buildHomeMirror({ home: local, hostHome: remote, config: { user_id: "u" }, deviceId: "d", projects: targetRoots.map((targetRoot) => ({ host: "ubuntu@test.invalid", sourceRoot, targetRoot })), gitEnv: { GIT_CONFIG_GLOBAL: path.join(local, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" } });
  const built = await build();
  const parsed = await parseMirrorBundle(built.bytes);
  const projected = parsed.files.find((file) => file.path === ".claude.json")!;
  expect(projected.kind).toBe("claude-mcp");
  expect(projected.bytes.toString()).not.toContain("fixture-laptop-auth");
  expect(projected.bytes.toString()).not.toContain("hasTrustDialogAccepted");
  for (const root of targetRoots) expect(JSON.parse(projected.bytes.toString()).projects[root].mcpServers.local.args).toEqual(["--root", root]);
  const apply = async (bytes: Buffer) => applyMirrorBundle(await parseMirrorBundle(bytes), { home: remote, configUserId: "u", previousStamp: readStamp(remote), refresh: () => {} });
  expect((await apply(built.bytes)).errors).toEqual([]);
  const host = JSON.parse(read(remote, ".claude.json"));
  expect(host.oauthAccount.accessToken).toBe("fixture-host-auth");
  expect(host.projects[targetRoots[0]!].hasTrustDialogAccepted).toBe(true);
  write(local, ".claude.json", JSON.stringify({ oauthAccount: { accessToken: "fixture-laptop-auth" }, mcpServers: {} }));
  expect((await apply((await build()).bytes)).errors).toEqual([]);
  const removed = JSON.parse(read(remote, ".claude.json"));
  expect(removed.oauthAccount.accessToken).toBe("fixture-host-auth");
  expect(removed.projects[targetRoots[0]!]).toEqual({ hasTrustDialogAccepted: true });
  expect(removed.projects[targetRoots[1]!]).toBeUndefined();
  expect(verifyMirrorStamp(remote)?.complete).toBe(true);
});

test("temp HOME end-to-end refresh covers edits, deletions, drift, conflicts, pins and registered worktrees", async () => {
  const local = temp();
  const remote = temp();
  const sourceRoot = path.join(local, "src", "app");
  const targetRoot = path.join(remote, "work", "app");
  const worktree = path.join(remote, "work", "worktrees", "feature");
  write(sourceRoot, "AGENTS.md", `Use ${sourceRoot}/docs.\n`);
  write(local, "src/AGENTS.md", "Parent instructions\n");
  write(sourceRoot, "docs/work.md", "first\n");
  write(sourceRoot, "src/code.ts", "LOCAL CODE\n");
  const memory = `.claude/projects/${claudeProjectDirName(sourceRoot)}/memory/MEMORY.md`;
  write(local, memory, `Remember ${sourceRoot}/docs\n`);
  write(local, ".agents/skills/ref/SKILL.md", `Read ${sourceRoot}/AGENTS.md\n`);
  write(sourceRoot, "docs/shared.md", `Use ${local}/.agents/skills/ref/SKILL.md\n`);
  write(local, ".claude/settings.json", JSON.stringify({ env: { MIRROR_VAR: "first" }, enabledPlugins: { alpha: true }, statusLine: { command: "echo first" } }));
  write(local, ".codex/config.toml", 'model = "local"\n[features]\nweb_search = true\n');
  write(local, ".codex/AGENTS.override.md", "temporary override\n");
  write(remote, ".claude/settings.json", JSON.stringify({ env: { ANTHROPIC_API_KEY: "remote-secret", HOST_ONLY: "keep" }, model: "host-model" }));
  write(remote, ".codecast/mirrored-claude-env.json", JSON.stringify(["ANTHROPIC_API_KEY"]));
  write(remote, ".codex/config.toml", '[projects."/remote/trusted"]\ntrust_level = "trusted"\n[features]\nhooks = true\nhost_only = true\n');
  write(targetRoot, "src/code.ts", "REMOTE CODE\n");
  fs.mkdirSync(worktree, { recursive: true });
  fs.symlinkSync("AGENTS.md", path.join(worktree, "CLAUDE.md"));
  fs.symlinkSync("AGENTS.md", path.join(sourceRoot, "CLAUDE.md"));
  const file = path.join(local, ".codecast", "projects.json");
  const host = { address: "test.invalid", user: "ubuntu", keyPath: "/unused", homeDir: remote, remoteBaseDir: path.join(remote, "work") };
  await Promise.all([registerProjectContext(host, sourceRoot, targetRoot, { file }), registerProjectContext(host, sourceRoot, worktree, { file })]);
  expect(readProjectRegistrations(host, file)).toHaveLength(2);
  let stamps: LocalMirrorStamps = {};
  let pushes = 0;
  const deps: Partial<MirrorDeps> = {
    listHosts: async () => [host],
    readConfig: () => ({ user_id: "u" }),
    readProjects: () => readProjectRegistrations(host, file),
    readLocalStamps: () => structuredClone(stamps),
    writeLocalStamps: (next) => { stamps = next; },
    build: (opts) => buildHomeMirror({ ...opts, home: local, deviceId: "d", gitEnv: { GIT_CONFIG_GLOBAL: path.join(local, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" } }),
    readStamp: async () => verifyMirrorStamp(remote),
    push: async (_host, bytes) => {
      pushes++;
      const parsed = await parseMirrorBundle(bytes);
      const result = await withMirrorLock(remote, () => applyMirrorBundle(parsed, { home: remote, configUserId: "u", previousStamp: readStamp(remote), refresh: () => {} }));
      return { pushed: true, hash: result.hash, result };
    },
  };
  expect((await mirrorHomeToHost(host, { deps })).pushed).toBe(true);
  expect(verifyMirrorStamp(remote)?.complete).toBe(true);
  expect(read(worktree, "AGENTS.md")).toContain(`${worktree}/docs`);
  expect(fs.readlinkSync(path.join(worktree, "CLAUDE.md"))).toBe("AGENTS.md");
  for (const root of [targetRoot, worktree]) expect(read(remote, `.claude/projects/${claudeProjectDirName(root)}/memory/MEMORY.md`)).toContain(`${root}/docs`);
  expect(read(remote, ".agents/skills/ref/SKILL.md")).toContain(`${targetRoot}/AGENTS.md`);
  expect(read(remote, "work/AGENTS.md")).toContain("Parent instructions");
  expect(read(targetRoot, "src/code.ts")).toBe("REMOTE CODE\n");
  write(local, ".claude/settings.json", JSON.stringify({ env: { NEW_VAR: "next" }, enabledPlugins: { beta: true } }));
  fs.unlinkSync(path.join(local, ".codex/AGENTS.override.md"));
  fs.unlinkSync(path.join(sourceRoot, "docs/work.md"));
  write(sourceRoot, "docs/new.md", "second\n");
  const refreshed = await runMirrorTick({ reason: "test", onlyIfChanged: true }, deps);
  expect(refreshed.failed).toEqual([]);
  expect(refreshed.pushed).toHaveLength(1);
  const settings = JSON.parse(read(remote, ".claude/settings.json"));
  expect(settings.env).toEqual({ ANTHROPIC_API_KEY: "remote-secret", HOST_ONLY: "keep", CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1", NEW_VAR: "next" });
  expect(settings.enabledPlugins).toEqual({ beta: true });
  expect(settings.statusLine).toBeUndefined();
  expect(settings.model).toBe("host-model");
  expect(read(remote, ".codex/config.toml")).toContain('trust_level = "trusted"');
  expect(read(remote, ".codex/config.toml")).toContain("host_only = true");
  expect(fs.existsSync(path.join(remote, ".codex/AGENTS.override.md"))).toBe(false);
  for (const root of [targetRoot, worktree]) {
    expect(fs.existsSync(path.join(root, "docs/work.md"))).toBe(false);
    expect(read(root, "docs/new.md")).toBe("second\n");
  }
  fs.chmodSync(path.join(worktree, "docs/new.md"), 0o777);
  expect(verifyMirrorStamp(remote)?.complete).toBe(false);
  expect((await runMirrorTick({ reason: "verify", verifyRemote: true }, deps)).pushed).toHaveLength(1);
  expect(fs.statSync(path.join(worktree, "docs/new.md")).mode & 0o777).toBe(0o600);
  write(worktree, "docs/new.md", "remote edit\n");
  expect((await runMirrorTick({ reason: "verify", verifyRemote: true }, deps)).failed).toHaveLength(1);
  expect(verifyMirrorStamp(remote)?.complete).toBe(false);
  expect(read(worktree, "docs/new.md")).toBe("remote edit\n");
  write(worktree, "docs/new.md", "second\n");
  expect((await runMirrorTick({ reason: "verify", verifyRemote: true }, deps)).pushed).toHaveLength(1);
  expect(verifyMirrorStamp(remote)?.complete).toBe(true);
  write(worktree, "docs/work.md", "reappeared\n");
  expect(verifyMirrorStamp(remote)?.complete).toBe(false);
  expect((await runMirrorTick({ reason: "verify", verifyRemote: true }, deps)).failed).toHaveLength(1);
  expect(pushes).toBe(6);
});

test("first ownership updates clean tracked context and preserves dirty tracked and untracked context", async () => {
  const local = temp();
  const remote = temp();
  const sourceRoot = path.join(local, "src", "app");
  const targetRoot = path.join(remote, "work", "app");
  for (const root of [sourceRoot, targetRoot]) {
    write(root, "AGENTS.md", "older instructions\n");
    write(root, "docs/clean.md", "older clean\n");
    write(root, "docs/dirty.md", "older dirty\n");
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "initial"]);
  }
  write(sourceRoot, "AGENTS.md", "new instructions\n");
  write(sourceRoot, "docs/clean.md", "new clean\n");
  write(sourceRoot, "docs/dirty.md", "new local dirty\n");
  write(targetRoot, "docs/dirty.md", "uncommitted cloud edit\n");
  write(sourceRoot, "docs/untracked.md", "local untracked\n");
  write(targetRoot, "docs/untracked.md", "cloud untracked\n");
  const tracked = await cleanTrackedFiles(targetRoot);
  expect([...tracked.keys()]).toContain("AGENTS.md");
  expect(matchesGitBlob(fs.readFileSync(path.join(targetRoot, "AGENTS.md")), fs.statSync(path.join(targetRoot, "AGENTS.md")).mode, tracked.get("AGENTS.md"))).toBe(true);
  const built = await buildHomeMirror({ config: { user_id: "u" }, home: local, hostHome: remote, deviceId: "d", projects: [{ host: "u@h", sourceRoot, targetRoot }] });
  const parsed = await parseMirrorBundle(built.bytes);
  const result = await applyMirrorBundle(parsed, { home: remote, configUserId: "u", previousStamp: null, refresh: () => {} });
  expect(result.errors).toEqual([]);
  expect(read(targetRoot, "AGENTS.md")).toBe("new instructions\n");
  expect(read(targetRoot, "docs/clean.md")).toBe("new clean\n");
  expect(read(targetRoot, "docs/dirty.md")).toBe("uncommitted cloud edit\n");
  expect(read(targetRoot, "docs/untracked.md")).toBe("cloud untracked\n");
  expect(result.host_edited).toEqual(["work/app/docs/dirty.md", "work/app/docs/untracked.md"]);
});

test("registrations follow stable host identity and retirement never recreates a deleted target", async () => {
  const local = temp();
  const remote = temp();
  const sourceRoot = path.join(local, "src", "app");
  write(sourceRoot, "AGENTS.md", "rules\n");
  const targetRoot = path.join(remote, "work", "retired");
  const host = { address: "old.invalid", user: "u", keyPath: "/unused", homeDir: remote, remoteBaseDir: path.join(remote, "work") };
  const file = path.join(local, "registry.json");
  fs.writeFileSync(file, JSON.stringify([{ host: "u@old.invalid", sourceRoot, targetRoot }]));
  const moved = { ...host, address: "new.invalid" };
  await registerProjectContext(moved, sourceRoot, targetRoot, { file, hostId: "i-123", previousAddress: host.address });
  expect(readProjectRegistrations(moved, file, "i-123")[0].hostId).toBe("i-123");
  expect(readProjectRegistrations(moved, file, "i-123")[0].host).toBe("u@new.invalid");
  const rows = readProjectRegistrations(moved, file, "i-123");
  expect(rows).toHaveLength(1);
  const built = await buildHomeMirror({ config: { user_id: "u" }, home: local, hostHome: remote, deviceId: "d", projects: rows });
  const result = await applyMirrorBundle(await parseMirrorBundle(built.bytes), { home: remote, configUserId: "u", previousStamp: null, refresh: () => {} });
  expect(result.retired_projects).toEqual(["work/retired"]);
  expect(fs.existsSync(targetRoot)).toBe(false);
  await unregisterProjectContext(moved, targetRoot, { file, hostId: "i-123" });
  const retired = await buildHomeMirror({ config: { user_id: "u" }, home: local, hostHome: remote, deviceId: "d", projects: readProjectRegistrations(moved, file, "i-123") });
  expect(retired.header.project_roots ?? []).toEqual([]);
  expect(retired.header.unmanaged_roots).toContain("work/retired");
  expect(retired.header.files.some((f) => f.path.startsWith("work/retired/"))).toBe(false);
});

test("project destination remaps ancestors without rewriting unrelated support paths", () => {
  const project = { host: "u@h", sourceRoot: "/local/src/app", targetRoot: "/remote/work/app" };
  expect(projectDestination("/local/src/AGENTS.md", project, "/local", "/remote")).toBe("work/AGENTS.md");
  expect(projectDestination("/local/src/claude.local.MD", project, "/local", "/remote")).toBe("work/claude.local.MD");
  expect(projectDestination("/local/src/.mcp.json", project, "/local", "/remote")).toBe("work/.mcp.json");
  expect(projectDestination("/local/src/agent-scripts/test.sh", project, "/local", "/remote")).toBe("src/agent-scripts/test.sh");
});

test("memory slugs match Claude for spaces, quotes and punctuation", () => {
  expect(claudeProjectDirName('/home/u/work/my "app".repo')).toBe("-home-u-work-my--app--repo");
});

test("scheduler waits for each run and stops its active operation and timers", async () => {
  let runs = 0;
  let ended = false;
  const scheduler = startMirrorScheduler({ intervalMs: 5, tick: async (opts) => {
    runs++;
    await new Promise<void>((resolve) => opts.signal!.addEventListener("abort", () => resolve(), { once: true }));
    ended = true;
    return { pushed: [], failed: [], skipped: [] };
  } });
  await new Promise((r) => setTimeout(r, 25));
  expect(runs).toBe(1);
  await scheduler.stop();
  expect(ended).toBe(true);
  await new Promise((r) => setTimeout(r, 20));
  expect(runs).toBe(1);
});

test("failed source inputs leave the previously mirrored files and stamp untouched", async () => {
  const local = temp();
  const remote = temp();
  const skill = ".claude/skills/kept/SKILL.md";
  write(local, skill, "valid skill\n");
  write(local, ".claude/settings.json", "{}");
  const opts = { home: local, hostHome: remote, deviceId: "d", config: { user_id: "u" } };
  const built = await buildHomeMirror(opts);
  await applyMirrorBundle(await parseMirrorBundle(built.bytes), { home: remote, configUserId: "u", previousStamp: null, refresh: () => {} });
  const saved = read(remote, ".codecast/mirror.json");
  write(local, ".claude/settings.json", "{broken");
  await expect(buildHomeMirror(opts)).rejects.toThrow();
  expect(read(remote, skill)).toBe("valid skill\n");
  expect(read(remote, ".codecast/mirror.json")).toBe(saved);
  write(local, ".claude/settings.json", "{}");
  fs.unlinkSync(path.join(local, skill));
  fs.symlinkSync("missing-target", path.join(local, skill));
  await expect(buildHomeMirror(opts)).rejects.toThrow(/dangling|incomplete/);
  expect(read(remote, skill)).toBe("valid skill\n");
  expect(read(remote, ".codecast/mirror.json")).toBe(saved);
  const excluded = await buildHomeMirror({ ...opts, config: { ...opts.config, cloud_mirror_exclude: ".claude/skills/kept" } });
  expect(excluded.header.files.some((f) => f.path === skill)).toBe(false);
});
