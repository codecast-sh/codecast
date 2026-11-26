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
// tree must be exactly `to`'s, except in the files B's .codecast/generated.toml
// lists (generatedFiles.ts): Merge resolves a conflict only in those by
// running their generators, so there `to` holds generator output, and CI tests
// that head before anything merges it. The server's clearance then requires the same
// coverage over the same links (orgLineMerge `unproven`), without the git check.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Exec } from "../lineMerge.js";
import { mergeTree } from "./gitMergeTree.js";
import { readGenerators, writtenBy } from "./generatedFiles.js";

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

/** Whether `to` is `from` rebased onto the default branch commit it sits on: exactly, or differing (and conflicting)
 *  only in files that commit's generated list names, which Merge regenerated. The list is the default branch's,
 *  never the change's own, so a change cannot widen what passes. */
export function isRebaseOf(exec: Exec, cwd: string, into: string, link: RebaseLink): boolean {
  const git = (...a: string[]) => exec("git", a, cwd);
  for (const sha of [link.from, link.to]) {
    if (git("cat-file", "-e", `${sha}^{commit}`).status !== 0) git("fetch", "-q", "origin", sha);
  }
  const base = git("merge-base", link.to, `origin/${into}`).stdout.trim();
  const fork = base ? git("merge-base", link.from, base).stdout.trim() : "";
  if (!base || !fork) return false;
  const merged = mergeTree(exec, cwd, base, link.from, { mergeBase: fork });
  if (!merged) return false;
  const tree = git("rev-parse", `${link.to}^{tree}`).stdout.trim();
  if (!merged.conflicts.length && merged.tree === tree) return true;
  const { generators } = readGenerators(exec, cwd, base);
  if (!generators.length || merged.conflicts.some((f) => !writtenBy(generators, f))) return false;
  const differ = git("diff-tree", "-r", "--name-only", "--no-renames", merged.tree, tree);
  if (differ.status !== 0) return false;
  return differ.stdout.split("\n").filter(Boolean).every((f) => writtenBy(generators, f));
}

/** Null when `head` is the reviewed head, or every link of `links` from it to `head` is a real rebase; else why not. */
export function verifyRebaseChain(exec: Exec, cwd: string, into: string, links: RebaseLink[], reviewed: string, head: string): string | null {
  if (reviewed === head) return null;
  const chain = chainBetween(links, reviewed, head);
  if (!chain) return `the reviewer read ${reviewed.slice(0, 10)}, not the head CI tested (${head.slice(0, 10)}); it must be reviewed again`;
  const forged = chain.find((l) => !isRebaseOf(exec, cwd, into, l));
  if (forged) return `the recorded rebase of ${forged.from.slice(0, 10)} into ${forged.to.slice(0, 10)} is not a rebase of it onto ${into}; it must be reviewed again`;
  return null;
}
