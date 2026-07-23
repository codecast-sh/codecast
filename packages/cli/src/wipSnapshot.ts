/**
 * Carrying a session's REAL working tree between machines.
 *
 * A session reparented onto another machine used to arrive as a plain `git clone`
 * of its remote: the default branch, and only work that had been pushed. Anything
 * uncommitted, committed-but-unpushed, or untracked stayed behind, and the agent
 * woke up on the wrong branch with its recent work missing (ct-38955, ct-38956).
 *
 * The fix is a snapshot built with git plumbing rather than porcelain:
 *
 *   GIT_INDEX_FILE=<temp> git read-tree HEAD && git add -A     # stage into a TEMP index
 *   git commit-tree <tree> -p HEAD -m "..."                    # dangling commit
 *   git push <remote> <snap>:refs/codecast/wip/<session>       # hidden ref
 *
 * Four properties make this the right mechanism, and each is load-bearing:
 *
 * 1. NON-DESTRUCTIVE. A temp index means the real index, branch, and working tree
 *    are never touched — the source machine cannot tell this ran. (Contrast
 *    session-move.ts's wipSnapshot(), which commits onto your real branch and
 *    leaves the junk commit there forever.)
 * 2. COMPLETE. One commit object carries uncommitted edits, untracked files, and
 *    binaries; unpushed commits ride along as ancestors of its parent. Nothing is
 *    reconstructed from tool calls, so bash-mediated and hand edits are included —
 *    the tree is ground truth, an edit log is a story about it.
 * 3. SECRETS CANNOT TRAVEL. `git add -A` respects .gitignore, so a gitignored
 *    .env is excluded by git itself. This is stronger than a deny list: there is
 *    no list to keep current and no bug that could add one.
 * 4. NEVER TOUCHES A REAL BRANCH. The snapshot goes to a hidden ref, never to
 *    refs/heads/*, so pushing a session's unpushed commits can't rewrite a shared
 *    branch or trigger CI. `git ls-remote --heads` does not list it.
 *
 * The branch name is the one fact a commit cannot carry, so it rides in the
 * snapshot's message as a trailer: the ref is then self-describing, and restoring
 * needs nothing from the database.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Hidden ref namespace. Verified against real GitHub: the push is accepted and
 * `ls-remote --heads` does not list it. Not refs/heads/* — see property 4. */
export const WIP_REF_PREFIX = "refs/codecast/wip";

const BRANCH_TRAILER = "codecast-branch";
const SESSION_TRAILER = "codecast-session";

export interface WipSnapshot {
  /** The snapshot commit. Its parent is the source's real HEAD. */
  sha: string;
  /** The source's real HEAD — where the destination should land. */
  base: string;
  /** Branch checked out on the source. */
  branch: string;
  /** Whether the source had uncommitted/untracked work at snapshot time. */
  dirty: boolean;
  /** Tree hash — cheap identity for "has anything changed since last time". */
  tree: string;
}

/** Where a session's snapshot lives on the remote. */
export function wipRef(conversationId: string): string {
  return `${WIP_REF_PREFIX}/${conversationId}`;
}

/**
 * Every git call here is async on purpose. This module runs inside the daemon's
 * flush loop, and both of its heavy operations block for real time: `add -A`
 * walks the entire worktree, and `push` is network-bound. A sync exec in that
 * loop is how the daemon once froze past the watchdog's 180s stale-heartbeat
 * threshold and got force-restarted mid-move.
 */
async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    ...(env ? { env } : {}),
  });
  return stdout.trim();
}

async function gitTry(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    return await git(cwd, args, env);
  } catch (e) {
    console.error("[wip-debug gitTry]", args.join(" "), e);
    return null;
  }
}

/**
 * Build the snapshot commit message. The branch is the only fact the commit graph
 * can't express, so it travels here — that keeps the ref self-describing, so a
 * restore never needs a database lookup to know where to land.
 */
export function buildSnapshotMessage(opts: { branch: string; conversationId?: string }): string {
  const lines = [`codecast wip snapshot`, ``, `${BRANCH_TRAILER}: ${opts.branch}`];
  if (opts.conversationId) lines.push(`${SESSION_TRAILER}: ${opts.conversationId}`);
  return lines.join("\n");
}

