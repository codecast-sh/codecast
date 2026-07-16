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

import { execFileSync, execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { credentialHealth } from "../ccAccounts.js";
import { resolveManifest } from "../workspace/resolver.js";

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
 * Read the current CC credential. On macOS it lives in the Keychain (service
 * "Claude Code-credentials"); falls back to the file form (Linux / older CC).
 */
export function readLocalCredential(): string | null {
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf-8" },
    ).trim();
  } catch {
    // $HOME over os.homedir(): bun caches the latter at startup, breaking
    // $HOME-sandboxed tests; real environments always have HOME set.
    const f = path.join(process.env.HOME || os.homedir(), ".claude", ".credentials.json");
    if (!fs.existsSync(f)) return null;
    return fs.readFileSync(f, "utf-8");
  }
}

/** ssh argv that writes stdin to the remote's credential file (0600 via umask). */
function credentialPushArgs(host: RemoteHost): string[] {
  return [...sshBase(host), `${host.user}@${host.address}`, "umask 077; mkdir -p ~/.claude; cat > ~/.claude/.credentials.json"];
}

export interface CredentialPushOutcome {
  pushed: boolean;
  /** Why nothing was pushed (unusable local credential — logged-out stub,
   * expired access token, no credential at all). */
  reason?: string;
  /** The exact blob that went over the wire, so callers can dedupe pushes by
   * content instead of re-reading (and possibly racing) the store. */
  cred?: string;
}

/**
 * The local credential, gated for remote use. Only a blob with a LIVE access
 * token ships: the remote must never self-refresh (its rotated refresh token
 * would invalidate the primary's), so an expired or logged-out blob would just
 * park every remote session on "Login expired". This gate is what turned a
 * silent replicate-the-outage into a visible skip when a logged-out stub hit
 * the active store.
 */
export function readPushableCredential(): { cred: string | null; reason?: string } {
  const cred = readLocalCredential();
  const health = credentialHealth(cred);
  if (!health.pushable) return { cred: null, reason: health.reason ?? "no credential" };
  return { cred: cred! };
}

/**
 * Copy the current CC credential to the remote (the remote's claude reads the
 * FILE form). Piped via ssh stdin so the secret never lands on disk locally or
 * in argv. Skips (with a reason) when the local credential is unusable.
 */
export function copyCredentialToRemote(host: RemoteHost): CredentialPushOutcome {
  const gate = readPushableCredential();
  if (!gate.cred) return { pushed: false, reason: gate.reason };
  execFileSync("ssh", credentialPushArgs(host), { input: gate.cred });
  return { pushed: true, cred: gate.cred };
}

/**
 * Async variant for the daemon's periodic refresh: a sync ssh would block the
 * event loop (heartbeats, delivery) for the round-trip. Hard 60s kill so a
 * wedged ssh can't leak.
 */
