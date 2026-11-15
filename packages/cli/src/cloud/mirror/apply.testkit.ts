/**
 * Fixtures the mirror apply tests share (apply.test.ts, apply.mcp.test.ts):
 * a temp host home per test, a seeded host, laptop bundles, and one apply call.
 * Each test file calls useHostHome() once.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REFERENCES_SNIPPET, SNIPPET_CATALOG } from "@codecast/shared/contracts";
import { findOwnedSections } from "@platform/snippets";
import {
  GITCONFIG_BLOCK_END, GITCONFIG_BLOCK_START, MIRROR_LOCK_REL, MIRROR_RECEIVER_CAPABILITIES, MIRROR_STAMP_REL, applyMirrorBundle, applyStagingBundle,
  adoptFeatureSwitches, composeInstructionFile, featureSwitches, mergeClaudeSettings, mergeCodexHooks, mergeCodexToml, mergeGitconfig, mirrorUntouchedInCheckoutScript, readStamp, stripGitconfigBlock, verifyMirrorStamp, withMirrorLock,
} from "./apply";
import { buildMirrorBundle, parseMirrorBundle, sha256, type BundleInput } from "./bundle";
import { ownedSectionSpecs, stripOwnedSections } from "./transform";

export let home: string;

export function write(rel: string, content: string | Buffer, mode = 0o644): void {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, { mode });
}
export function read(rel: string): string {
  return fs.readFileSync(path.join(home, rel), "utf-8");
}
export function modeOf(rel: string): number {
  return fs.statSync(path.join(home, rel)).mode & 0o777;
}

/** This box's host CLAUDE.md: every catalog section installed, no user text. */
export function hostClaudeMd(): string {
  const sections = SNIPPET_CATALOG.filter((d) => d.section).map((d) => d.section!.body);
  return `${sections.join("")}${REFERENCES_SNIPPET}`.replace(/^\n+/, "");
}
export function ownedCount(text: string): number {
  return ownedSectionSpecs().reduce((n, spec) => n + findOwnedSections(text, spec).length, 0);
}

export const HOST_SETTINGS = {
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
export const HOST_CODEX_TOML = '[projects."/home/ubuntu/work/codecast"]\ntrust_level = "trusted"\n\n[features]\nhooks = true\n';
export const HOST_CODEX_HOOKS = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/home/ubuntu/.codecast/hooks/stable-feed-codex.sh", additionalContextLimit: 0, timeout: 30 }] }] } };

export function seedHost(): void {
  write(".claude/CLAUDE.md", hostClaudeMd());
  write(".claude/settings.json", JSON.stringify(HOST_SETTINGS, null, 4));
  write(".claude/hooks/stable-feed.sh", "#!/bin/sh\n", 0o755);
  write(".claude/hooks/thread-state.sh", "#!/bin/sh\n", 0o755);
  write(".codex/config.toml", HOST_CODEX_TOML);
  write(".codex/hooks.json", JSON.stringify(HOST_CODEX_HOOKS, null, 2));
  write(".codecast/config.json", JSON.stringify({ user_id: "u1" }));
}

export const source = (device_id = "laptop-1") => ({ device_id, user_id: "u1", home: "/Users/ashot", platform: "darwin", cast_version: "1" });

export async function bundleOf(entries: BundleInput[], opts: { device?: string; takeOver?: boolean; userId?: string; targetHome?: string; features?: Record<string, boolean | string> } = {}) {
  const built = buildMirrorBundle(entries, {
    source: { ...source(opts.device), user_id: opts.userId ?? "u1" },
    target_home: opts.targetHome ?? home, managed_roots: [".claude", ".codex", ".grok", ".gemini", ".agents", ".config/opencode"], take_over: opts.takeOver,
    features: opts.features,
  });
  return parseMirrorBundle(built.bytes);
}

export const laptopUserMd = "# Ashot's rules\n\nAlways run the tests.\n\n## Memory\n\nMy own notes.\n";
export function laptopEntries(): BundleInput[] {
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

export let refreshRuns = 0;
export const refresh = () => { refreshRuns++; };
export function apply(bundle: Awaited<ReturnType<typeof bundleOf>>, extra: Partial<Parameters<typeof applyMirrorBundle>[1]> = {}) {
  return applyMirrorBundle(bundle, { home, configUserId: "u1", previousStamp: readStamp(home), refresh, pinnedEnvKeys: [], ...extra });
}

/** A fresh host home for every test of the calling file; each file calls it, since bun shares one module between files. */
export function useHostHome(): void {
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mirror-apply-")));
    refreshRuns = 0;
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });
}
