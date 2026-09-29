/**
 * A cloud session's working folder kept in step with a copy on this laptop
 * (`cast remote sync`, the web's "Mirror edits"): the laptop copy is a
 * worktree of the laptop's repo, and the two sides trade changes both ways.
 *
 * One tick reads both sides (cloud/syncSide.ts: the same program on each, so
 * both agree on what travels) and compares each with `base`, the last state
 * they agreed on:
 *
 *   neither moved     nothing happens
 *   one side moved    its change lands on the other
 *   both moved        a three-way merge of trees (git merge-tree, in object
 *                     space; neither folder is touched to merge): a clean
 *                     result lands on both; a conflicted file holds, each
 *                     side keeping its own version, and the rest flows
 *
 * A landing refuses when its side changed after it was read (syncSide's
 * check), so an edit made mid-tick is never overwritten: the tick is simply
 * retried. The laptop's HEAD follows the host's, where the agent commits; a
 * laptop commit it leaves behind is kept under a backup ref.
 *
 * In `from_cloud` mode the laptop copy only watches: an edit made there
 * stops the sync and says where it is, instead of travelling.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawn } from "../proc.js";
import { promisify } from "node:util";
import { shq, sshBase, type RemoteHost } from "../remote/session-move.js";
import { runRemoteSide, runSide, type LandResult, type SnapshotResult, type SyncScope } from "./syncSide.js";

const execFileAsync = promisify(execFile);

export const SYNC_REF_PREFIX = "refs/codecast/sync";
export const SYNC_BACKUP_PREFIX = "refs/codecast/backup/sync";

export type SyncMode = "two_way" | "from_cloud";

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8").trim());
      else reject(new Error(`git ${args[0]}: ${Buffer.concat(err).toString("utf8").trim().split("\n").pop() || `exit ${code}`}`));
    });
    child.stdin.end(input ?? "");
  });
}

export interface SyncState {
  /** The tree both sides last agreed on. */
  base?: string;
  /** Files changed on both sides that hold until a person picks one. */
  conflicts?: string[];
}

export type TickResult =
  | { kind: "idle" }
  | { kind: "synced"; toLaptop: string[]; toHost: string[]; first?: boolean }
  | { kind: "conflict"; paths: string[]; toLaptop: string[]; toHost: string[] }
  | { kind: "retry"; side: "laptop" | "host" }
  | { kind: "local_edit"; files: string[] };

/** The host's half, over ssh in production and a local folder in tests. */
export interface HostSide {
  snapshot: () => Promise<SnapshotResult>;
  land: (sha: string, expectTree: string) => Promise<LandResult>;
  /** Make a host commit reachable here. */
  fetch: (sha: string) => Promise<void>;
  /** Make a laptop commit reachable on the host. */
  send: (sha: string) => Promise<void>;
}

export interface TickOptions {
  mode?: SyncMode;
  scope?: SyncScope;
  /** Names the refs that keep this pair's objects alive. */
  name: string;
  /** Whatever the host read, for status (skipped files, head). */
  onHost?: (snap: SnapshotResult) => void;
  onLaptop?: (snap: SnapshotResult) => void;
}

const SNAPSHOT_IDENTITY = { GIT_AUTHOR_NAME: "codecast", GIT_AUTHOR_EMAIL: "codecast@localhost", GIT_COMMITTER_NAME: "codecast", GIT_COMMITTER_EMAIL: "codecast@localhost" };

