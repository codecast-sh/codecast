// A station's rebase of the run's pull-request head onto the default branch,
// pushed for a test (Merge before a retest, the PR station waiting for main).
// A review of the head before the rebase covers the head after it, since the
// two differ only by the default branch they sit on. recordRebase writes each
// link twice:
// - on the server (orgLineMerge.recordStationRebase). The server only stores
//   it: it checks that the run's own runner sent it from the script station
//   running now, and nothing about the commits;
// - in $run_dir/rebase.json, for the PR station's own bookkeeping: the latest
//   link as {from, to}, and the chain in `links`. Merge never trusts this file.
//
// What Merge checks, and where: before it stamps a clearance it reads the
// server's record for this attempt (the reviewed head, and the links;
// /cli/workflow-runs/merge-proof). It follows the links from that reviewed head
// to the head CI tested (chainBetween) and re-derives every link with git
// (verifyRebaseChain, isRebaseOf). A rebase of `from` onto the default branch
// at B is the three-way merge of B and `from` over their merge base, and its
// tree must be exactly `to`'s. The one exception is a rebase Merge resolved
// itself: a plain merge that conflicts only in files B's .codecast/generated.toml
// lists (generatedFiles.ts), with `to` differing from it only in those files,
// passes once Merge has run their generators at `to` and they write exactly
// what `to` holds; CI tests that head before anything merges it. The server's clearance then requires the same
// coverage over the same links (orgLineMerge `unproven`), without the git check.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Exec } from "../lineMerge.js";
import { mergeTree } from "./gitMergeTree.js";
import { generatorsFor, readGenerators, type Generator } from "./generatedFiles.js";

export type RebaseLink = { from: string; to: string };

const FILE = "rebase.json";

/** The recorded chain, oldest link first; empty when there is none. */
export function readRebaseChain(runDir: string): RebaseLink[] {
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(path.join(runDir, FILE), "utf-8")); } catch { return []; }
  const links = Array.isArray(raw?.links) ? raw.links : raw?.from && raw?.to ? [{ from: raw.from, to: raw.to }] : [];
  return links.filter((l: any) => typeof l?.from === "string" && typeof l?.to === "string");
}

/** Record a station's rebase of `from` into `to`: on the server first (it throws when refused), then in rebase.json,
 *  extending the chain when `from` is where it ended. */
export async function recordRebase(o: { post: (path: string, body: Record<string, unknown>) => Promise<any>; runId: string; runDir: string; from: string; to: string }): Promise<void> {
  await o.post("/cli/workflow-runs/rebase", { run_id: o.runId, from: o.from, to: o.to });
  const prior = readRebaseChain(o.runDir);
  const links = prior.length && prior[prior.length - 1].to === o.from ? [...prior, { from: o.from, to: o.to }] : [{ from: o.from, to: o.to }];
  fs.mkdirSync(o.runDir, { recursive: true });
  fs.writeFileSync(path.join(o.runDir, FILE), `${JSON.stringify({ from: o.from, to: o.to, links }, null, 2)}\n`);
}

/** The links that lead from `reviewed` to `head`, in order, or null when the chain does not reach it. */
export function chainBetween(links: RebaseLink[], reviewed: string, head: string): RebaseLink[] | null {
  const path: RebaseLink[] = [];
  for (let at = reviewed; at !== head; ) {
    const next = links.find((l) => l.from === at);
    if (!next || path.length > links.length) return null;
    path.push(next);
    at = next.to;
  }
  return path;
}

/** The plain rebase of a link's `from` onto the default branch commit its `to` sits on (the three-way merge over
 *  their merge base), with `to`'s tree; null when either cannot be found. */
function plainMerge(exec: Exec, cwd: string, into: string, link: RebaseLink): { base: string; merged: { tree: string; conflicts: string[] }; tree: string } | null {
  const git = (...a: string[]) => exec("git", a, cwd);
  for (const sha of [link.from, link.to]) {
    if (git("cat-file", "-e", `${sha}^{commit}`).status !== 0) git("fetch", "-q", "origin", sha);
  }
  const base = git("merge-base", link.to, `origin/${into}`).stdout.trim();
  const fork = base ? git("merge-base", link.from, base).stdout.trim() : "";
  if (!base || !fork) return null;
  const merged = mergeTree(exec, cwd, base, link.from, { mergeBase: fork });
  if (!merged) return null;
  return { base, merged, tree: git("rev-parse", `${link.to}^{tree}`).stdout.trim() };
}

/** Whether `to` is exactly `from` rebased onto the default branch commit it sits on. */
export function isRebaseOf(exec: Exec, cwd: string, into: string, link: RebaseLink): boolean {
  const plain = plainMerge(exec, cwd, into, link);
  return !!plain && !plain.merged.conflicts.length && plain.merged.tree === plain.tree;
}

/** A recorded rebase that is the plain rebase except in generated files it conflicted in: those files, and the
 *  generators whose output they must be. Not yet a rebase: Merge runs the generators at `to` (proveRegenerated in
 *  mergeStation.ts) and takes it only when they write exactly what `to` holds. */
export type RegeneratedRebase = { link: RebaseLink; files: string[]; generators: Generator[] };

/** The link as a rebase Merge resolved by regenerating, or null. Every conflict of the plain merge is a file the
 *  default branch's generated list names (that commit's list, never the change's own, so a change cannot widen what
 *  passes), and `to` differs from the plain merge only in those conflicted files: a file that merged cleanly must
 *  match it exactly. */
export function regeneratedRebase(exec: Exec, cwd: string, into: string, link: RebaseLink): RegeneratedRebase | null {
  const plain = plainMerge(exec, cwd, into, link);
  if (!plain || !plain.merged.conflicts.length) return null;
  const { generators } = readGenerators(exec, cwd, plain.base);
  const conflicted = generatorsFor(generators, plain.merged.conflicts);
  if (!conflicted) return null;
  const differ = exec("git", ["diff-tree", "-r", "--name-only", "--no-renames", plain.merged.tree, plain.tree], cwd);
  if (differ.status !== 0) return null;
  const files = differ.stdout.split("\n").filter(Boolean);
  if (files.some((f) => !plain.merged.conflicts.includes(f))) return null;
  return { link, files, generators: generatorsFor(generators, files)! };
}

/** Null when `head` is the reviewed head, or every link of `links` from it to `head` is a real rebase; else why not.
 *  Given `regenerated`, a link Merge resolved by regenerating (regeneratedRebase) passes here and is added to it: the
 *  caller then proves its generated files before the link counts. */
export function verifyRebaseChain(exec: Exec, cwd: string, into: string, links: RebaseLink[], reviewed: string, head: string, regenerated?: RegeneratedRebase[]): string | null {
  if (reviewed === head) return null;
  const chain = chainBetween(links, reviewed, head);
  if (!chain) return `the reviewer read ${reviewed.slice(0, 10)}, not the head CI tested (${head.slice(0, 10)}); it must be reviewed again`;
  const forged = chain.find((l) => {
    if (isRebaseOf(exec, cwd, into, l)) return false;
    const proof = regenerated ? regeneratedRebase(exec, cwd, into, l) : null;
    if (proof) regenerated!.push(proof);
    return !proof;
  });
  if (forged) return `the recorded rebase of ${forged.from.slice(0, 10)} into ${forged.to.slice(0, 10)} is not a rebase of it onto ${into}; it must be reviewed again`;
  return null;
}
