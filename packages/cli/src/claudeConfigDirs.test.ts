import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { claudeConfigDirs, claudeProjectsDirs, discoverClaudeConfigDirs, resetClaudeConfigDirsCache } from "./claudeConfigDirs.js";
import { SessionWatcher, type SessionEvent } from "./sessionWatcher.js";

// A person who runs one Claude subscription per CLAUDE_CONFIG_DIR (a shell alias
// per account: CLAUDE_CONFIG_DIR=~/.claude-account-3 claude) writes transcripts
// to ~/.claude-account-3/projects. The daemon watched only ~/.claude/projects,
// so those sessions never synced, parked or moved (Alexander Green, 2026-11-03).

let home: string;
let prevHome: string | undefined;
let prevEnv: string | undefined;

function configDir(name: string): string {
  const dir = path.join(home, name);
  fs.mkdirSync(path.join(dir, "projects"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude.json"), "{}");
  return dir;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-config-dirs-"));
  prevHome = process.env.HOME;
  prevEnv = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  resetClaudeConfigDirsCache();
});

afterEach(() => {
  process.env.HOME = prevHome;
  if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevEnv;
  resetClaudeConfigDirsCache();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("claudeConfigDirs", () => {
  test("finds every hidden dir Claude Code has run in, ~/.claude first", () => {
    const a3 = configDir(".claude-account-3");
    const a1 = configDir(".claude-account-1");
    const work = configDir(".cc-work");
    expect(claudeConfigDirs()).toEqual([path.join(home, ".claude"), work, a1, a3]);
    expect(claudeProjectsDirs()).toEqual([path.join(home, ".claude"), work, a1, a3].map((d) => path.join(d, "projects")));
  });

  test("a dir without .claude.json is not a config dir (backups, worktrees)", () => {
    fs.mkdirSync(path.join(home, ".claude-backup", "projects"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude-worktrees"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude.json"), "{}");
    fs.mkdirSync(path.join(home, "visible"), { recursive: true });
    fs.writeFileSync(path.join(home, "visible", ".claude.json"), "{}");
    expect(discoverClaudeConfigDirs(home)).toEqual([]);
    expect(claudeConfigDirs()).toEqual([path.join(home, ".claude")]);
  });

  test("the daemon's own CLAUDE_CONFIG_DIR counts, wherever it is", () => {
    expect(discoverClaudeConfigDirs(home, "~/elsewhere/claude")).toEqual([path.join(home, "elsewhere", "claude")]);
    expect(discoverClaudeConfigDirs(home, path.join(home, ".claude"))).toEqual([]);
  });
});

describe("SessionWatcher with no explicit root", () => {
  test("emits a transcript written under another config dir", async () => {
    const a3 = configDir(".claude-account-3");
    const watcher = new SessionWatcher();
    try {
      await watcher.start();
      expect(watcher.roots()).toEqual([path.join(home, ".claude", "projects"), path.join(a3, "projects")]);
      const projectDir = path.join(a3, "projects", "-Users-alex");
      fs.mkdirSync(projectDir, { recursive: true });
      const id = "7829f4de-5f42-4cd8-ae5b-56fe1464228a";
      const file = path.join(projectDir, `${id}.jsonl`);
      const seen = new Promise<SessionEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no session event")), 5000);
        watcher.on("session", (e) => { if (e.sessionId === id) { clearTimeout(timer); resolve(e); } });
      });
      fs.writeFileSync(file, JSON.stringify({ type: "user", sessionId: id, cwd: "/Users/alex" }) + "\n");
      const event = await seen;
      expect(event.filePath).toBe(file);
      expect(event.projectPath).toBe("-Users-alex");
    } finally {
      watcher.stop();
    }
  });
});

describe("the recent-file scan job", () => {
  test("carries the config dirs' projects roots to the worker", async () => {
    const { validScanJob } = await import("./workers/scanTypes.js");
    const job = { name: "recent", home, sessionId: "abc", since: 0, codexOnly: false, claudeRoots: claudeProjectsDirs() };
    expect(validScanJob(job)).toBe(true);
    expect(validScanJob({ ...job, claudeRoots: [""] })).toBe(false);
    expect(validScanJob({ ...job, claudeRoots: "x" })).toBe(false);
  });
});