/** A commit for `tree` on `parent`, dated like the parent so the same tree always makes the same commit. */
async function commitTree(dir: string, tree: string, parent?: string): Promise<string> {
  const date = parent ? await git(dir, ["log", "-1", "--format=%cI", parent]) : "1970-01-01T00:00:00Z";
  return git(dir, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "codecast sync"], { ...SNAPSHOT_IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

const names = async (dir: string, a: string, b: string) => (await git(dir, ["diff", "--name-only", "-z", a, b])).split("\0").filter(Boolean);

/** `tree` with each of `paths` taken from `from` (or removed when `from` lacks it). */
export async function overlayTree(dir: string, tree: string, from: string, paths: string[]): Promise<string> {
  if (!paths.length || tree === from) return paths.length ? from : tree;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-overlay-"));
  try {
    const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
    await git(dir, ["read-tree", tree], env);
    const entries = (await git(dir, ["ls-tree", "-r", "-z", "--full-tree", from, "--", ...paths])).split("\0").filter(Boolean);
    const have = new Set(entries.map((e) => e.slice(e.indexOf("\t") + 1)));
    const removed = paths.filter((p) => !have.has(p));
    if (removed.length) await git(dir, ["update-index", "--force-remove", "-z", "--stdin"], env, removed.join("\0") + "\0");
    if (entries.length) {
      // ls-tree lines are "<mode> blob <sha>\t<path>"; update-index wants "<mode> <sha>\t<path>".
      const info = entries.map((e) => { const [meta, p] = [e.slice(0, e.indexOf("\t")), e.slice(e.indexOf("\t") + 1)]; const [mode, , sha] = meta.split(" "); return `${mode} ${sha}\t${p}`; });
      await git(dir, ["update-index", "--add", "-z", "--index-info"], env, info.join("\0") + "\0");
    }
    return await git(dir, ["write-tree"], env);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** A three-way merge of trees: the merged tree (conflicted files carry markers) and the conflicted paths. */
export async function mergeTrees(dir: string, base: string, laptop: string, host: string): Promise<{ tree: string; conflicts: string[] }> {
  const [b, l, h] = await Promise.all([commitTree(dir, base), commitTree(dir, laptop), commitTree(dir, host)]);
  const { stdout } = await execFileAsync("git", ["-C", dir, "merge-tree", "--write-tree", "--name-only", "-z", "--no-messages", `--merge-base=${b}`, l, h], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 })
    .catch((e: { code?: number; stdout?: string; stderr?: string }) => {
      if (e.code === 1 && e.stdout) return { stdout: e.stdout }; // 1 = conflicts, the tree is still written
      throw new Error(`merge: ${(e.stderr ?? String(e)).trim().split("\n").pop()}`);
    });
  const [tree = "", ...rest] = stdout.split("\0");
  return { tree, conflicts: [...new Set(rest.filter(Boolean))] };
}

/** One tick. Mutates `state` only once a landing has happened. */
export async function syncTick(dir: string, state: SyncState, host: HostSide, opts: TickOptions): Promise<TickResult> {
  const mode = opts.mode ?? "two_way";
  const [h, l] = await Promise.all([
    host.snapshot(),
    runSide<SnapshotResult>({ op: "snapshot", cwd: dir, scope: opts.scope, commit: true }),
  ]);
  opts.onHost?.(h);
  opts.onLaptop?.(l);
  const keep = async (tree: string) => { await git(dir, ["update-ref", `${SYNC_REF_PREFIX}/${opts.name}-base`, await commitTree(dir, tree)]); state.base = tree; };
  const toLaptop = async (sha: string): Promise<string[] | null> => {
    await host.fetch(sha);
    const r = await runSide<LandResult>({ op: "land", cwd: dir, scope: opts.scope, sha, expectTree: l.tree, moveHead: h.head, backupPrefix: SYNC_BACKUP_PREFIX });
    return r.landed ? r.changed : null;
  };
  const toHost = async (sha: string): Promise<string[] | null> => {
    await host.send(sha);
    const r = await host.land(sha, h.tree);
    return r.landed ? r.changed : null;
  };

  // First tick: the laptop copy was just made from the laptop's HEAD, so the
  // host's folder is the truth.
  if (!state.base) {
    const changed = await toLaptop(h.sha!);
    if (!changed) return { kind: "retry", side: "laptop" };
    await keep(h.tree);
    return { kind: "synced", toLaptop: changed, toHost: [], first: true };
  }

  const hostMoved = h.tree !== state.base;
  const laptopMoved = l.tree !== state.base;
  if (mode === "from_cloud" && laptopMoved) return { kind: "local_edit", files: await names(dir, state.base, l.tree) };
  if (!hostMoved && !laptopMoved) return { kind: "idle" };

  if (hostMoved && !laptopMoved) {
    const changed = await toLaptop(h.sha!);
    if (!changed) return { kind: "retry", side: "laptop" };
    await keep(h.tree);
    return { kind: "synced", toLaptop: changed, toHost: [] };
  }
  if (laptopMoved && !hostMoved) {
    const changed = await toHost(l.sha!);
    if (!changed) return { kind: "retry", side: "host" };
    await keep(l.tree);
    return { kind: "synced", toLaptop: [], toHost: changed };
  }

  // Both moved.
  await host.fetch(h.sha!);
  const merged = await mergeTrees(dir, state.base, l.tree, h.tree);
  const conflicts = merged.conflicts;
  const hostTree = await overlayTree(dir, merged.tree, h.tree, conflicts);
  const laptopTree = await overlayTree(dir, merged.tree, l.tree, conflicts);
  const baseTree = await overlayTree(dir, merged.tree, state.base, conflicts);
  let sentToHost: string[] = [];
  if (hostTree !== h.tree) {
    const sha = await commitTree(dir, hostTree, h.head);
    const changed = await toHost(sha);
    if (!changed) return { kind: "retry", side: "host" };
    sentToHost = changed;
  }
  let sentToLaptop: string[] = [];
  if (laptopTree !== l.tree) {
    const sha = await commitTree(dir, laptopTree, h.head);
    const r = await runSide<LandResult>({ op: "land", cwd: dir, scope: opts.scope, sha, expectTree: l.tree, moveHead: h.head, backupPrefix: SYNC_BACKUP_PREFIX });
    if (!r.landed) {
      // The host has the merge; the laptop moved again after it was read.
      // What both now descend from is the laptop as it was read, with the
      // conflicted files as they were before either side changed them.
      if (sentToHost.length) await keep(await overlayTree(dir, l.tree, state.base, conflicts));
      return { kind: "retry", side: "laptop" };
    }
    sentToLaptop = r.changed;
  }
  await keep(baseTree);
  state.conflicts = conflicts;
  return conflicts.length ? { kind: "conflict", paths: conflicts, toLaptop: sentToLaptop, toHost: sentToHost } : { kind: "synced", toLaptop: sentToLaptop, toHost: sentToHost };
}

/**
 * A person's answer to a conflict: the named files (all of them by default)
 * take one side's version on both sides. The next tick sees both sides agree
 * on them and they flow again.
 */
export async function resolveConflicts(dir: string, state: SyncState, host: HostSide, keep: "laptop" | "cloud", paths?: string[], scope?: SyncScope): Promise<{ resolved: string[] } | { retry: true }> {
  const pick = (paths?.length ? paths : state.conflicts ?? []).filter((p) => state.conflicts?.includes(p));
  if (!pick.length) return { resolved: [] };
  const [h, l] = await Promise.all([host.snapshot(), runSide<SnapshotResult>({ op: "snapshot", cwd: dir, scope, commit: true })]);
  if (keep === "laptop") {
    const tree = await overlayTree(dir, h.tree, l.tree, pick);
    if (tree !== h.tree) {
      const sha = await commitTree(dir, tree, h.head);
      await host.send(sha);
      if (!(await host.land(sha, h.tree)).landed) return { retry: true };
    }
  } else {
    await host.fetch(h.sha!);
    const tree = await overlayTree(dir, l.tree, h.tree, pick);
    if (tree !== l.tree) {
      const sha = await commitTree(dir, tree, h.head);
      if (!(await runSide<LandResult>({ op: "land", cwd: dir, scope, sha, expectTree: l.tree })).landed) return { retry: true };
    }
  }
  state.conflicts = (state.conflicts ?? []).filter((p) => !pick.includes(p));
  return { resolved: pick };
}

/** The laptop copy a session syncs into: created detached at the laptop repo's HEAD when missing. */
export async function ensureSyncWorktree(repoRoot: string, name: string): Promise<string> {
  const dir = path.join(repoRoot, ".codecast", "worktrees", name);
  if (!fs.existsSync(path.join(dir, ".git"))) await git(repoRoot, ["worktree", "add", "--detach", dir, "HEAD"]);
  return dir;
}

/** The host's half over its ssh connection. */
export function sshHostSide(host: RemoteHost, remoteCwd: string, name: string, localDir: string, scope?: SyncScope): HostSide {
  const ssh = sshBase(host);
  const url = `ssh://${host.user}@${host.address}${remoteCwd}`;
  const env = { GIT_SSH_COMMAND: `ssh ${ssh.map(shq).join(" ")}` };
  const hostRef = `${SYNC_REF_PREFIX}/${name}`;
  const laptopRef = `${SYNC_REF_PREFIX}/${name}-laptop`;
  return {
    snapshot: () => runRemoteSide<SnapshotResult>(host, { op: "snapshot", cwd: remoteCwd, scope, commit: true, ref: hostRef }),
    land: (sha, expectTree) => runRemoteSide<LandResult>(host, { op: "land", cwd: remoteCwd, scope, sha, expectTree }),
    fetch: async (sha) => {
      if ((await git(localDir, ["cat-file", "-t", sha]).catch(() => "")) === "commit") return;
      await git(localDir, ["fetch", "--quiet", "--no-tags", url, `+${hostRef}:${hostRef}`], env);
    },
    send: async (sha) => { await git(localDir, ["push", "--quiet", "--force", "--no-verify", url, `${sha}:${laptopRef}`], env); },
  };
}
