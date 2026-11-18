import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeProjectDirName } from "../projectPathResolver.js";

export interface LocalSession {
  sessionId: string;
  /** Canonical (symlink-resolved) cwd = the worktree path. */
  cwd: string;
  /** Absolute path to the transcript JSONL. */
  jsonlPath: string;
  /** The ~/.claude/projects/<slug> dir containing the JSONL. */
  projectDir: string;
}

export const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");

/**
 * Reverse a project-dir slug to a real path by probing the filesystem
 * (handles dirs containing "-" and dotfile dirs). Mirrors the daemon's
 * decodeProjectDirName; kept local to avoid importing the (large) daemon.
 */
export function slugToCwd(slug: string): string | null {
  const stripped = slug.startsWith("-") ? slug.slice(1) : slug;
  const tokens = stripped.split("-");
  let resolved = "/";
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] === "") { i++; continue; }
    let matched = false;
    for (let len = tokens.length - i; len >= 1; len--) {
      const candidate = tokens.slice(i, i + len).join("-");
      if (fs.existsSync(path.join(resolved, candidate))) {
        resolved = path.join(resolved, candidate); i += len; matched = true; break;
      }
      if (fs.existsSync(path.join(resolved, "." + candidate))) {
        resolved = path.join(resolved, "." + candidate); i += len; matched = true; break;
      }
    }
    if (!matched) return null;
  }
  return resolved;
}

/**
 * Read the exact cwd a session ran in, straight from its transcript. Every
 * JSONL record carries a `cwd` field — this is bulletproof, unlike decoding
 * the project-dir slug (CC collapses both "/" and "." to "-", which is not
 * losslessly reversible).
 */
export function cwdFromTranscript(jsonlPath: string, slug = path.basename(path.dirname(jsonlPath))): string | null {
  // The LAST cwd, not the first: a session that has travelled between
  // machines carries entries stamped with every home it has had, and after a
  // round trip the file can even BEGIN with the remote's path (observed live:
  // first line /home/ubuntu/work/…, last line /Users/…). The newest entry is
  // the only one that reflects where the session runs now.
  // A record's cwd also follows the agent's own `cd`, so the newest entry whose
  // slug is the transcript's project folder wins: that is where the agent was
  // launched and resumes. A `cd packages/web` otherwise moved the session into
  // a host checkout named "web" (2026-10-09).
  let last: string | null = null;
  let launch: string | null = null;
  try {
    const text = fs.readFileSync(jsonlPath, "utf-8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { cwd?: string };
        if (!rec.cwd) continue;
        last = rec.cwd;
        if (claudeProjectDirName(rec.cwd) === slug) launch = rec.cwd;
      } catch { /* skip non-JSON line */ }
    }
  } catch { /* unreadable */ }
  return launch ?? last;
}

/** Locate a session's JSONL + cwd on this machine by session id. */
export function resolveLocalSession(sessionId: string): LocalSession {
  if (!fs.existsSync(CLAUDE_PROJECTS)) {
    throw new Error(`no ~/.claude/projects dir on this machine`);
  }
  for (const slug of fs.readdirSync(CLAUDE_PROJECTS)) {
    const candidate = path.join(CLAUDE_PROJECTS, slug, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      // Prefer the cwd recorded in the transcript — but only if it exists on
      // THIS machine. A transcript that has been to a remote and back records
      // that machine's paths too, and pushing from a nonexistent cwd fails as
      // a baffling rsync lstat error. The slug is by construction where this
      // machine placed the project, so it is the safe fallback.
      const cwd = [cwdFromTranscript(candidate), slugToCwd(slug)]
        .find((c): c is string => !!c && fs.existsSync(c));
      if (!cwd) continue;
      return { sessionId, cwd, jsonlPath: candidate, projectDir: path.join(CLAUDE_PROJECTS, slug) };
    }
  }
  throw new Error(`session ${sessionId} not found under ~/.claude/projects`);
}
