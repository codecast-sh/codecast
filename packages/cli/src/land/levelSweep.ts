/**
 * Keep shared checkouts level with their upstream, so a push from anywhere
 * (a worktree, a cloud host, another machine) reaches the agents working in
 * the checkout within a minute and `packages/convex/deploy.sh` never refuses a
 * stale tree.
 *
 * Opt-in per repo (`[ship] level = true` in .codecast/workspace.toml): the
 * daemon writes into a person's checkout, which no feature does on its own.
 * Only a checkout on its upstream's branch with no commits of its own is
 * moved; one holding unpushed commits is `cast ship checkout`'s to land.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { gitTry } from "../wipSnapshot.js";
import { levelCheckout, type LevelResult } from "./level.js";
import { isAncestor } from "./replay.js";
import { shipLockHeld, shipSpec, upstreamRef } from "./shipCheckout.js";

/** Fetch at most this often per checkout. */
export const LEVEL_FETCH_MS = 60_000;
const lastFetch = new Map<string, number>();

export type LevelSweepOutcome =
  | { root: string; skipped: string }
  | { root: string; result: LevelResult };

export async function levelOne(root: string, now = Date.now()): Promise<LevelSweepOutcome> {
  if (!shipSpec(root).level) return { root, skipped: "level not enabled" };
  const gitDir = await gitTry(root, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir) return { root, skipped: "not a git checkout" };
  // A linked worktree's git dir lives under the main one's worktrees/.
  if (path.basename(path.dirname(gitDir)) === "worktrees") return { root, skipped: "a worktree" };
  if (shipLockHeld(gitDir)) return { root, skipped: "a ship is running" };
  if (fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply")) || fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) {
    return { root, skipped: "a rebase or merge is in progress" };
  }
  let upstream: string;
  try { upstream = await upstreamRef(root); } catch { return { root, skipped: "no upstream" }; }
  const [remote, ...rest] = upstream.split("/");
  const branch = rest.join("/");
  if ((await gitTry(root, ["symbolic-ref", "--short", "-q", "HEAD"])) !== branch) return { root, skipped: `not on ${branch}` };
  if (now - (lastFetch.get(root) ?? 0) >= LEVEL_FETCH_MS) {
    lastFetch.set(root, now);
    await gitTry(root, ["fetch", "--quiet", remote, branch]);
  }
  const head = await gitTry(root, ["rev-parse", "HEAD"]);
  const up = await gitTry(root, ["rev-parse", upstream]);
  if (!head || !up || head === up) return { root, skipped: "level" };
  if (!(await isAncestor(root, head, up))) {
    // Commits pushed from elsewhere (a detached worktree, a cherry-pick) leave
    // the checkout diverged but holding nothing upstream lacks: `git cherry`
    // marks each such commit "-". Those level like any other.
    const cherry = ((await gitTry(root, ["cherry", upstream, head])) ?? "+").split("\n").filter(Boolean);
    if (cherry.some((l) => !l.startsWith("-"))) return { root, skipped: "holds commits upstream lacks" };
    return { root, result: await levelCheckout(root, upstream, { rewritten: true }) };
  }
  return { root, result: await levelCheckout(root, upstream) };
}

export function describeLevel(o: LevelSweepOutcome): string | null {
  if ("skipped" in o) return null;
  const r = o.result;
  const name = path.basename(o.root);
  if (!r.ok) return `${name}: not levelled to ${r.to.slice(0, 9)}: ${r.reason}${r.conflicts.length ? ` (${r.conflicts.slice(0, 5).join(", ")})` : ""}`;
  return `${name}: levelled ${r.from.slice(0, 9)} -> ${r.to.slice(0, 9)} (${r.written.length} written, ${r.deleted.length} deleted, ${r.merged.length} merged, ${r.absorbed.length + r.kept.length} already here)`;
}
