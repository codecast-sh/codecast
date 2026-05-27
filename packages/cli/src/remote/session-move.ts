/**
 * Move a Claude Code session between devices (local <-> remote Mac).
 *
 * A session is defined by four things; this module relocates all four:
 *   1. transcript JSONL  — ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
 *   2. working tree      — the worktree dir (cwd), via rsync over SSH
 *   3. auth              — the CC credential (~/.claude/.credentials.json)
 *   4. (browser/daemon handled separately by the device layer)
 *
 * Worktree-only by design: the bounded, branch-backed state of a worktree is
 * what makes the transfer reliable. Resume on the far side via `claude --resume`.
 *
 * Hard-won correctness notes (validated live on a Scaleway Mac):
 *   - Canonicalize the cwd (resolve symlinks) before building the slug — macOS
 *     /tmp -> /private/tmp, and CC encodes the PHYSICAL path.
 *   - rsync the JSONL into the project DIR (trailing slash), never to the full
 *     filename, or rsync corrupts the dest into a directory.
 *   - The copied access token is short-lived (~1h); CC self-refreshes via the
 *     refreshToken, but copy a FRESH credential at move time.
 */

import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RemoteHost {
  /** SSH host/IP. */
  address: string;
  /** SSH username (Scaleway Apple Silicon: "m1"). */
  user: string;
  /** Path to the private key. */
  keyPath: string;
  /** Base dir on the remote under which worktrees are placed. */
  remoteBaseDir: string; // e.g. /Users/m1/work
}

export interface LocalSession {
  sessionId: string;
  /** Canonical (symlink-resolved) cwd = the worktree path. */
  cwd: string;
  /** Absolute path to the transcript JSONL. */
  jsonlPath: string;
  /** The ~/.claude/projects/<slug> dir containing the JSONL. */
  projectDir: string;
}

const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");

/** cwd -> project-dir slug (every "/" becomes "-"). Matches CC + daemon. */
export function cwdToSlug(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

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
function cwdFromTranscript(jsonlPath: string): string | null {
  try {
    const text = fs.readFileSync(jsonlPath, "utf-8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { cwd?: string };
        if (rec.cwd) return rec.cwd;
      } catch { /* skip non-JSON line */ }
    }
  } catch { /* unreadable */ }
  return null;
}

/** Locate a session's JSONL + cwd on this machine by session id. */
export function resolveLocalSession(sessionId: string): LocalSession {
  if (!fs.existsSync(CLAUDE_PROJECTS)) {
    throw new Error(`no ~/.claude/projects dir on this machine`);
  }
  for (const slug of fs.readdirSync(CLAUDE_PROJECTS)) {
    const candidate = path.join(CLAUDE_PROJECTS, slug, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      // Prefer the cwd recorded in the transcript; fall back to slug decoding.
      const cwd = cwdFromTranscript(candidate) ?? slugToCwd(slug);
      if (!cwd) continue;
      return { sessionId, cwd, jsonlPath: candidate, projectDir: path.join(CLAUDE_PROJECTS, slug) };
    }
  }
  throw new Error(`session ${sessionId} not found under ~/.claude/projects`);
}

// --------------------------------------------------------------------------
// SSH / rsync primitives
// --------------------------------------------------------------------------

function sshBase(host: RemoteHost): string[] {
  return ["-i", host.keyPath, "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=20"];
}

