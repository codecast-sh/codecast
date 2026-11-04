// Every Claude Code config dir on this machine.
//
// Claude Code keeps a session's transcript, its settings (hooks included) and
// its global config in one config dir: ~/.claude by default, or the dir
// CLAUDE_CONFIG_DIR names. People who run several subscriptions side by side
// often give each its own dir (a shell alias per account that sets
// CLAUDE_CONFIG_DIR=~/.claude-account-N). A session started that way writes its
// transcript under <dir>/projects and reads hooks from <dir>/settings.json, so a
// daemon that only knows ~/.claude neither sees it nor hears its hooks.
//
// Another process's environment is not readable on macOS, so the dirs are found
// on disk. Claude Code writes its global config to <dir>/.claude.json when
// CLAUDE_CONFIG_DIR is set (the default dir keeps it at ~/.claude.json instead),
// so that file marks a dir Claude Code has run in and tells it apart from a
// backup copy of ~/.claude. The search covers the hidden dirs directly under
// $HOME, which is where people put them; the daemon's own CLAUDE_CONFIG_DIR is
// added because every session it launches inherits it. Codecast's private
// config dirs (dry runs, subscription calls) live under run dirs, never
// directly under $HOME, so they stay out.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const CACHE_MS = 60_000;
let cache: { key: string; at: number; dirs: string[] } | null = null;

function homeDir(): string {
  return process.env.HOME || os.homedir();
}

export function defaultClaudeConfigDir(home: string = homeDir()): string {
  return path.join(home, ".claude");
}

/** Extra config dirs found under `home`, sorted, the default dir excluded. */
export function discoverClaudeConfigDirs(home: string, envConfigDir?: string): string[] {
  const def = defaultClaudeConfigDir(home);
  const found = new Set<string>();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {}
  for (const e of entries) {
    if (!e.name.startsWith(".") || e.name === ".claude") continue;
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const dir = path.join(home, e.name);
    try {
      if (fs.statSync(path.join(dir, ".claude.json")).isFile()) found.add(dir);
    } catch {}
  }
  if (envConfigDir) {
    const dir = path.resolve(envConfigDir.replace(/^~(?=$|\/)/, home));
    if (dir !== def) found.add(dir);
  }
  found.delete(def);
  return [...found].sort();
}

/** ~/.claude first, then every other config dir Claude Code has run in. */
export function claudeConfigDirs(home: string = homeDir()): string[] {
  const env = process.env.CLAUDE_CONFIG_DIR || "";
  const key = `${home}\0${env}`;
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < CACHE_MS) return cache.dirs;
  const dirs = [defaultClaudeConfigDir(home), ...discoverClaudeConfigDirs(home, env || undefined)];
  cache = { key, at: now, dirs };
  return dirs;
}

/** The projects dir (transcripts) of every config dir, default first. */
export function claudeProjectsDirs(home: string = homeDir()): string[] {
  return claudeConfigDirs(home).map((d) => path.join(d, "projects"));
}

/** Tests only: forget the cached answer. */
export function resetClaudeConfigDirsCache(): void {
  cache = null;
}
