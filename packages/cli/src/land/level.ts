/**
 * Level a live checkout onto a new commit without disturbing anyone in it.
 *
 * A shared checkout has many writers and is never clean, so the usual ways of
 * moving it (pull, rebase, stash, reset --hard) either refuse or trample
 * someone's edit. Levelling moves the branch to `target` and touches only the
 * paths that differ between the old HEAD and `target`:
 *
 *   worktree equals target   nothing to write (an edit that already landed)
 *   worktree equals old HEAD write target's version (nobody touched it here)
 *   anything else            three-way merge of old HEAD, worktree and target;
 *                            written when clean, a conflict otherwise
 *
 * Every other file, dirty or not, is left exactly as it is. Nothing is written
 * until every path has a clean answer, so a conflict leaves the checkout as it
 * was. The branch moves by compare-and-swap, so an agent committing at the same
 * moment wins and the level reports that HEAD moved.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { git, gitTry } from "../wipSnapshot.js";
import { execFileSync, spawnSync } from "../proc.js";

const NULL_SHA = "0000000000000000000000000000000000000000";
const GITLINK = "160000";
const SYMLINK = "120000";

export interface LevelResult {
  ok: boolean;
  from: string;
  to: string;
  /** Files written with target's version. */
  written: string[];
  /** Files deleted because target deleted them. */
  deleted: string[];
  /** Local edits that already matched target: only the index moved. */
  absorbed: string[];
  /** Local edits merged three-way with target's change. */
  merged: string[];
  /** Local edits that already carry target's change: left exactly as they are. */
  kept: string[];
  /** Paths that need a person or an agent: nothing was written when this is non-empty. */
  conflicts: string[];
  reason?: string;
}

interface DiffEntry { path: string; srcMode: string; dstMode: string; src: string | null; dst: string | null }

type Action =
  | { kind: "absorb"; entry: DiffEntry }
  | { kind: "keep"; entry: DiffEntry; seen: string | null }
  | { kind: "write"; entry: DiffEntry; seen: string | null }
  | { kind: "merge"; entry: DiffEntry; seen: string | null; content: Buffer };

/**
 * What to do with one path, given what is on disk (`w`) and the content it
 * grew from (`base`); null when only a person can say.
 */
async function decide(root: string, entry: DiffEntry, w: string | null, base: string | null): Promise<Action | null> {
  if (w === entry.dst) return { kind: "absorb", entry };
  if (w === base) return { kind: "write", entry, seen: w };
  if (!w || !base || !entry.dst || entry.dstMode === SYMLINK || entry.srcMode === SYMLINK) return null;
  let current: Buffer;
  try { current = fs.readFileSync(path.join(root, entry.path)); } catch { return null; }
  const merged = await mergeFile(root, base, current, entry.dst);
  if (!merged) return null;
  // The disk already holds target's change under local edits: nothing to write.
  if (merged.equals(current)) return { kind: "keep", entry, seen: w };
  return { kind: "merge", entry, seen: w, content: merged };
}

/** `git diff-tree -r -z` between two commits, gitlinks dropped. */
export async function treeDiff(cwd: string, from: string, to: string): Promise<DiffEntry[]> {
  const out = await git(cwd, ["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", from, to]);
  const parts = out.split("\0");
  const entries: DiffEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].replace(/^:/, "").split(" ");
    const file = parts[i + 1];
    if (meta.length < 5 || !file) continue;
    const [srcMode, dstMode, src, dst] = meta;
    if (srcMode === GITLINK || dstMode === GITLINK) continue;
    entries.push({ path: file, srcMode, dstMode, src: src === NULL_SHA ? null : src, dst: dst === NULL_SHA ? null : dst });
  }
  return entries;
}

/** The blob each path would have if added now, or null when it is not on disk. */
export async function worktreeBlobs(root: string, paths: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const files: string[] = [];
  for (const p of paths) {
    let st: fs.Stats;
    try { st = fs.lstatSync(path.join(root, p)); } catch { result.set(p, null); continue; }
    if (st.isSymbolicLink()) {
      result.set(p, await git(root, ["hash-object", "--stdin"], undefined, fs.readlinkSync(path.join(root, p))));
    } else if (st.isFile()) {
      files.push(p);
    } else {
      result.set(p, null);
    }
  }
  if (files.length) {
    // --stdin-paths applies the repo's clean filters, as `git add` would.
    const out = await git(root, ["hash-object", "--stdin-paths"], undefined, files.join("\n") + "\n");
    const shas = out.split("\n");
    files.forEach((p, i) => result.set(p, shas[i] ?? null));
  }
  return result;
}

async function blobContent(cwd: string, sha: string): Promise<Buffer> {
  return execFileSync("git", ["-C", cwd, "cat-file", "blob", sha], { maxBuffer: 256 * 1024 * 1024 });
}

