/**
 * `cast cloud sync <session>`: a cloud session's working tree, mirrored live
 * into a worktree on this laptop, so its edits can be read, run and tested
 * here while the agent keeps working there (the shape of Amp's `amp sync`).
 *
 * One tick: the host cuts a snapshot of the session's tree with the same
 * recipe every other transfer uses (wipSnapshot.remoteSnapshotScript: a
 * dangling commit whose parent is the host's HEAD, uncommitted and untracked
 * work included, .gitignore respected) under refs/codecast/sync/<id>, the
 * laptop fetches it over the ssh connection the host already has open, and
 * lands it: the host's HEAD becomes the worktree's HEAD, its uncommitted work
 * becomes uncommitted work here. An unchanged snapshot costs one ssh round
 * trip and nothing else.
 *
 * The laptop copy is a mirror. An edit made in it since the last tick would
 * be overwritten by the next one, so sync stops instead and says where the
 * edit is; nothing here is ever discarded.
 */

import { execFile } from "../proc.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { shq, sshBase, type RemoteHost } from "../remote/session-move.js";
import { remoteSnapshotScript, snapshotTree } from "../wipSnapshot.js";

const execFileAsync = promisify(execFile);

export const SYNC_REF_PREFIX = "refs/codecast/sync";

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) });
  return stdout.trim();
}

export interface SyncState {
  /** The last snapshot landed here. */
  sha?: string;
  /** Its tree: the laptop copy as sync left it, the test for a local edit. */
  tree?: string;
}

export type LandResult =
  | { landed: true; sha: string; changed: string[]; first: boolean }
  | { landed: false; reason: "unchanged" }
  | { landed: false; reason: "local-edit"; files: string[] };

/**
 * Land a fetched snapshot into the laptop worktree. Refuses, changing
 * nothing, when the worktree no longer matches what the last landing left.
 */
export async function landSnapshot(dir: string, sha: string, state: SyncState): Promise<LandResult> {
  if (sha === state.sha) return { landed: false, reason: "unchanged" };
  if (state.tree) {
    const now = await snapshotTree(dir);
    if (now !== state.tree) {
      const files = (await git(dir, ["diff", "--name-only", state.tree, now])).split("\n").filter(Boolean);
      return { landed: false, reason: "local-edit", files };
    }
  }
  const base = await git(dir, ["rev-parse", `${sha}^`]);
  const tree = await git(dir, ["rev-parse", `${sha}^{tree}`]);
  const changed = state.tree ? (await git(dir, ["diff", "--name-only", state.tree, tree])).split("\n").filter(Boolean) : [];
  // The index as the last landing left the tree (checked above), so a file
  // that was untracked then and is gone now is one git knows to remove.
  if (state.tree) await git(dir, ["read-tree", state.tree]);
  await git(dir, ["read-tree", "-u", "--reset", sha]); // adds, edits and deletes
  await git(dir, ["update-ref", "--no-deref", "HEAD", base]);
  await git(dir, ["reset", "-q", "--mixed", base]); // index at the host's HEAD; the tree keeps its uncommitted work
  const first = !state.tree;
  state.sha = sha;
  state.tree = tree;
  return { landed: true, sha, changed, first };
}

/** The laptop worktree a session mirrors into: created detached at the laptop repo's HEAD when missing. */
export async function ensureSyncWorktree(repoRoot: string, name: string): Promise<string> {
  const dir = path.join(repoRoot, ".codecast", "worktrees", name);
  if (!fs.existsSync(path.join(dir, ".git"))) await git(repoRoot, ["worktree", "add", "--detach", dir, "HEAD"]);
  return dir;
}

export interface SyncTickDeps {
  /** Cut the snapshot on the host; its sha. */
  snapshot: () => Promise<string>;
  /** Make `sha` reachable in the laptop repo. */
  fetch: (sha: string) => Promise<void>;
}

export function sshSyncDeps(host: RemoteHost, remoteCwd: string, conversationId: string, localDir: string): SyncTickDeps {
  const ref = `${SYNC_REF_PREFIX}/${conversationId}`;
  const ssh = sshBase(host);
  return {
    snapshot: async () => {
      const { stdout } = await execFileAsync("ssh", [...ssh, `${host.user}@${host.address}`, remoteSnapshotScript({ cwd: remoteCwd, ref })], { encoding: "utf-8", timeout: 120_000 });
      const sha = stdout.trim().split("\n").pop() ?? "";
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`the host returned no snapshot for ${remoteCwd}`);
      return sha;
    },
    fetch: async (sha) => {
      if ((await git(localDir, ["cat-file", "-t", sha]).catch(() => "")) === "commit") return;
      await git(localDir, ["fetch", "--quiet", "--no-tags", `ssh://${host.user}@${host.address}${remoteCwd}`, `+${ref}:${ref}`], {
        GIT_SSH_COMMAND: `ssh ${ssh.map(shq).join(" ")}`,
      });
    },
  };
}

/** One tick: snapshot, fetch when new, land. */
export async function syncTick(localDir: string, state: SyncState, deps: SyncTickDeps): Promise<LandResult> {
  const sha = await deps.snapshot();
  if (sha === state.sha) return { landed: false, reason: "unchanged" };
  await deps.fetch(sha);
  return landSnapshot(localDir, sha, state);
}