function ssh(host: RemoteHost, command: string): string {
  return execFileSync("ssh", [...sshBase(host), `${host.user}@${host.address}`, command], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function rsyncUp(host: RemoteHost, localDir: string, remoteDir: string, opts: { delete?: boolean } = {}) {
  const args = [
    "-az", ...(opts.delete ? ["--delete"] : []),
    "-e", `ssh ${sshBase(host).join(" ")}`,
    "--exclude", "node_modules", "--exclude", ".git", "--exclude", ".conductor",
    "--exclude", "dist", "--exclude", ".next", "--exclude", ".DS_Store",
    `${localDir.replace(/\/?$/, "/")}`,
    `${host.user}@${host.address}:${remoteDir.replace(/\/?$/, "/")}`,
  ];
  execFileSync("rsync", args, { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
}

function rsyncDown(host: RemoteHost, remoteDir: string, localDir: string, opts: { delete?: boolean } = {}) {
  const args = [
    "-az", ...(opts.delete ? ["--delete"] : []),
    "-e", `ssh ${sshBase(host).join(" ")}`,
    "--exclude", "node_modules", "--exclude", ".git", "--exclude", ".conductor",
    "--exclude", "dist", "--exclude", ".next", "--exclude", ".DS_Store",
    `${host.user}@${host.address}:${remoteDir.replace(/\/?$/, "/")}`,
    `${localDir.replace(/\/?$/, "/")}`,
  ];
  execFileSync("rsync", args, { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
}

/** Copy ONE file into a remote directory (trailing-slash target avoids dir corruption). */
function rsyncFileInto(host: RemoteHost, localFile: string, remoteDir: string) {
  ssh(host, `mkdir -p ${shq(remoteDir)}`);
  const args = [
    "-az", "-e", `ssh ${sshBase(host).join(" ")}`,
    localFile, `${host.user}@${host.address}:${remoteDir.replace(/\/?$/, "/")}`,
  ];
  execFileSync("rsync", args, { stdio: "pipe" });
}

function rsyncFileDownInto(host: RemoteHost, remoteFile: string, localDir: string) {
  fs.mkdirSync(localDir, { recursive: true });
  const args = [
    "-az", "-e", `ssh ${sshBase(host).join(" ")}`,
    `${host.user}@${host.address}:${remoteFile}`, `${localDir.replace(/\/?$/, "/")}`,
  ];
  execFileSync("rsync", args, { stdio: "pipe" });
}

function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// --------------------------------------------------------------------------
// Git-over-SSH transport
// --------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function gitSafe(cwd: string, args: string[]): { ok: boolean; out: string } {
  try { return { ok: true, out: git(cwd, args) }; }
  catch (e) { return { ok: false, out: (e as { stderr?: Buffer }).stderr?.toString() ?? String(e) }; }
}

/** Branch checked out in a worktree. */
export function currentBranch(cwd: string): string {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/** True if the cwd is a git worktree (has commits + a branch). Worktree-only guard. */
export function isWorktree(cwd: string): boolean {
  return gitSafe(cwd, ["rev-parse", "--is-inside-work-tree"]).out === "true";
}

/**
 * Commit all changes (tracked + untracked, minus gitignored) as a WIP
 * snapshot so the branch tip captures the exact working state. Returns the
 * commit sha, or null if nothing to commit. Idempotent-ish: re-running with
 * no changes is a no-op.
 */
export function wipSnapshot(cwd: string, label = "codecast-remote: wip snapshot"): string | null {
  const status = git(cwd, ["status", "--porcelain"]);
  if (!status.trim()) return null;
  git(cwd, ["add", "-A"]);
  // --no-verify: never run hooks for an automated snapshot.
  gitSafe(cwd, ["commit", "--no-verify", "-m", label]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** SSH url for git push to a path on the remote. */
function gitSshUrl(host: RemoteHost, remotePath: string): string {
  // GIT_SSH_COMMAND carries the key/options; the url is plain user@host:path.
  return `${host.user}@${host.address}:${remotePath}`;
}

function gitEnv(host: RemoteHost): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_SSH_COMMAND: `ssh -i ${host.keyPath} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20`,
  };
}

/** Does the remote already have a git repo at remotePath? */
function remoteRepoExists(host: RemoteHost, remotePath: string): boolean {
  try {
    const out = ssh(host, `test -d ${shq(remotePath)}/.git && echo yes || echo no`).trim();
    return out === "yes";
  } catch { return false; }
}

/**
 * Bootstrap a remote clone when absent. In production the Mac would clone from
 * the repo's origin (fast, full history); for environments without remote
 * access we ship a bundle over SSH. The remote clone is configured with
 * receive.denyCurrentBranch=updateInstead so subsequent branch pushes update
 * its working tree in place.
 */
function ensureRemoteRepo(host: RemoteHost, localCwd: string, remotePath: string): void {
  if (remoteRepoExists(host, remotePath)) {
    ssh(host, `cd ${shq(remotePath)} && git config receive.denyCurrentBranch updateInstead`);
    return;
  }
  // Bundle everything reachable; scp; clone on the remote.
  const bundle = path.join(os.tmpdir(), `codecast-bundle-${Date.now()}.bundle`);
  git(localCwd, ["bundle", "create", bundle, "--all"]);
  const remoteBundle = `/tmp/${path.basename(bundle)}`;
  execFileSync("scp", [...sshBase(host), bundle, `${host.user}@${host.address}:${remoteBundle}`], { stdio: "pipe" });
  ssh(host,
    `rm -rf ${shq(remotePath)} && git clone -q ${shq(remoteBundle)} ${shq(remotePath)} && ` +
    `cd ${shq(remotePath)} && git config receive.denyCurrentBranch updateInstead && ` +
    `git config user.email codecast@local && git config user.name codecast && rm -f ${shq(remoteBundle)}`,
  );
  fs.rmSync(bundle, { force: true });
}

/**
 * Push a worktree's branch to the remote over SSH. The remote working tree
 * (updateInstead) lands on the pushed tip. Returns the branch + remote path.
 */
export function gitPushWorktree(host: RemoteHost, localCwd: string, remotePath: string): { branch: string } {
  const branch = currentBranch(localCwd);
  wipSnapshot(localCwd);
  ensureRemoteRepo(host, localCwd, remotePath);
  execFileSync("git", ["-C", localCwd, "push", "--force", gitSshUrl(host, remotePath), `${branch}:${branch}`],
    { env: gitEnv(host), stdio: "pipe", encoding: "utf-8" });
  // Make sure the remote has the branch checked out (first push to a fresh
  // clone may be on a different default branch).
  ssh(host, `cd ${shq(remotePath)} && git checkout -q ${shq(branch)} 2>/dev/null || true; git reset -q --hard ${shq(branch)}`);
  return { branch };
}

/** Pull the remote branch back (fast-forward only; never clobbers). */
export function gitPullWorktree(host: RemoteHost, localCwd: string, remotePath: string): { ff: boolean; reason?: string } {
  const branch = currentBranch(localCwd);
  // Snapshot remote work as a commit, then fetch it locally. Pass an identity
  // inline so a freshly-cloned remote repo without user.* config can commit.
  ssh(host, `cd ${shq(remotePath)} && git add -A && (git -c user.email=codecast@local -c user.name=codecast commit --no-verify -q -m 'codecast-remote: wip snapshot (remote)' || true)`);
  execFileSync("git", ["-C", localCwd, "fetch", gitSshUrl(host, remotePath), branch], { env: gitEnv(host), stdio: "pipe" });
  // Fast-forward only.
  const r = gitSafe(localCwd, ["merge", "--ff-only", "FETCH_HEAD"]);
  if (!r.ok) {
    return { ff: false, reason: `local and remote diverged; not fast-forwardable. Resolve manually.\n${r.out}` };
  }
  return { ff: true };
}

// --------------------------------------------------------------------------
// Auth: copy a FRESH credential to the remote
// --------------------------------------------------------------------------

/**
 * Copy the current CC credential to the remote. On macOS the local cred lives
 * in the Keychain (service "Claude Code-credentials"); we read it and write the
 * FILE form on the remote (CC reads the file). Returns true on success.
 */
export function copyCredentialToRemote(host: RemoteHost): boolean {
  let cred: string;
  try {
    cred = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf-8" },
    ).trim();
  } catch {
    // Linux / file-based local cred fallback.
    const f = path.join(os.homedir(), ".claude", ".credentials.json");
    if (!fs.existsSync(f)) return false;
    cred = fs.readFileSync(f, "utf-8");
  }
  // Pipe via ssh stdin so the secret never lands on disk locally or in argv.
  execFileSync(
    "ssh",
    [...sshBase(host), `${host.user}@${host.address}`, "umask 077; mkdir -p ~/.claude; cat > ~/.claude/.credentials.json"],
    { input: cred },
  );
  return true;
}

// --------------------------------------------------------------------------
// Push / Pull
// --------------------------------------------------------------------------

export interface MoveResult {
  sessionId: string;
  localCwd: string;
  remoteCwd: string;
  remoteProjectDir: string;
}

/** Push a local session to the remote Mac. Returns the remote placement. */
export function pushSession(sessionId: string, host: RemoteHost): MoveResult {
  const s = resolveLocalSession(sessionId);
  const name = path.basename(s.cwd);
  const remoteCwd = path.posix.join(host.remoteBaseDir, name);
  const remoteProjectDir = path.posix.join(
    `/Users/${host.user}/.claude/projects`,
    cwdToSlug(remoteCwd),
  );

  // 1. credential (fresh — token TTL ~1h)
  copyCredentialToRemote(host);
  // 2. working tree — git-over-SSH for repos (full git on the remote), else rsync
  if (isWorktree(s.cwd)) {
    gitPushWorktree(host, s.cwd, remoteCwd);
    copyGitignoredFiles(host, s.cwd, remoteCwd); // .env etc, not carried by git
  } else {
    ssh(host, `mkdir -p ${shq(remoteCwd)}`);
    rsyncUp(host, s.cwd, remoteCwd, { delete: true });
  }
  // 3. transcript
  rsyncFileInto(host, s.jsonlPath, remoteProjectDir);

  return { sessionId, localCwd: s.cwd, remoteCwd, remoteProjectDir };
}

/**
 * Pull a session's latest state back to local. Transcript via rsync; working
 * tree via git fast-forward (no clobber) for repos, else rsync. Returns
 * whether the working-tree pull fast-forwarded cleanly.
 */
export function pullSession(sessionId: string, host: RemoteHost, move: MoveResult): { ff: boolean; reason?: string } {
  // transcript back (rsync into the project dir)
  const remoteJsonl = path.posix.join(move.remoteProjectDir, `${sessionId}.jsonl`);
  const localProjectDir = path.join(CLAUDE_PROJECTS, cwdToSlug(move.localCwd));
  rsyncFileDownInto(host, remoteJsonl, localProjectDir);
  // working tree back
  if (isWorktree(move.localCwd)) {
    return gitPullWorktree(host, move.localCwd, move.remoteCwd);
  }
  rsyncDown(host, move.remoteCwd, move.localCwd, { delete: true });
  return { ff: true };
}

/** Copy gitignored files git won't carry (.env*, credentials) into the remote worktree. */
function copyGitignoredFiles(host: RemoteHost, localCwd: string, remoteCwd: string): void {
  const candidates = [".env", ".env.local", ".env.development", ".env.production"];
  for (const rel of candidates) {
    const local = path.join(localCwd, rel);
    if (fs.existsSync(local) && fs.statSync(local).isFile()) {
      const args = ["-az", "-e", `ssh ${sshBase(host).join(" ")}`, local, `${host.user}@${host.address}:${remoteCwd}/`];
      try { execFileSync("rsync", args, { stdio: "pipe" }); } catch { /* best-effort */ }
    }
  }
}

/**
 * Make the remote claude able to resume non-interactively in `remoteCwd`:
 *   - seed ~/.claude.json so the first-run theme/onboarding picker is skipped
 *   - pre-trust the worktree path so the folder-trust dialog is skipped
 * Without this, a resumed session hangs on an interactive prompt.
 */
export function ensureRemoteClaudeReady(host: RemoteHost, remoteCwd: string): void {
  const script = `python3 - ${shq(remoteCwd)} << 'PY'
import json, os, sys
p = os.path.expanduser("~/.claude.json")
try:
    d = json.load(open(p))
except Exception:
    d = {}
d.setdefault("hasCompletedOnboarding", True)
d.setdefault("theme", "dark")
d.setdefault("bypassPermissionsModeAccepted", True)
d.setdefault("projects", {})
d["projects"][sys.argv[1]] = {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True, "allowedTools": [], "projectOnboardingSeenCount": 1}
json.dump(d, open(p, "w"), indent=1)
print("claude ready for", sys.argv[1])
PY`;
  ssh(host, script);
}

/** Re-copy a fresh credential to the remote (the local keychain stays current;
 * the remote copy expires after ~1h). Call around remote activity. */
export function refreshRemoteCredential(host: RemoteHost): boolean {
  return copyCredentialToRemote(host);
}

/**
 * Run a one-shot prompt against the session on the remote (print mode).
 * Defaults to `acceptEdits` so a moved session can actually make code changes
 * autonomously — print mode without a permission flag silently blocks all
 * write/Bash tools (discovered in live validation).
 */
export function remotePrompt(
  host: RemoteHost,
  remoteCwd: string,
  sessionId: string,
  prompt: string,
  opts: { permissionMode?: "acceptEdits" | "bypassPermissions" | "default" } = {},
): string {
  const mode = opts.permissionMode ?? "acceptEdits";
  return ssh(
    host,
    `export PATH="$HOME/.local/bin:$PATH"; cd ${shq(remoteCwd)} && claude -p --resume ${sessionId} --permission-mode ${mode} ${shq(prompt)} --output-format json </dev/null`,
  );
}