/** Three-way merge of one file's text; null when it conflicts. */
async function mergeFile(cwd: string, base: string, current: Buffer, other: string): Promise<Buffer | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-level-"));
  try {
    const cur = path.join(dir, "current");
    const bas = path.join(dir, "base");
    const oth = path.join(dir, "other");
    fs.writeFileSync(cur, current);
    fs.writeFileSync(bas, await blobContent(cwd, base));
    fs.writeFileSync(oth, await blobContent(cwd, other));
    const r = spawnSync("git", ["merge-file", "-p", cur, bas, oth], { maxBuffer: 256 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeAtomic(file: string, content: Buffer, mode: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (mode === SYMLINK) {
    try { fs.unlinkSync(file); } catch {}
    fs.symlinkSync(content.toString(), file);
    return;
  }
  const tmp = `${file}.cast-level-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: mode === "100755" ? 0o755 : 0o644 });
  fs.renameSync(tmp, file);
}

/** Remove a file and the directories it leaves empty, stopping at the root. */
function removeFile(root: string, rel: string): void {
  const file = path.join(root, rel);
  try { fs.unlinkSync(file); } catch { return; }
  let dir = path.dirname(file);
  while (dir.startsWith(root) && dir !== root) {
    try { fs.rmdirSync(dir); } catch { break; }
    dir = path.dirname(dir);
  }
}

/**
 * Move the checkout at `cwd` to `target`. With `rewritten`, the branch's own
 * commits may be absent from target by sha because the caller replayed them
 * into it; without it, target must contain HEAD.
 *
 * `worktreeBase` names, per path, the content the working file grew from
 * when that is not HEAD's: a file frozen and shipped while an agent kept
 * typing descends from the frozen blob, so the merge must start there or
 * every later keystroke reads as a conflict with the shipped version.
 */
export async function levelCheckout(cwd: string, target: string, opts: { rewritten?: boolean; dryRun?: boolean; worktreeBase?: Map<string, string | null> } = {}): Promise<LevelResult> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const from = await git(root, ["rev-parse", "HEAD"]);
  const to = await git(root, ["rev-parse", `${target}^{commit}`]);
  const empty: LevelResult = { ok: true, from, to, written: [], deleted: [], absorbed: [], merged: [], kept: [], conflicts: [] };
  if (from === to) return empty;
  const branch = await gitTry(root, ["symbolic-ref", "-q", "HEAD"]);
  if (!branch) return { ...empty, ok: false, reason: "HEAD is detached: level moves a branch" };
  if (!opts.rewritten && (await gitTry(root, ["merge-base", "--is-ancestor", from, to])) === null) {
    return { ...empty, ok: false, reason: `HEAD has commits ${to.slice(0, 9)} lacks: push or replay them first` };
  }

  const entries = await treeDiff(root, from, to);
  const baseOf = (e: DiffEntry) => (opts.worktreeBase?.has(e.path) ? opts.worktreeBase.get(e.path)! : e.src);
  const seen = await worktreeBlobs(root, entries.map((e) => e.path));
  const actions: Action[] = [];
  const conflicts: string[] = [];
  for (const entry of entries) {
    const a = await decide(root, entry, seen.get(entry.path) ?? null, baseOf(entry));
    if (a) actions.push(a);
    else conflicts.push(entry.path);
  }

  const result: LevelResult = {
    ...empty,
    written: actions.filter((a) => a.kind === "write" && a.entry.dst).map((a) => a.entry.path),
    deleted: actions.filter((a) => a.kind === "write" && !a.entry.dst).map((a) => a.entry.path),
    absorbed: actions.filter((a) => a.kind === "absorb").map((a) => a.entry.path),
    kept: actions.filter((a) => a.kind === "keep").map((a) => a.entry.path),
    merged: actions.filter((a) => a.kind === "merge").map((a) => a.entry.path),
    conflicts,
  };
  if (conflicts.length) return { ...result, ok: false, reason: `${conflicts.length} file(s) changed here and in ${to.slice(0, 9)} without a clean merge` };
  if (opts.dryRun) return result;

  // The branch first, by compare-and-swap: a commit made in the checkout since
  // we read HEAD wins, and nothing has been written yet.
  if ((await gitTry(root, ["update-ref", "-m", `cast land level ${from.slice(0, 9)} -> ${to.slice(0, 9)}`, branch, to, from])) === null) {
    return { ...empty, ok: false, reason: "HEAD moved while levelling; run again" };
  }

  // Files next. Each is re-hashed right before its write; one edited since
  // the plan is decided again from what is on disk now, so a keystroke that
  // lands mid-level is merged, never overwritten.
  const raced: string[] = [];
  for (let a of actions) {
    if (a.kind === "absorb" || a.kind === "keep") continue;
    const file = path.join(root, a.entry.path);
    for (let attempt = 0; ; attempt++) {
      const current: string | null = (await worktreeBlobs(root, [a.entry.path])).get(a.entry.path) ?? null;
      if (current === a.seen) break;
      const again: Action | null = attempt < 3 ? await decide(root, a.entry, current, baseOf(a.entry)) : null;
      if (!again) { raced.push(a.entry.path); a = { kind: "keep", entry: a.entry, seen: current }; break; }
      a = again;
      if (a.kind === "absorb" || a.kind === "keep") break;
    }
    if (a.kind === "merge") writeAtomic(file, a.content, a.entry.dstMode);
    else if (a.kind === "write") {
      if (a.entry.dst) writeAtomic(file, await blobContent(root, a.entry.dst), a.entry.dstMode);
      else removeFile(root, a.entry.path);
    }
  }

  // The index last: target's entry for every path that moved, the rest of the
  // index (and its stat cache) untouched.
  const info = entries.map((e) => (e.dst ? `${e.dstMode} ${e.dst}\t${e.path}` : `0 ${NULL_SHA}\t${e.path}`)).join("\n") + "\n";
  await withIndexLockRetry(() => git(root, ["update-index", "--index-info"], undefined, info));
  await gitTry(root, ["update-index", "-q", "--refresh"]);

  if (raced.length) return { ...result, ok: false, conflicts: raced, reason: `${raced.length} file(s) kept changing during the level; their edits stand but lack ${to.slice(0, 9)}'s change` };
  return result;
}

/** Retry `fn` while another git process holds an index lock (the daemon snapshots the same checkouts). */
export async function withIndexLockRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 40 || !/index\.lock/.test(String((err as Error)?.message ?? err))) throw err;
      await new Promise((r) => setTimeout(r, 100 + attempt * 50));
    }
  }
}
