/**
 * Turn a frozen working tree into a line of commits, one per group of paths,
 * without touching the checkout's index or files.
 *
 * The freeze is a turn snapshot (treeSnapshot.ts): the whole working tree as
 * one git tree, taken through a private persistent index in a fraction of a
 * second. What ships is that tree's content, so an agent writing a file a
 * moment later changes nothing about the commits; its edit ships next time.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTurnSnapshot } from "../treeSnapshot.js";
import { git } from "../wipSnapshot.js";
import { treeDiff, withIndexLockRetry } from "./level.js";

export interface Frozen {
  /** HEAD when the tree was frozen. */
  base: string;
  /** The working tree as a git tree. */
  tree: string;
  /** Every path whose frozen content differs from HEAD's, with its frozen blob (null when deleted). */
  changes: Array<{ path: string; blob: string | null; mode: string; added: boolean }>;
}

export async function freezeWorktree(root: string): Promise<Frozen> {
  const snap = await withIndexLockRetry(() => createTurnSnapshot(root));
  if (!snap) throw new Error(`${root} has no commit to freeze against`);
  const entries = await treeDiff(root, snap.base, snap.tree);
  return {
    base: snap.base,
    tree: snap.tree,
    changes: entries.map((e) => ({ path: e.path, blob: e.dst, mode: e.dst ? e.dstMode : e.srcMode, added: !e.src })),
  };
}

export interface CommitSpec {
  message: string;
  paths: string[];
  /** Extra environment for commit-tree (author identity). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Commit each spec's paths, at their frozen content, on top of `base`. Returns
 * the tip and the commit made for each spec (null when a spec changed nothing).
 */
export async function buildCommits(root: string, frozen: Frozen, specs: CommitSpec[]): Promise<{ tip: string; commits: Array<string | null> }> {
  const byPath = new Map(frozen.changes.map((c) => [c.path, c]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-ship-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    await git(root, ["read-tree", frozen.base], env);
    let tip = frozen.base;
    let tree = await git(root, ["rev-parse", `${frozen.base}^{tree}`]);
    const commits: Array<string | null> = [];
    for (const spec of specs) {
      const info = spec.paths
        .map((p) => byPath.get(p))
        .filter((c): c is Frozen["changes"][number] => !!c)
        .map((c) => (c.blob ? `${c.mode} ${c.blob}\t${c.path}` : `0 ${"0".repeat(40)}\t${c.path}`));
      if (!info.length) { commits.push(null); continue; }
      await git(root, ["update-index", "--index-info"], env, info.join("\n") + "\n");
      const next = await git(root, ["write-tree"], env);
      if (next === tree) { commits.push(null); continue; }
      tip = await git(root, ["commit-tree", next, "-p", tip, "-F", "-"], { ...env, ...spec.env }, spec.message);
      tree = next;
      commits.push(tip);
    }
    return { tip, commits };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