/** Read a trailer back out of a snapshot message. Returns undefined when absent
 * (an unrecognized/foreign ref must degrade, never throw). */
export function parseSnapshotTrailer(message: string, key: string): string | undefined {
  const m = message.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"));
  return m ? m[1].trim() : undefined;
}

/**
 * Capture the working tree as a dangling commit. Returns null when `cwd` isn't a
 * git worktree or has no commits (nothing to parent onto).
 *
 * Always creates a commit, even on a clean tree: the destination needs the branch
 * name and any unpushed commits regardless of dirtiness, and a uniform "snapshot
 * always has HEAD as its parent" shape removes a whole class of conditional at the
 * restore end. A clean snapshot is cheap — it reuses HEAD's existing tree object.
 */
export async function createWipSnapshot(
  cwd: string,
  opts: { conversationId?: string } = {},
): Promise<WipSnapshot | null> {
  const head = await gitTry(cwd, ["rev-parse", "HEAD"]);
  if (!head) return null; // not a repo, or no commits yet

  const branch = (await gitTry(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? "HEAD";
  const dirty = !!(await gitTry(cwd, ["status", "--porcelain"]));

  // A temp index is what makes this invisible to the source: `git add -A` stages
  // into THIS file, leaving the real .git/index untouched, so a staged-but-
  // uncommitted change in the user's index survives unharmed.
  const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-wip-"));
  const indexFile = path.join(indexDir, "index");
  try {
    const env = { ...process.env, GIT_INDEX_FILE: indexFile };
    await git(cwd, ["read-tree", "HEAD"], env);
    await git(cwd, ["add", "-A"], env); // respects .gitignore — secrets excluded by git itself
    const tree = await git(cwd, ["write-tree"], env);

    // commit-tree writes a dangling object: no ref moves, no branch advances.
    const sha = await git(cwd, [
      "commit-tree",
      tree,
      "-p",
      head,
      "-m",
      buildSnapshotMessage({ branch, conversationId: opts.conversationId }),
    ]);
    return { sha, base: head, branch, dirty, tree };
  } catch (e) {
    console.error("[wip-debug]", e);
    return null;
  } finally {
    try {
      fs.rmSync(indexDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Push a snapshot to its hidden ref. Force, because the ref is a mailbox holding
 * only the latest state — its history is worthless and old snapshots should fall
 * out of the remote's GC.
 */
export async function pushWipSnapshot(
  cwd: string,
  opts: { remote: string; conversationId: string; sha: string },
): Promise<{ ok: boolean; error?: string; permanent?: boolean }> {
  try {
    await git(cwd, ["push", "--force", opts.remote, `${opts.sha}:${wipRef(opts.conversationId)}`]);
    return { ok: true };
  } catch (e) {
    const err = e as { stderr?: string | Buffer; message?: string };
    const error = (err.stderr?.toString() || err.message || String(e)).slice(0, 300);
    return { ok: false, error, permanent: isPermanentPushFailure(error) };
  }
}

/**
 * Is this push failure worth retrying?
 *
 * A session's repo is whatever the agent happened to be working in, which is
 * often one the user can READ but not WRITE (a public repo they cloned, a repo
 * whose access was revoked). That never becomes pushable by waiting, so retrying
 * it every pass buys nothing and costs a failed network call per session forever.
 * Network/transient errors are the opposite — those must keep retrying, since the
 * whole point is that a snapshot exists when the laptop closes.
 */
export function isPermanentPushFailure(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("permission to") ||
    s.includes("permission denied") ||
    s.includes("repository not found") ||
    s.includes("does not appear to be a git repository") ||
    s.includes("access denied") ||
    s.includes("authentication failed") ||
    s.includes("forbidden") ||
    s.includes("read-only")
  );
}

export interface RestoreResult {
  branch: string;
  base: string;
  /** True when the source had uncommitted work and it was reproduced here. */
  appliedWork: boolean;
  /** Set when the tree couldn't be materialized; the checkout still landed on base. */
  applyError?: string;
}

/**
 * Reproduce the source's working tree in `cwd` from its pushed snapshot.
 *
 * Lands on the source's branch at its real HEAD (fixing "a clone gives you the
 * default branch"), then reproduces the uncommitted delta as UNCOMMITTED work, so
 * the agent finds its changes as it left them rather than silently committed.
 *
 * Done with plumbing rather than a patch:
 *
 *   git checkout -B <branch> <base>   # land on the source's branch @ its real HEAD
 *   git read-tree -u --reset <snap>   # worktree + index := snapshot tree
 *   git reset --mixed <base>          # index := base; worktree KEEPS the work
 *
 * The index rewind is what leaves the tree dirty in exactly the source's shape.
 * No patch is ever serialized, which matters more than it sounds: `git diff`/`git
 * apply` round-tripping mangles binary files (base85) and is sensitive to a
 * trailing newline, and it silently mishandles deletions. read-tree moves trees
 * natively — git already does this better than a patch can.
 *
 * Returns null when no snapshot exists for the session (the normal case for a
 * source on an older CLI): the caller keeps the plain clone.
 */
export async function restoreWipSnapshot(
  cwd: string,
  opts: { remote: string; conversationId: string },
): Promise<RestoreResult | null> {
  const ref = wipRef(opts.conversationId);
  // Fetch into the same ref name locally so the object is reachable and named.
  if ((await gitTry(cwd, ["fetch", "--force", opts.remote, `${ref}:${ref}`])) === null) return null;

  const sha = await gitTry(cwd, ["rev-parse", ref]);
  if (!sha) return null;

  const message = (await gitTry(cwd, ["show", "-s", "--format=%B", sha])) ?? "";
  const branch = parseSnapshotTrailer(message, BRANCH_TRAILER);
  const base = await gitTry(cwd, ["rev-parse", `${sha}^`]);
  if (!branch || !base) return null; // foreign/non-snapshot ref — leave the clone alone

  // -B: create or reset the branch to the source's HEAD. Safe because this is a
  // fresh reparent checkout, not a tree anyone is working in.
  if ((await gitTry(cwd, ["checkout", "-B", branch, base])) === null) return null;

  // Same tree as base = the source was clean. Nothing to reproduce, and skipping
  // the rewrite keeps a clean checkout untouched.
  const snapTree = await gitTry(cwd, ["rev-parse", `${sha}^{tree}`]);
  const baseTree = await gitTry(cwd, ["rev-parse", `${base}^{tree}`]);
  if (!snapTree || snapTree === baseTree) return { branch, base, appliedWork: false };

  try {
    await git(cwd, ["read-tree", "-u", "--reset", sha]); // adds, edits AND deletes
    await git(cwd, ["reset", "-q", "--mixed", base]); // index back to base; worktree keeps work
    return { branch, base, appliedWork: true };
  } catch (e) {
    // The checkout still landed on the right branch/commit, so the session is
    // usable; the caller reports that the uncommitted delta didn't make it.
    const err = e as { stderr?: string | Buffer; message?: string };
    try {
      await git(cwd, ["reset", "-q", "--hard", base]); // don't leave a half-written tree
    } catch {}
    return {
      branch,
      base,
      appliedWork: false,
      applyError: (err.stderr?.toString() || err.message || String(e)).slice(0, 300),
    };
  }
}

/** The name of the repo's default remote, or null when it has none. */
export async function defaultRemote(cwd: string): Promise<string | null> {
  const out = await gitTry(cwd, ["remote"]);
  return out?.split("\n")[0]?.trim() || null;
}

/** Where a clobbered local tree is parked so nothing is ever unrecoverable. */
export const BACKUP_REF_PREFIX = "refs/codecast/backup";

/**
 * createWipSnapshot as a POSIX shell one-liner, for a machine reachable only over
 * SSH — it runs whatever codecast version it happens to have (often older, or a
 * compiled binary), so we cannot call our own code there. Writes the snapshot to
 * `ref` and echoes its sha.
 *
 * This duplicates createWipSnapshot's recipe in another language, which is worth
 * naming: keep the two in step. The `-m` pair reproduces buildSnapshotMessage
 * exactly (commit-tree joins paragraphs with a blank line). The identity is passed
 * inline because a bundle-cloned remote may have no user.* config.
 */
export function remoteSnapshotScript(opts: { cwd: string; ref: string }): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return [
    `cd ${q(opts.cwd)}`,
    `IDX=$(mktemp)`,
    `GIT_INDEX_FILE="$IDX" git read-tree HEAD`,
    `GIT_INDEX_FILE="$IDX" git add -A`, // respects .gitignore, same as here
    `TREE=$(GIT_INDEX_FILE="$IDX" git write-tree)`,
    `BR=$(git rev-parse --abbrev-ref HEAD)`,
    `SNAP=$(git -c user.email=codecast@local -c user.name=codecast commit-tree "$TREE" -p HEAD ` +
      `-m ${q("codecast wip snapshot")} -m "${BRANCH_TRAILER}: $BR")`,
    `rm -f "$IDX"`,
    `git update-ref ${q(opts.ref)} "$SNAP"`,
    `echo "$SNAP"`,
  ].join(" && ");
}

export type ApplyResult =
  | { ok: true; base: string; branch?: string; appliedWork: boolean; backupRef?: string }
  | { ok: false; reason: string };

/**
 * Land an already-fetched snapshot onto the CURRENT branch, fast-forward only.
 *
 * This is the `cast remote back` half: the same tree materialization as
 * restoreWipSnapshot, but with two different rules, because here we're writing
 * into a worktree the user owns rather than a throwaway reparent clone:
 *
 *  - FAST-FORWARD ONLY. If the local branch has commits the remote doesn't, we
 *    refuse and change nothing — the caller reports a conflict. restoreWipSnapshot
 *    force-moves the branch; doing that here could silently drop local commits.
 *  - BACKS UP FIRST. Reproducing the remote's tree necessarily overwrites the
 *    local one, and since a move now leaves the source dirty (its work is no
 *    longer committed away), local IS expected to be dirty here. So any local
 *    tree state is first captured as its own snapshot under refs/codecast/backup/
 *    — recoverable with `git diff <ref>` / `git checkout <ref> -- .` — before the
 *    clobber. Nothing the user had is ever unrecoverable.
 */
export async function applySnapshotFastForward(
  cwd: string,
  snapRef: string,
  opts: { now?: number } = {},
): Promise<ApplyResult> {
  const snap = await gitTry(cwd, ["rev-parse", snapRef]);
  const base = await gitTry(cwd, ["rev-parse", `${snapRef}^`]);
  if (!snap || !base) return { ok: false, reason: `no usable snapshot at ${snapRef}` };

  const head = await gitTry(cwd, ["rev-parse", "HEAD"]);
  if (!head) return { ok: false, reason: "local worktree has no HEAD" };

  // Refuse rather than clobber: local commits the remote never saw mean the two
  // genuinely diverged, which is a human decision.
  if ((await gitTry(cwd, ["merge-base", "--is-ancestor", head, base])) === null) {
    return {
      ok: false,
      reason: "local and remote diverged; not fast-forwardable. Resolve manually.",
    };
  }

  const message = (await gitTry(cwd, ["show", "-s", "--format=%B", snap])) ?? "";
  const branch = parseSnapshotTrailer(message, BRANCH_TRAILER);

  // Park whatever is here before overwriting it.
  let backupRef: string | undefined;
  if (await gitTry(cwd, ["status", "--porcelain"])) {
    const local = await createWipSnapshot(cwd);
    if (local) {
      backupRef = `${BACKUP_REF_PREFIX}/${opts.now ?? Date.now()}`;
      await gitTry(cwd, ["update-ref", backupRef, local.sha]);
    }
  }

  try {
    await git(cwd, ["reset", "-q", "--hard", base]); // ff verified + backed up above
    const snapTree = await gitTry(cwd, ["rev-parse", `${snap}^{tree}`]);
    const baseTree = await gitTry(cwd, ["rev-parse", `${base}^{tree}`]);
    if (!snapTree || snapTree === baseTree) return { ok: true, base, branch, appliedWork: false, backupRef };
    await git(cwd, ["read-tree", "-u", "--reset", snap]);
    await git(cwd, ["reset", "-q", "--mixed", base]);
    return { ok: true, base, branch, appliedWork: true, backupRef };
  } catch (e) {
    const err = e as { stderr?: string | Buffer; message?: string };
    return {
      ok: false,
      reason: `could not apply the remote's tree${backupRef ? ` (local state saved at ${backupRef})` : ""}: ${(err.stderr?.toString() || err.message || String(e)).slice(0, 200)}`,
    };
  }
}

