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

import { execFileSync, execSync, spawn, spawnSync } from "../proc.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { credentialHealth } from "../ccAccounts.js";
import { collectCopyFiles, containedRemotePath, InvalidWorkspaceManifest, manifestCopyEntries } from "../workspace/copyFiles.js";
import { laptopHome, trustOnlyBundle, type AgentAuthBundle } from "./agentAuth.js";
import { AGENT_AUTH_RECEIVER } from "./agentAuthReceiver.py.js";
import { deviceId as localDeviceId } from "./device.js";
import { readLocalConfig } from "../config/readLocalConfig.js";
import { claudeProjectDirName } from "../projectPathResolver.js";
import { applySnapshotFastForward, buildSnapshotMessage, CLOUD_SEED_EXCLUDES, createWipSnapshot, isWipSnapshotMessage, remoteSnapshotScript, SNAPSHOT_IDENTITY, snapshotTreeShell } from "../wipSnapshot.js";
import { defaultConfigDir } from "../config/configDir.js";
import { readLocalCredential, readLocalCredentialAsync } from "../ccKeychain.js";
import { remapContextPaths } from "../cloud/mirror/transform.js";
import { mirrorUntouchedInCheckoutScript } from "../cloud/mirror/apply.js";

export interface RemoteHost {
  /** SSH host/IP. */
  address: string;
  /** SSH username (Scaleway Apple Silicon: "m1"; EC2 Ubuntu: "ubuntu"). */
  user: string;
  /** Path to the private key. */
  keyPath: string;
  /** Base dir on the remote under which worktrees are placed. */
  remoteBaseDir: string; // e.g. /Users/m1/work or /home/ubuntu/work
  /** The user's home on the remote. Defaults to the macOS layout for the
   * original Scaleway hosts; Linux hosts must say /home/<user>. */
  homeDir?: string;
}

/** Where ~ is on the remote — the macOS default unless the host says otherwise. */
export function remoteHome(host: RemoteHost): string {
  return host.homeDir ?? `/Users/${host.user}`;
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

// --------------------------------------------------------------------------
// SSH / rsync primitives
// --------------------------------------------------------------------------

export function sshBase(host: RemoteHost): string[] {
  // Keepalives make a dead connection an ERROR instead of a forever-hang: on a
  // lossy mobile network a post-push ssh sat for 12 minutes mid-connection
  // (execFileSync has no timeout here — a transfer's legitimate duration is
  // unbounded, so the connection's own liveness check is the right guard).
  // The control socket reuses the authenticated connection ensureUp parked
  // (same path formula), so each transfer command skips the handshake dice on
  // networks where one handshake was measured at 36 seconds.
  const socket = path.join(os.tmpdir(), `cast-ssh-${host.user}-${host.address.replace(/[^\w.]/g, "_")}`);
  return [
    "-i", host.keyPath,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=20",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${socket}`,
    "-o", "ControlPersist=120",
  ];
}

export function ssh(host: RemoteHost, command: string, timeoutMs?: number): string {
  return execFileSync("ssh", [...sshBase(host), `${host.user}@${host.address}`, command], {
    encoding: "utf-8",
    // Hand the child the environment we hold now. bun otherwise resolves the
    // binary against the PATH it snapshotted at startup, so a PATH set after
    // launch (a test's stand-in ssh, a tool added to the path) is not seen.
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });
}

function rsyncUp(host: RemoteHost, localDir: string, remoteDir: string) {
  const args = [
    "-az", "--update",
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

export function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// --------------------------------------------------------------------------
// Git-over-SSH transport
// --------------------------------------------------------------------------

function git(cwd: string, args: string[], env?: Record<string, string>): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) }).trim();
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

/** SSH url for git push to a path on the remote. */
export function gitSshUrl(host: RemoteHost, remotePath: string): string {
  // GIT_SSH_COMMAND carries the key/options; the url is plain user@host:path.
  return `${host.user}@${host.address}:${remotePath}`;
}