export async function copyCredentialToRemoteAsync(host: RemoteHost): Promise<CredentialPushOutcome> {
  const gate = readPushableCredential();
  if (!gate.cred) return { pushed: false, reason: gate.reason };
  const cred = gate.cred;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ssh", credentialPushArgs(host), { stdio: ["pipe", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("credential push timed out"));
    }, 60_000);
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ssh exited ${code}: ${stderr.slice(0, 200)}`));
    });
    child.stdin.write(cred);
    child.stdin.end();
  });
  return { pushed: true, cred };
}

// --------------------------------------------------------------------------
// Push / Pull
// --------------------------------------------------------------------------

export interface SyncVerification {
  branch: string;
  localHead: string;
  remoteHead: string | null;
  headsMatch: boolean;
  /** Entries in the remote's `git status --porcelain` (0 = clean tree exactly
   * at the pushed tip); null when the check itself failed. */
  remoteDirty: number | null;
}

/**
 * Prove the transfer landed: the remote checkout must sit at the same commit
 * as the local worktree with nothing uncommitted. updateInstead + the
 * checkout/reset in gitPushWorktree should guarantee this — this check is what
 * turns "should" into a fact the move can report (and the moved agent can be
 * told) instead of a silent assumption. Best-effort: an unreachable remote
 * reads as heads-unknown, never as a throw that aborts the move.
 */
export function verifyRemoteSync(host: RemoteHost, localCwd: string, remoteCwd: string): SyncVerification {
  const branch = currentBranch(localCwd);
  const localHead = git(localCwd, ["rev-parse", "HEAD"]);
  let remoteHead: string | null = null;
  let remoteDirty: number | null = null;
  try {
    const lines = ssh(
      host,
      `cd ${shq(remoteCwd)} && git rev-parse HEAD && git status --porcelain | wc -l`,
    ).trim().split("\n");
    remoteHead = lines[0]?.trim() || null;
    const dirty = parseInt(lines[lines.length - 1]?.trim() ?? "", 10);
    remoteDirty = Number.isNaN(dirty) ? null : dirty;
  } catch { /* verification unavailable — report unknown, don't block the move */ }
  return { branch, localHead, remoteHead, headsMatch: remoteHead === localHead, remoteDirty };
}

export interface MoveResult {
  sessionId: string;
  localCwd: string;
  remoteCwd: string;
  remoteProjectDir: string;
  /** Present for git worktrees; rsync'd plain directories have no cheap
   * content proof. */
  verification?: SyncVerification;
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

  // 1. credential (fresh — token TTL ~1h). An unusable local credential skips
  //    (never replicate a logged-out/expired blob); the daemon's push loop
  //    heals the remote within a minute of the local login recovering.
  const credPush = copyCredentialToRemote(host);
  if (!credPush.pushed) {
    console.error(`WARNING: credential not pushed (${credPush.reason}) — the moved session will hit "Login expired" until the local login is healthy`);
  }
  // 2. working tree — git-over-SSH for repos (full git on the remote), else rsync
  let verification: SyncVerification | undefined;
  if (isWorktree(s.cwd)) {
    gitPushWorktree(host, s.cwd, remoteCwd);
    copyGitignoredFiles(host, s.cwd, remoteCwd); // .env etc, not carried by git
    verification = verifyRemoteSync(host, s.cwd, remoteCwd);
  } else {
    ssh(host, `mkdir -p ${shq(remoteCwd)}`);
    rsyncUp(host, s.cwd, remoteCwd, { delete: true });
  }
  // 3. transcript
  rsyncFileInto(host, s.jsonlPath, remoteProjectDir);

  return { sessionId, localCwd: s.cwd, remoteCwd, remoteProjectDir, verification };
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

/**
 * Copy gitignored files git won't carry (.env family, credentials) into the
 * remote worktree. The file list is the same one `cast ws acquire` uses —
 * the resolved workspace manifest's setup.copy (detection + workspace.toml +
 * .wt-setup-files) — so a project that declares extra secrets for local
 * worktrees automatically gets them on the remote too. Falls back to the .env
 * family when the manifest resolves to nothing (non-node projects, no config).
 */
function copyGitignoredFiles(host: RemoteHost, localCwd: string, remoteCwd: string): void {
  let candidates: string[] = [];
  try {
    candidates = resolveManifest(localCwd).setup.copy;
  } catch { /* detection failure — use the fallback list */ }
  if (candidates.length === 0) {
    candidates = [".env", ".env.local", ".env.development", ".env.production"];
  }
  for (const rel of candidates) {
    const local = path.join(localCwd, rel);
    if (!fs.existsSync(local)) continue;
    // Land nested entries in their parent dir; rsync -a recurses into dirs.
    const destDir = path.posix.join(remoteCwd, path.posix.dirname(rel.split(path.sep).join("/")));
    const args = ["-az", "-e", `ssh ${sshBase(host).join(" ")}`, local, `${host.user}@${host.address}:${destDir}/`];
    try {
      if (destDir !== remoteCwd) ssh(host, `mkdir -p ${shq(destDir)}`);
      execFileSync("rsync", args, { stdio: "pipe" });
    } catch { /* best-effort */ }
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
export function refreshRemoteCredential(host: RemoteHost): CredentialPushOutcome {
  return copyCredentialToRemote(host);
}

const SCALEWAY_DIR = path.join(os.homedir(), ".codecast", "scaleway");

/** Cheap check for the daemon's periodic refresh: is any remote Mac registered? */
export function remoteHostsRegistered(): boolean {
  return fs.existsSync(path.join(SCALEWAY_DIR, "hosts.json"));
}

/** Load a usable remote Mac host from the Scaleway registry (shared by CLI + daemon). */
export function loadRemoteHost(hostId?: string): RemoteHost {
  const hostsFile = path.join(SCALEWAY_DIR, "hosts.json");
  if (!fs.existsSync(hostsFile)) {
    throw new Error(`No remote hosts registered (${hostsFile}).`);
  }
  const { hosts } = JSON.parse(fs.readFileSync(hostsFile, "utf-8")) as {
    hosts: Array<{ id: string; address: string; sshUsername: string; stopped?: boolean }>;
  };
  const host = hostId ? hosts.find((h) => h.id === hostId) : hosts.find((h) => !h.stopped) ?? hosts[0];
  if (!host) throw new Error(`No usable remote host found in ${hostsFile}`);
  const perHost = path.join(SCALEWAY_DIR, host.id, "id_ed25519");
  const fallback = path.join(SCALEWAY_DIR, "d7_id_ed25519");
  const keyPath = fs.existsSync(perHost) ? perHost : fallback;
  return {
    address: host.address,
    user: host.sshUsername || "m1",
    keyPath,
    remoteBaseDir: `/Users/${host.sshUsername || "m1"}/work`,
  };
}

/**
 * Transfer-only half of a move (the local-machine actions): push the worktree
 * (git-over-SSH), relocate the transcript, copy a fresh credential, and prep
 * remote claude (onboarding + folder trust). Returns the remote placement.
 * The OWNERSHIP flip + resume is a separate Convex mutation the caller runs.
 */
export function performMoveToRemote(host: RemoteHost, sessionId: string): MoveResult {
  const move = pushSession(sessionId, host);
  ensureRemoteClaudeReady(host, move.remoteCwd);
  refreshRemoteCredential(host);
  return move;
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