export function gitEnv(host: RemoteHost): NodeJS.ProcessEnv {
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
export function ensureRemoteRepo(host: RemoteHost, localCwd: string, remotePath: string, seedFrom?: string): void {
  if (remoteRepoExists(host, remotePath)) {
    ssh(host, `cd ${shq(remotePath)} && git config receive.denyCurrentBranch updateInstead`);
    repairRemoteOrigin(host, localCwd, remotePath);
    return;
  }
  // A linked worktree of a repository the host already has a checkout of: a
  // local clone shares its objects, so only the session's snapshot crosses
  // the network.
  if (seedFrom && remoteRepoExists(host, seedFrom)) {
    ssh(host, `${cloneInto(seedFrom, remotePath)} && cd ${shq(remotePath)} && git config receive.denyCurrentBranch updateInstead`);
    repairRemoteOrigin(host, localCwd, remotePath);
    return;
  }
  // Bundle everything reachable; scp; clone on the remote.
  const bundle = path.join(os.tmpdir(), `codecast-bundle-${Date.now()}.bundle`);
  git(localCwd, ["bundle", "create", bundle, "--all"]);
  const remoteBundle = `/tmp/${path.basename(bundle)}`;
  execFileSync("scp", [...sshBase(host), bundle, `${host.user}@${host.address}:${remoteBundle}`], { stdio: "pipe" });
  // No repo-local identity: the host's ~/.gitconfig carries the mirrored
  // laptop identity or the global codecast placeholder (cloud/hostGit.ts,
  // run by pushSession before this), and a repo-local one would shadow it.
  ssh(host,
    `${cloneInto(remoteBundle, remotePath)} && ` +
    `cd ${shq(remotePath)} && git config receive.denyCurrentBranch updateInstead && rm -f ${shq(remoteBundle)}`,
  );
  fs.rmSync(bundle, { force: true });
  repairRemoteOrigin(host, localCwd, remotePath);
}

/**
 * Shell that clones `src` into `dest`. A folder already there becomes the
 * checkout rather than being replaced: the host's path mirrors this machine's,
 * so it can already hold files (ones the config mirror placed where the agent
 * config names them). Git's files land over them and the rest stay.
 */
export function cloneInto(src: string, dest: string): string {
  const d = shq(dest);
  return `mkdir -p ${d} && if [ -z "$(ls -A ${d})" ]; then git clone -q ${shq(src)} ${d}; ` +
    `else t=$(mktemp -d ${shq(`${dest}.clone-`)}XXXXXX) && git clone -q --no-checkout ${shq(src)} "$t" && mv "$t/.git" ${d}/.git && rmdir "$t" && git -C ${d} reset -q --hard; fi`;
}

/**
 * Point the remote clone's origin at the repo's REAL remote, never at the
 * transport that happened to deliver the bits.
 *
 * A bundle-cloned repo is born with origin = /tmp/<bundle file>, which macOS
 * deletes within days. From then on the machine's origin/main is a frozen
 * fiction: ancestry checks pass against stale history, `git status` reports
 * hundreds of phantom "ahead" commits, and the wip-snapshot push loop reads the
 * dead path as a permanent failure and retires the session's work sync. (All
 * three happened on m1 — the 2026-08-02 "283-commit fork" that wasn't.)
 *
 * The transfer itself never depends on origin — moves push branch-to-branch
 * over SSH — so origin's only job is to be the durable rendezvous. Set it to
 * what the SOURCE repo calls origin whenever the remote's is missing or points
 * at a local path that no longer exists there. A remote origin that is a real
 * URL is left alone: the machine may have its own credential-appropriate form
 * (SSH vs HTTPS) for the same repo.
 */
function repairRemoteOrigin(host: RemoteHost, localCwd: string, remotePath: string): void {
  let canonical: string;
  try {
    canonical = git(localCwd, ["remote", "get-url", "origin"]).trim();
  } catch {
    return; // Local repo has no origin — nothing canonical to teach the remote.
  }
  if (!canonical || canonical.startsWith("/") || canonical.startsWith("file://")) return;
  try {
    const current = ssh(host, `cd ${shq(remotePath)} && git remote get-url origin 2>/dev/null || true`).trim();
    const isDeadLocalPath = current.startsWith("/") || current.startsWith("file://");
    if (current === canonical || (current && !isDeadLocalPath)) return;
    ssh(host,
      `cd ${shq(remotePath)} && (git remote set-url origin ${shq(canonical)} 2>/dev/null || git remote add origin ${shq(canonical)})`,
    );
  } catch {
    // Best-effort: a move that worked must not fail because origin repair didn't.
  }
}

/**
 * Bring this folder's work into the host's checkout of the repository, which
 * is shared the way this folder is: other sessions may be working in it, and
 * their uncommitted edits must survive. So the work arrives as a CHANGE, never
 * as a replacement tree, the mirror image of the way home
 * (applySnapshotFastForward):
 *
 *  - The change is everything this folder did since the host last took its
 *    work: the snapshot LANDED_REF names to this folder's snapshot now
 *    (createWipSnapshot: a dangling commit through a temp index, so this
 *    folder's branch, index and tree stay exactly as they were).
 *  - It is merged three-way, here (git merge-tree), with the host's working
 *    tree as it is now. Edits to the same lines on both sides refuse the move,
 *    naming the files; nothing on the host changes.
 *  - The host applies the merged tree in one read-tree that refuses any file a
 *    host session changed in the meantime (the move then starts over), steps
 *    its branch to the newer of the two heads, and leaves the work uncommitted,
 *    so `git status` there reads like a shared folder here.
 *
 * Returns the branch and the commit the host now matches: the merged tree,
 * parented on the head the host's branch is at, as a wip snapshot
 * (verifyRemoteSync unfolds it; the way home starts from it).
 *
 * Must never run against a main checkout a shared cloud session holds on a
 * branch of its own. The callers check (cast remote move's fetchRootOccupant
 * pre-flight; devices.performMoveSessionToDevice authoritatively).
 */
export const LANDED_REF = "refs/codecast/landed";
/** Where a move parks this folder's snapshot, and then the merged commit, for the host to read. */
const INCOMING_REF = "refs/codecast/incoming";
/** The rules a host keeps in a checkout's exclude list: where its workspaces and worktrees live inside the checkout. */
export const HOST_EXCLUDES = ["/.codecast/workspaces/", "/.codecast/worktrees/"];
/** Where the host parks a snapshot of its own tree for the laptop to merge against. */
const HOST_TREE_REF = "refs/codecast/host-tree";

export async function gitPushWorktree(
  host: RemoteHost,
  localRoot: string,
  remotePath: string,
  seedFrom?: string,
): Promise<{ branch: string; head: string }> {
  const branch = currentBranch(localRoot);
  const snap = await createWipSnapshot(localRoot, { exclude: CLOUD_SEED_EXCLUDES });
  if (!snap) throw new Error(`${localRoot} has no commit to move`);
  ensureRemoteRepo(host, localRoot, remotePath, seedFrom);
  // The repo's own ignore list (.git/info/exclude) is not something a push
  // carries; without it the host snapshots files this folder never would, and
  // bringing the session home then trips over them. The host's own rules for
  // the folders its workspaces and worktrees live in are kept on top.
  const exclude = git(localRoot, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
  if (fs.existsSync(exclude)) rsyncFileInto(host, exclude, `${remotePath}/.git/info`);
  ssh(host, `cd ${shq(remotePath)} && f=$(git rev-parse --git-path info/exclude) && mkdir -p "$(dirname "$f")" && for r in ${HOST_EXCLUDES.map(shq).join(" ")}; do grep -qxF "$r" "$f" 2>/dev/null || echo "$r" >> "$f"; done`);
  const url = gitSshUrl(host, remotePath);
  const push = (sha: string) => execFileSync("git", ["-C", localRoot, "push", "--force", url, `${sha}:${INCOMING_REF}`], { env: gitEnv(host), stdio: "pipe", encoding: "utf-8" });
  push(snap.sha);
  // A host session that writes a file the merge also changes, between the
  // host's snapshot and the apply, refuses the apply; the next attempt merges
  // against the tree as it is then.
  for (let attempt = 1; ; attempt++) {
    const landing = planLanding(host, localRoot, remotePath, url, branch, snap.sha);
    if (landing.commit !== snap.sha) push(landing.commit);
    try {
      ssh(host, landing.apply);
      return { branch, head: landing.commit };
    } catch (e) {
      if (attempt >= 3) throw new Error(`the host checkout ${remotePath} kept changing under the move: ${((e as { stderr?: string }).stderr ?? String(e)).trim().slice(0, 300)}`);
    }
  }
}

/** The host's side of a landing, read and merged here; `apply` is the script that lands it there. */
function planLanding(host: RemoteHost, localRoot: string, remotePath: string, url: string, branch: string, sent: string): { commit: string; apply: string } {
  const q = shq(remotePath);
  const [hostSnap, hostBranch, branchTip, landed] = ssh(host, [
    remoteSnapshotScript({ cwd: remotePath, ref: HOST_TREE_REF, exclude: CLOUD_SEED_EXCLUDES }),
    `git rev-parse --abbrev-ref HEAD`,
    `{ git rev-parse -q --verify ${shq(`refs/heads/${branch}`)} || echo -; }`,
    `{ git rev-parse -q --verify ${LANDED_REF} || echo -; }`,
  ].join(" && ")).trim().split("\n").map((l) => l.trim());
  const refs = [HOST_TREE_REF, ...(landed !== "-" ? [LANDED_REF] : []), ...(branchTip !== "-" ? [`refs/heads/${branch}`] : [])];
  execFileSync("git", ["-C", localRoot, "fetch", "-q", "--no-write-fetch-head", url, ...refs], { env: gitEnv(host), stdio: "pipe" });

  const tree = (c: string) => git(localRoot, ["rev-parse", `${c}^{tree}`]);
  const isAncestor = (a: string, b: string) => gitSafe(localRoot, ["merge-base", "--is-ancestor", a, b]).ok;
  const hostHead = git(localRoot, ["rev-parse", `${hostSnap}^`]);
  const local = git(localRoot, ["rev-parse", `${sent}^`]);
  const hostDirty = tree(hostSnap) !== tree(hostHead);
  const sameBranch = hostBranch === branch;
  if (!sameBranch && hostDirty) {
    throw new Error(`the host checkout ${remotePath} is on ${hostBranch} with uncommitted work, and this session is on ${branch}; nothing was moved`);
  }
  // The commit the host's checkout starts from for this branch: where it is,
  // or (clean, on another branch) where its copy of this branch is.
  const start = sameBranch ? hostHead : branchTip !== "-" ? branchTip : local;
  const head = isAncestor(start, local) ? local : isAncestor(local, start) ? start : null;
  if (!head) throw new Error(`${branch} has commits on the host that this folder lacks and the other way round; nothing was moved`);
  const ours = sameBranch && hostDirty ? hostSnap : start;
  const common = gitSafe(localRoot, ["merge-base", start, local]);
  const base = sameBranch && landed !== "-" ? landed : common.ok && common.out ? common.out : start;

  const merge = spawnSync("git", ["-C", localRoot, "merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${base}`, ours, sent], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  const [merged, ...conflicts] = (merge.stdout ?? "").trim().split("\n").filter(Boolean);
  if (merge.status === 1) {
    throw new Error(`this folder and the host checkout ${remotePath} both changed ${[...new Set(conflicts)].join(", ")}; nothing was moved`);
  }
  if (merge.status !== 0 || !merged) throw new Error(`could not merge with the host checkout: ${(merge.stderr ?? "").trim().slice(0, 300)}`);
  const date = git(localRoot, ["log", "-1", "--format=%cI", head]);
  const commit = merged === tree(sent) && head === local ? sent : git(localRoot, ["commit-tree", merged, "-p", head, "-m", buildSnapshotMessage({ branch })], { ...SNAPSHOT_IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });

  const apply = [
    `cd ${q}`,
    `[ "$(git rev-parse HEAD)" = ${shq(hostHead)} ]`,
    ...(sameBranch ? [] : [`git checkout -q -B ${shq(branch)} ${shq(start)}`]),
    retreeShell(tree(ours), merged),
    `git reset -q ${shq(head)}`,
    `git update-ref ${LANDED_REF} ${shq(sent)}`,
  ].join(" && ");
  return { commit, apply };
}

/**
 * Shell that takes a checkout's work tree from tree `from` to tree `to`
 * through a throwaway index refreshed against the disk, so read-tree refuses
 * any file that is no longer what `from` says instead of overwriting it, and
 * leaves every file the two trees agree on alone. The real index is not
 * touched.
 */
function retreeShell(from: string, to: string): string {
  return `t=$(mktemp -d) && (export GIT_INDEX_FILE="$t/index"; git read-tree ${shq(from)} && { git update-index -q --refresh >/dev/null; git read-tree -m -u ${shq(from)} ${shq(to)}; }); s=$?; rm -rf "$t"; [ $s = 0 ]`;
}

/**
 * After a session's work came home, put the host checkout back to its own
 * HEAD when what is left there is only a copy of what this folder now has, so
 * the checkout is clean for whoever comes next (a shared cloud session needs
 * it clean). The caller has already found nobody else working there. Every
 * file the host changed must hold the same bytes here, or be gone in both;
 * and a file a host process touched since the way home's snapshot refuses the
 * reset. Returns why the checkout was kept, or null when it is clean now.
 */
export function clearHostLeftovers(host: RemoteHost, localRoot: string, remoteRoot: string): string | null {
  const snap = gitSafe(localRoot, ["rev-parse", "--verify", "-q", remoteBackRef(currentBranch(localRoot))]);
  if (!snap.ok) return "no snapshot of the host to compare with";
  const hostHead = git(localRoot, ["rev-parse", `${snap.out}^`]);
  const changed = git(localRoot, ["diff", "--name-only", "-z", hostHead, snap.out]).split("\0").filter(Boolean);
  if (!changed.length) return null;
  for (const rel of changed) {
    const there = gitSafe(localRoot, ["rev-parse", "--verify", "-q", `${snap.out}:${rel}`]);
    const st = fs.lstatSync(path.join(localRoot, rel), { throwIfNoEntry: false });
    const here = !st ? null : execFileSync("git", ["-C", localRoot, "hash-object", "--stdin"], {
      input: st.isSymbolicLink() ? fs.readlinkSync(path.join(localRoot, rel)) : fs.readFileSync(path.join(localRoot, rel)),
      encoding: "utf-8",
    }).trim();
    if ((there.ok ? there.out : null) !== here) return `${rel} on the host differs from this folder`;
  }
  try {
    ssh(host, `cd ${shq(remoteRoot)} && [ "$(git rev-parse HEAD)" = ${shq(hostHead)} ] && ${retreeShell(git(localRoot, ["rev-parse", `${snap.out}^{tree}`]), git(localRoot, ["rev-parse", `${hostHead}^{tree}`]))} && git reset -q`);
    return null;
  } catch {
    return "the host checkout changed after its work came home";
  }
}

/** Ref the remote parks its snapshot on for us to fetch. Per-branch so two
 * sessions coming back from the same remote can't tread on each other. */
function remoteBackRef(branch: string): string {
  return `refs/codecast/back/${branch}`;
}

/**
 * Pull the remote's work back (fast-forward only; never drops local commits).
 *
 * The remote used to `git add -A && git commit` its uncommitted work onto its
 * branch, which we then fast-forwarded into — so bringing a session home left a
 * "codecast-remote: wip snapshot" commit on YOUR branch and turned the agent's
 * uncommitted work into a commit you never made (ct-39063). Now the remote builds
 * a dangling snapshot instead (same recipe as createWipSnapshot, in shell, since
 * the remote runs its own codecast version and can't call ours), and we replay it
 * here as uncommitted work on top of its real commits.
 *
 * Any local tree state is backed up to a ref before it's overwritten — see
 * applySnapshotFastForward.
 */
export async function gitPullWorktree(
  host: RemoteHost,
  localCwd: string,
  remotePath: string,
  start?: string,
): Promise<{ ff: boolean; reason?: string; appliedWork?: boolean; conflicts?: string[] }> {
  const branch = currentBranch(localCwd);
  const ref = remoteBackRef(branch);
  let skip: string[] = [];
  try {
    skip = ssh(host, `python3 -c ${shq(mirrorUntouchedInCheckoutScript())} ${shq(remotePath)} 2>/dev/null || true`).split("\n").filter(Boolean);
  } catch { /* no stamp read: every change comes home */ }
  try {
    ssh(host, remoteSnapshotScript({ cwd: remotePath, ref, exclude: CLOUD_SEED_EXCLUDES }));
  } catch (e) {
    const err = e as { stderr?: Buffer; message?: string };
    return { ff: false, reason: `could not snapshot the remote worktree: ${(err.stderr?.toString() || err.message || String(e)).slice(0, 200)}` };
  }
  try {
    execFileSync("git", ["-C", localCwd, "fetch", "--force", gitSshUrl(host, remotePath), `${ref}:${ref}`],
      { env: gitEnv(host), stdio: "pipe" });
  } catch (e) {
    const err = e as { stderr?: Buffer; message?: string };
    return { ff: false, reason: `could not fetch the remote snapshot: ${(err.stderr?.toString() || err.message || String(e)).slice(0, 200)}` };
  }
  const applied = await applySnapshotFastForward(localCwd, ref, { start, skip });
  if (!applied.ok) return { ff: false, reason: applied.reason };
  return { ff: true, appliedWork: applied.appliedWork, conflicts: applied.conflicts };
}

// --------------------------------------------------------------------------
// Auth: copy a FRESH credential to the remote
// --------------------------------------------------------------------------

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
  return gatePushableCredential(readLocalCredential());
}

export async function readPushableCredentialAsync(): Promise<{ cred: string | null; reason?: string }> {
  return gatePushableCredential(await readLocalCredentialAsync());
}

function gatePushableCredential(cred: string | null): { cred: string | null; reason?: string } {
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
  const gate = await readPushableCredentialAsync();
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
// Provider API keys (pl-207): the per-user managed-key store syncs device→device
// exactly like the CC credential — piped over ssh stdin into the remote's 0600
// store file, so the secret never lands on local disk or in argv, and never in
// Convex. The remote daemon reads the file it lands in for its launch injection.
// --------------------------------------------------------------------------

/** ssh argv that writes stdin to the remote's provider-key store (0600 via umask). */
function providerKeysPushArgs(host: RemoteHost): string[] {
  return [...sshBase(host), `${host.user}@${host.address}`, "umask 077; mkdir -p ~/.codecast; cat > ~/.codecast/provider-keys.json"];
}

export interface ProviderKeysPushOutcome {
  pushed: boolean;
  reason?: string;
}

/**
 * Copy the provider-key store blob to a remote host. `blob` is the exact serialized
 * store (from writeProviderKeyStore); an empty/absent store passes null, which
 * removes the remote file so a cleared key clears everywhere. Async (mirrors the
 * credential push) with a hard 60s kill so a wedged ssh can't leak.
 */
export async function copyProviderKeysToRemoteAsync(host: RemoteHost, blob: string | null): Promise<ProviderKeysPushOutcome> {
  // No local keys → remove the remote store so "cleared here" means "cleared there".
  const argv = blob === null
    ? [...sshBase(host), `${host.user}@${host.address}`, "rm -f ~/.codecast/provider-keys.json"]
    : providerKeysPushArgs(host);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ssh", argv, { stdio: ["pipe", "ignore", "pipe"] });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("provider-key push timed out")); }, 60_000);
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr += d; });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ssh exited ${code}: ${stderr.slice(0, 200)}`));
    });
    if (blob !== null) { child.stdin.write(blob); }
    child.stdin.end();
  });
  return { pushed: true };
}

// --------------------------------------------------------------------------
// Agent logins (codex, grok, gemini, opencode, pi + provider keys from
// settings.json): ONE bundle, ONE ssh round trip, applied on the host by the
// python receiver (remote/agentAuthReceiver.py.ts). Same transport rules as
// the credential push: ssh stdin only, umask 077, hard 60s kill.
// --------------------------------------------------------------------------

/** ssh argv that runs the receiver with the bundle JSON on stdin. */
function agentAuthPushArgs(host: RemoteHost): string[] {
  return [...sshBase(host), `${host.user}@${host.address}`, `umask 077; python3 -c ${shq(AGENT_AUTH_RECEIVER)}`];
}

export interface AgentAuthPushOutcome {
  pushed: boolean;
  /** Files the host kept instead of overwriting (`codex host-fresher`). */
  kept: string[];
  /** Why nothing landed: the host holds another user's logins (exit 3), a transport failure, an older host. */
  reason?: string;
  files?: number;
  deleted?: number;
  /** settings.json env keys the host now mirrors. */
  env?: string[];
  trust?: number;
  /** Per-file errors the receiver reported (`<path>:<why>`). */
  errors?: string[];
  unparseableSettings?: boolean;
}

export const AGENT_AUTH_OTHER_USER_REASON = "host holds another user's logins";

/** The receiver's stdout + exit status as an outcome. Exported for the daemon's and the tests' benefit. */
export function parseAgentAuthReceiverOutput(stdout: string, status: number | null, stderr = ""): AgentAuthPushOutcome {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (status === 3 || lines.includes("refused:other-user")) return { pushed: false, kept: [], reason: AGENT_AUTH_OTHER_USER_REASON };
  const applied = [...lines].reverse().find((l) => l.startsWith("applied "));
  if (status !== 0 || !applied) {
    const detail = stderr.trim().split("\n").filter(Boolean).pop() ?? lines.filter((l) => l.startsWith("error:")).pop() ?? "";
    const older = /python3: (command )?not found|No such file/.test(stderr) ? "python3 missing on the host" : "";
    return { pushed: false, kept: [], reason: older || `receiver exited ${status ?? "by signal"}${detail ? `: ${detail.slice(0, 200)}` : ""}` };
  }
  const field = (name: string) => new RegExp(`\\b${name}=(\\S*)`).exec(applied)?.[1] ?? "";
  const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
  const errors = lines.filter((l) => l.startsWith("error:")).map((l) => l.slice("error:".length));
  return {
    pushed: true,
    kept: list(field("kept")).map((k) => k.replace(/:/g, " ")),
    files: Number(field("files")) || 0,
    deleted: Number(field("deleted")) || 0,
    env: list(field("env")),
    trust: Number(field("trust")) || 0,
    ...(errors.length ? { errors } : {}),
    ...(lines.includes("settings:unparseable") ? { unparseableSettings: true } : {}),
  };
}

/**
 * Push an agent auth bundle to a host (sync — the prepare path). Transport
 * failures come back as `pushed:false` with a reason rather than throwing:
 * a host with the Claude login alone is still useful.
 */
export function copyAgentAuthToRemote(host: RemoteHost, bundle: AgentAuthBundle): AgentAuthPushOutcome {
  const r = spawnSync("ssh", agentAuthPushArgs(host), {
    input: JSON.stringify(bundle), encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: process.env,
  });
  if (r.error) return { pushed: false, kept: [], reason: `ssh failed (${(r.error as NodeJS.ErrnoException).code ?? r.error.message})` };
  return parseAgentAuthReceiverOutput(r.stdout ?? "", r.status, r.stderr ?? "");
}

/** Async twin for the daemon's timers: a sync ssh would block the event loop. Hard 60s SIGKILL. */
export async function copyAgentAuthToRemoteAsync(host: RemoteHost, bundle: AgentAuthBundle): Promise<AgentAuthPushOutcome> {
  return new Promise<AgentAuthPushOutcome>((resolve) => {
    const child = spawn("ssh", agentAuthPushArgs(host), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (o: AgentAuthPushOutcome) => { if (!settled) { settled = true; clearTimeout(timer); resolve(o); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); done({ pushed: false, kept: [], reason: "agent auth push timed out" }); }, 60_000);
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
    child.on("error", (err) => done({ pushed: false, kept: [], reason: `ssh failed (${err.message})` }));
    child.on("close", (code) => done(parseAgentAuthReceiverOutput(stdout, code, stderr)));
    child.stdin.on("error", () => { /* the receiver exited first; close reports it */ });
    child.stdin.write(JSON.stringify(bundle));
    child.stdin.end();
  });
}

/**
 * A trust-only bundle for a moved session's top-level dir on the host
 * (`cast remote move`): codex on 0.153.4 trusts a worktree under a trusted
 * checkout, but a moved session's remoteCwd is its own directory under
 * ~/work, so it needs its own `[projects."…"]` table. No files, no env, no
 * stamp. Needs this laptop's login for the receiver's identity check.
 */
export function ensureRemoteCodexTrust(host: RemoteHost, remoteCwd: string, origin?: { userId: string; deviceId: string }): AgentAuthPushOutcome {
  let who = origin;
  if (!who) {
    const cfg = readLocalConfig();
    if (cfg?.user_id) who = { userId: cfg.user_id, deviceId: localDeviceId() };
  }
  if (!who) return { pushed: false, kept: [], reason: "not logged in on this laptop — cast login" };
  return copyAgentAuthToRemote(host, trustOnlyBundle(who, [remoteCwd]));
}

// --------------------------------------------------------------------------
// Push / Pull
// --------------------------------------------------------------------------

export interface SyncVerification {
  branch: string;
  /** The commit the remote's branch is expected to be at: this folder's HEAD
   * (a pushed snapshot is unfolded back to its parent, see gitPushWorktree). */
  localHead: string;
  remoteHead: string | null;
  headsMatch: boolean;
  /** Changes in the remote's tree beyond what was handed over (0 = exactly the
   * handed-over tree); null when the check itself failed. */
  remoteDirty: number | null;
}

/**
 * Prove the transfer landed: the remote checkout must sit at this folder's
 * commit with this folder's working tree. updateInstead + the checkout/reset
 * in gitPushWorktree should guarantee this — this check is what turns
 * "should" into a fact the move can report (and the moved agent can be told)
 * instead of a silent assumption. Best-effort: an unreachable remote reads as
 * heads-unknown, never as a throw that aborts the move.
 *
 * `expectedHead` is what the push actually sent. Pass it whenever a snapshot was
 * pushed: the remote then sits at the snapshot's parent with the snapshot's tree
 * uncommitted in its folder. Omitted (e.g. `cast remote back`), it falls back to
 * the local tip and a clean remote tree.
 */
export function verifyRemoteSync(
  host: RemoteHost,
  localCwd: string,
  remoteCwd: string,
  expectedHead?: string,
): SyncVerification {
  const branch = currentBranch(localCwd);
  const sent = expectedHead ?? git(localCwd, ["rev-parse", "HEAD"]);
  const unfolded = !!expectedHead && isWipSnapshotMessage(gitSafe(localCwd, ["show", "-s", "--format=%B", sent]).out);
  const localHead = unfolded ? git(localCwd, ["rev-parse", `${sent}^`]) : sent;
  const tree = git(localCwd, ["rev-parse", `${sent}^{tree}`]);
  let remoteHead: string | null = null;
  let remoteDirty: number | null = null;
  try {
    // The remote's working tree as a tree id, through a throwaway index (the
    // same recipe as snapshotTree), so uncommitted and untracked work count.
    const lines = ssh(
      host,
      `cd ${shq(remoteCwd)} && git rev-parse HEAD && t=$(mktemp -d) && (${snapshotTreeShell("$t/index", CLOUD_SEED_EXCLUDES)} && GIT_INDEX_FILE="$t/index" git diff-index --cached --name-only ${shq(tree)} | wc -l); s=$?; rm -rf "$t"; exit $s`,
    ).trim().split("\n");
    remoteHead = lines[0]?.trim() || null;
    const dirty = parseInt(lines[2]?.trim() ?? "", 10);
    remoteDirty = lines[1]?.trim() === tree ? 0 : Number.isNaN(dirty) ? null : dirty;
  } catch { /* verification unavailable — report unknown, don't block the move */ }
  return { branch, localHead, remoteHead, headsMatch: remoteHead === localHead, remoteDirty };
}

export interface MoveResult {
  sessionId: string;
  localCwd: string;
  remoteCwd: string;
  /** The host checkout the session's folder is in (repositories only). */
  remoteRoot?: string;
  remoteProjectDir: string;
  /** Present for git worktrees; rsync'd plain directories have no cheap
   * content proof. */
  verification?: SyncVerification;
  /** The commit this push landed: the folder's snapshot, uncommitted work included. */
  pushedHead?: string;
}

/**
 * Where a folder of this machine lives on the host: the same place under the
 * host's home (`~/src/codecast` here is `~/src/codecast` there), so a path
 * reads the same on both. The home itself and folders outside it have no such
 * place and go under `remoteBaseDir` by name. For a repository it is the MAIN
 * checkout there: where every moved session lands (merged in, see
 * gitPushWorktree), the path a shared cloud session holds, and where cloud
 * prepare clones.
 */
export function remoteRepoPath(host: RemoteHost, localGitRoot: string): string {
  const rel = path.relative(laptopHome(), localGitRoot);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return path.posix.join(remoteHome(host), ...rel.split(path.sep));
  return path.posix.join(host.remoteBaseDir, path.basename(localGitRoot));
}

/**
 * Moves once landed beside a busy host checkout in a clone of their own
 * (`<checkout>-mv-<batch>`); they merge into the checkout now, and the clones
 * left on hosts are swept once nothing holds them (hostDiskSweep). A clone
 * stands in for its checkout the way a worktree does: the session belongs to
 * the same repository, so its root (and the project the app names it by) is
 * the checkout's, not the clone folder's.
 */
export const MOVE_CLONE_RE = /-mv-[a-z0-9]+$/;

/** The checkout a move clone stands in for, or `root` itself when it is not one (or that checkout is gone). */
export function checkoutOfMoveClone(root: string, exists: (p: string) => boolean = (p) => fs.existsSync(path.join(p, ".git"))): string {
  if (!MOVE_CLONE_RE.test(root)) return root;
  const main = root.replace(MOVE_CLONE_RE, "");
  return exists(main) ? main : root;
}

/**
 * Push a local session to the remote Mac. Returns the remote placement.
 *
 * `skipTree`: the working tree at this session's cwd was already pushed to
 * the same host moments ago (a bulk migration moving several sessions that
 * share one worktree) — only the transcript and credential go this time. The
 * tree push is idempotent for git worktrees, but a plain directory rsyncs
 * with --delete, and two sessions in one directory must not race that.
 */
export async function pushSession(sessionId: string, host: RemoteHost, opts: { skipTree?: boolean; pushedHead?: string } = {}): Promise<MoveResult> {
  const s = resolveLocalSession(sessionId);
  // The checkout moves whole, and the session lands in the same folder of it
  // it ran in here (a session in packages/web resumes in packages/web).
  const repo = isWorktree(s.cwd);
  const root = repo ? gitRootOf(s.cwd) : s.cwd;
  const remoteRoot = remoteRepoPath(host, root);
  const remoteCwd = path.posix.join(remoteRoot, ...path.relative(root, s.cwd).split(path.sep).filter(Boolean));
  const remoteProjectDir = path.posix.join(
    remoteHome(host), ".claude", "projects",
    claudeProjectDirName(remoteCwd),
  );

  // 1. credential (fresh — token TTL ~1h). An unusable local credential skips
  //    (never replicate a logged-out/expired blob); the daemon's push loop
  //    heals the remote within a minute of the local login recovering.
  const credPush = copyCredentialToRemote(host);
  if (!credPush.pushed) {
    console.error(`WARNING: credential not pushed (${credPush.reason}) — the moved session will hit "Login expired" until the local login is healthy`);
  }
  // 2. host git readiness BEFORE the first commit lands there: known_hosts,
  //    the device key, and the mirrored identity (or the global placeholder)
  //    in the host's ~/.gitconfig. Non-fatal: a move must not be lost to it.
  if (repo) {
    try {
      const { ensureHostGitReady } = await import("../cloud/hostGit.js");
      ensureHostGitReady(host, { localGitRoot: root, repoPath: remoteRoot, onProgress: (m) => console.error(`  ${m}`) });
    } catch (err) {
      console.error(`WARNING: host git setup skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // 3. working tree — git-over-SSH for repos (full git on the remote), else rsync
  let verification: SyncVerification | undefined;
  let pushedHead: string | undefined;
  if (opts.skipTree) {
    // Nothing to push; prove the tree is still there and at the tip the
    // sibling pushed (its snapshot, never this folder's plain HEAD).
    if (repo) verification = verifyRemoteSync(host, root, remoteRoot, opts.pushedHead);
  } else if (repo) {
    // A linked worktree seeds from the host's checkout of its main repository.
    const main = path.dirname(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    const { head } = await gitPushWorktree(host, root, remoteRoot, main !== root ? remoteRepoPath(host, main) : undefined);
    pushedHead = head;
    copyGitignoredFiles(host, root, remoteRoot); // .env etc, not carried by git
    // Verify against what landed (the merged commit), not local HEAD.
    verification = verifyRemoteSync(host, root, remoteRoot, head);
  } else {
    // Other sessions may share the host's copy of this folder too: nothing
    // there is deleted, and a file changed there more recently than here stays.
    ssh(host, `mkdir -p ${shq(remoteCwd)}`);
    rsyncUp(host, s.cwd, remoteCwd);
  }
  // 4. transcript, its laptop paths rewritten to the host's
  const relocated = relocatedTranscriptCopy(s.jsonlPath, { home: laptopHome(), cwd: s.cwd }, { home: remoteHome(host), cwd: remoteCwd });
  try {
    rsyncFileInto(host, relocated.file, remoteProjectDir);
  } finally {
    fs.rmSync(relocated.dir, { recursive: true, force: true });
  }

  return { sessionId, localCwd: s.cwd, remoteCwd, ...(repo ? { remoteRoot } : {}), remoteProjectDir, verification, pushedHead };
}

/**
 * A transcript's text as the machine it lands on reads it: the checkout, the
 * project's Claude directory and the home each rewritten from one machine's
 * path to the other's (longest first), so a resumed agent's history names
 * files that exist where it now runs. Only whole paths change: a path that
 * merely starts with the checkout's name is left alone.
 */
export function relocateTranscript(text: string, from: { home: string; cwd: string }, to: { home: string; cwd: string }): string {
  const projects = (m: { home: string; cwd: string }) => path.posix.join(m.home, ".claude", "projects", claudeProjectDirName(m.cwd));
  return remapContextPaths(text, {
    fromHome: from.home,
    toHome: to.home,
    pathMappings: [{ from: projects(from), to: projects(to) }, { from: from.cwd, to: to.cwd }],
  });
}

/** The transcript relocated into a temp directory under its own name (rsyncFileInto keeps the basename); the caller removes the directory. */
function relocatedTranscriptCopy(jsonlPath: string, from: { home: string; cwd: string }, to: { home: string; cwd: string }): { file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-move-transcript-"));
  const file = path.join(dir, path.basename(jsonlPath));
  fs.writeFileSync(file, relocateTranscript(fs.readFileSync(jsonlPath, "utf-8"), from, to), { mode: 0o600 });
  return { file, dir };
}

/** The top level of the checkout a session runs in — a linked worktree's OWN root, not the main repository's. */
export function gitRootOf(cwd: string): string {
  return gitSafe(cwd, ["rev-parse", "--show-toplevel"]).out.trim() || cwd;
}

/**
 * Pull a session's latest state back to local. Transcript via rsync; working
 * tree via git fast-forward (no clobber) for repos, else rsync. Returns
 * whether the working-tree pull fast-forwarded cleanly.
 */
/**
 * `aloneInCheckout`: asked once the work is home cleanly, with the host
 * checkout's path; true when no other session works there, which lets the
 * session's leftovers be cleared from it (clearHostLeftovers). Callers whose
 * session stays on the host pass nothing.
 */
export async function pullSession(
  sessionId: string,
  host: RemoteHost,
  move: MoveResult,
  opts: { aloneInCheckout?: (remoteRoot: string) => Promise<boolean> } = {},
): Promise<{ ff: boolean; reason?: string; appliedWork?: boolean; conflicts?: string[]; hostKept?: string; hostCleared?: boolean }> {
  // transcript back (rsync into the project dir)
  const remoteJsonl = path.posix.join(move.remoteProjectDir, `${sessionId}.jsonl`);
  const localProjectDir = path.join(CLAUDE_PROJECTS, claudeProjectDirName(move.localCwd));
  rsyncFileDownInto(host, remoteJsonl, localProjectDir);
  // …and its host paths rewritten back to this machine's.
  const localJsonl = path.join(localProjectDir, `${sessionId}.jsonl`);
  const tmp = `${localJsonl}.cast-relocate`;
  fs.writeFileSync(tmp, relocateTranscript(fs.readFileSync(localJsonl, "utf-8"), { home: remoteHome(host), cwd: move.remoteCwd }, { home: laptopHome(), cwd: move.localCwd }), { mode: 0o600 });
  fs.renameSync(tmp, localJsonl);
  // working tree back
  if (isWorktree(move.localCwd)) {
    // Where the host's work began: the commit this move pushed, else the one the host was at when the session landed.
    // Whole checkout to whole checkout: the session's own folder in it is only where it runs.
    const localRoot = gitRootOf(move.localCwd);
    const remoteRoot = move.remoteRoot ?? move.remoteCwd;
    const pulled = await gitPullWorktree(host, localRoot, remoteRoot, move.pushedHead ?? move.verification?.remoteHead ?? undefined);
    if (!pulled.ff || pulled.conflicts?.length || !opts.aloneInCheckout) return pulled;
    if (!(await opts.aloneInCheckout(remoteRoot).catch(() => false))) return { ...pulled, hostKept: "another session works in the host checkout" };
    const kept = clearHostLeftovers(host, localRoot, remoteRoot);
    return kept ? { ...pulled, hostKept: kept } : { ...pulled, hostCleared: true };
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
 * family when the manifest declares nothing (non-node projects, no config).
 *
 * The entries come out of a file in the repository, so they go through the
 * same strict collector the cloud path uses (workspace/copyFiles.ts) before
 * anything is joined into a path: this used to join them raw into both the
 * local worktree and the remote one, so `../../.aws/credentials` copied a file
 * outside the repository to a directory outside the remote worktree. An
 * invalid manifest fails here rather than falling back to the .env list, which
 * would hide the rejection.
 *
 * Reports what it refused through `onWarn`; a transfer that silently shrank is
 * worse than one that says why.
 */
export function copyGitignoredFiles(
  host: RemoteHost,
  localCwd: string,
  remoteCwd: string,
  // The two process boundaries are injectable so a regression can assert what
  // this WOULD transfer without an ssh or an rsync ever running.
  opts: { onWarn?: (msg: string) => void; rsync?: (args: string[]) => void; mkdirRemote?: (dir: string) => void } = {},
): string[] {
  const warn = opts.onWarn ?? ((m: string) => console.error(`WARNING: ${m}`));
  const rsync = opts.rsync ?? ((args: string[]) => { execFileSync("rsync", args, { stdio: "pipe" }); });
  const mkdirRemote = opts.mkdirRemote ?? ((d: string) => { ssh(host, `mkdir -p ${shq(d)}`); });

  let root: string;
  try {
    root = fs.realpathSync(localCwd);
  } catch {
    return [];
  }

  let candidates: string[] = [];
  try {
    candidates = manifestCopyEntries(root);
  } catch (err) {
    // A manifest that exists and does not parse is a declaration this transfer
    // must not guess around. A resolver that could not run at all (no git, no
    // detectable project) is the ordinary case the fallback list is for.
    if (err instanceof InvalidWorkspaceManifest) {
      warn(`setup-file copy skipped: ${err.message}`);
      return [];
    }
  }
  if (candidates.length === 0) {
    candidates = [".env", ".env.local", ".env.development", ".env.production"];
  }

  let files: string[];
  try {
    files = collectCopyFiles(root, candidates);
  } catch (err) {
    warn(`setup-file copy refused: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const copied: string[] = [];
  for (const rel of files) {
    let destDir: string;
    try {
      destDir = path.posix.dirname(containedRemotePath(remoteCwd, rel));
    } catch (err) {
      warn(`setup-file copy refused: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const local = path.join(root, rel);
    const args = ["-az", "-e", `ssh ${sshBase(host).join(" ")}`, local, `${host.user}@${host.address}:${destDir}/`];
    try {
      if (destDir !== remoteCwd) mkdirRemote(destDir);
      rsync(args);
      copied.push(rel);
    } catch { /* best-effort */ }
  }
  return copied;
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

const SCALEWAY_DIR = path.join(defaultConfigDir(), "scaleway");

/** Cheap check for the daemon's periodic refresh: is any remote Mac registered? */
export function remoteHostsRegistered(): boolean {
  return fs.existsSync(path.join(SCALEWAY_DIR, "hosts.json"));
}

/**
 * Every usable Scaleway Mac, as RemoteHosts. Stopped entries are excluded —
 * a Mac marked stopped is gone or deliberately retired, and pushing
 * credentials at a dead IP is a failure log on every tick for nothing.
 */
export function listScalewayHosts(): RemoteHost[] {
  const hostsFile = path.join(SCALEWAY_DIR, "hosts.json");
  if (!fs.existsSync(hostsFile)) return [];
  try {
    const { hosts } = JSON.parse(fs.readFileSync(hostsFile, "utf-8")) as {
      hosts: Array<{ id: string; address: string; sshUsername: string; stopped?: boolean }>;
    };
    return hosts.filter((h) => !h.stopped).map((h) => {
      const perHost = path.join(SCALEWAY_DIR, h.id, "id_ed25519");
      const fallback = path.join(SCALEWAY_DIR, "d7_id_ed25519");
      return {
        address: h.address,
        user: h.sshUsername || "m1",
        keyPath: fs.existsSync(perHost) ? perHost : fallback,
        remoteBaseDir: `/Users/${h.sshUsername || "m1"}/work`,
      };
    });
  } catch {
    return [];
  }
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
export async function performMoveToRemote(host: RemoteHost, sessionId: string): Promise<MoveResult> {
  const move = await pushSession(sessionId, host);
  ensureRemoteClaudeReady(host, move.remoteCwd);
  // codex's folder trust for the moved dir (its own `[projects."…"]` table:
  // a top-level dir under ~/work is not a worktree under a trusted checkout).
  const trust = ensureRemoteCodexTrust(host, move.remoteCwd);
  if (!trust.pushed) console.error(`WARNING: codex trust for ${move.remoteCwd} not written on the host (${trust.reason})`);
  refreshRemoteCredential(host);
  // The host-home steps (cloud/prepare.ts readyHostHome): the home mirror,
  // stamp-gated and honouring cloud_mirror_enabled, plus whatever the other
  // host-home features hook in there. Each is non-fatal — a moved session
  // must not be lost to a config push.
  try {
    const { readyHostHome } = await import("../cloud/prepare.js");
    // The git step already ran in pushSession, with the moved repo in hand.
    await readyHostHome(host, { onProgress: (m) => console.error(`  ${m}`), skipGit: true });
  } catch (err) {
    console.error(`WARNING: host home steps failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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
