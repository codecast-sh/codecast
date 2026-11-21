/**
 * Bring a level conflict to the session that wrote the file.
 *
 * The level sweep moves a shared checkout only when every changed path has a
 * clean answer (level.ts), so one file edited here and upstream without a
 * clean merge holds the whole checkout behind. Nobody reads the daemon log, so
 * the writer of each conflicting file is told: which of its files conflict
 * with which upstream commits, where the three-way merge sits with its
 * markers, and what not to do in a shared checkout. Once the file carries
 * upstream's change the next sweep levels by itself. A level that raced a
 * writer moves HEAD but leaves that file without upstream's change (a stale
 * copy); its writer is told the same way, with its merge file kept apart so a
 * later level does not delete it.
 *
 * Each path is recorded with upstream's blob of it, the blob on disk and the
 * session briefed (`.git/codecast/level-conflicts.json`). A busy main whose
 * commits leave the file alone costs an ls-tree and a hash-object per sweep
 * and sends nothing. Upstream changing the file briefs again; a change on disk
 * attributes again and briefs only a new writer. A path with no writer, or a
 * brief the server refused, is tried again after RETRY_MS. A clean level (or
 * a checkout found already level) clears the record and the merge files.
 *
 * The brief is a machine wake (origin "scheduler"), never a person's message:
 * it leaves the writer's pinned state and a hidden stash alone.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatSessionMessage } from "@codecast/shared/contracts";
import { execFileAsync } from "../proc.js";
import { gitTry } from "../wipSnapshot.js";
import { attributeEdits, type Attribution } from "./attribute.js";
import { worktreeBlobs, type LevelResult } from "./level.js";

/** Deliver `body` to conversation `to` as a machine wake; true once the server took it. `clientId` makes a retry land once. */
export type SendBrief = (to: string, body: string, clientId: string) => Promise<boolean>;

export interface BriefDeps {
  /** Absent when this machine cannot reach the server: then nothing is attributed or briefed. */
  send?: SendBrief;
  attribute?: (root: string, paths: string[], opts: { since: number }) => Pick<Attribution, "owners">;
  now?: number;
}

interface PathState {
  /** Upstream's blob of the path, "deleted" when upstream has none. */
  up: string;
  /** The blob on disk, "missing" when the file is gone. */
  local: string;
  /** The conversation that wrote it last, null when no transcript says. */
  owner: string | null;
  /** The owner has this brief (for this `up`). */
  briefed: boolean;
  /** When attribution or the send was last tried. */
  at: number;
}

interface ConflictRecord { paths: Record<string, PathState> }

/** A transcript can reach the sync ledger after the write it records, and a server can refuse a send: both are tried again this often. */
export const RETRY_MS = 15 * 60_000;
/** A write older than this cannot be the one that left a file dirty. */
const ATTRIBUTION_HORIZON_MS = 14 * 86_400_000;
const BLOB_MAX_BUFFER = 256 * 1024 * 1024;
const SYMLINK = "120000";

const recordFile = (gitDir: string) => path.join(gitDir, "codecast", "level-conflicts.json");
/** Merge files of conflicts holding the checkout back; cleared once it levels. */
export const mergeDir = (gitDir: string) => path.join(gitDir, "codecast", "level-conflicts");
/** Merge files of stale copies a raced level left behind; kept past the level, overwritten per path. */
export const staleDir = (gitDir: string) => path.join(gitDir, "codecast", "level-stale");

function readRecord(gitDir: string): ConflictRecord {
  try {
    const r = JSON.parse(fs.readFileSync(recordFile(gitDir), "utf-8"));
    if (r?.paths && typeof r.paths === "object") return r;
  } catch {}
  return { paths: {} };
}

function writeRecord(gitDir: string, record: ConflictRecord): void {
  const file = recordFile(gitDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, file);
}

/** Forget every brief and merge file for this checkout: it is level again. */
export function clearLevelConflicts(gitDir: string): void {
  fs.rmSync(recordFile(gitDir), { force: true });
  fs.rmSync(mergeDir(gitDir), { recursive: true, force: true });
}

/** Each path's blob and mode in `rev`; blob "deleted" when it has none. */
async function upstreamEntries(root: string, rev: string, paths: string[]): Promise<Map<string, { blob: string; mode: string }>> {
  const out = (await gitTry(root, ["--literal-pathspecs", "ls-tree", "-r", "-z", rev, "--", ...paths])) ?? "";
  const entries = new Map(paths.map((p) => [p, { blob: "deleted", mode: "" }]));
  for (const entry of out.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab <= 0) continue;
    const [mode, , blob] = entry.slice(0, tab).split(" ");
    entries.set(entry.slice(tab + 1), { blob, mode });
  }
  return entries;
}

async function blobAt(root: string, rev: string, rel: string): Promise<Buffer | null> {
  try {
    return (await execFileAsync("git", ["-C", root, "cat-file", "blob", `${rev}:${rel}`], { encoding: "buffer", maxBuffer: BLOB_MAX_BUFFER })).stdout;
  } catch {
    return null;
  }
}

const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);

type Merge =
  | { kind: "merged"; file: string }
  | { kind: "upstream-deleted" }
  | { kind: "local-deleted"; file: string | null }
  | { kind: "binary" }
  | { kind: "none" };

/**
 * What to hand the writer for one path: `git merge-file` of the old HEAD's
 * blob (base), the working file and upstream's blob, written under `dir`.
 * Never throws: a merge file that cannot be written (a long path, a full disk,
 * a directory in the way) is "none", and the brief still goes out.
 */
async function writeMerge(root: string, dir: string, rel: string, from: string, to: string, upMode: string): Promise<Merge> {
  try {
    const out = path.resolve(dir, rel);
    if (!out.startsWith(dir + path.sep)) return { kind: "none" };
    fs.rmSync(out, { force: true });
    const other = await blobAt(root, to, rel);
    if (!other) return { kind: "upstream-deleted" };
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(path.join(root, rel)); } catch {}
    if (upMode === SYMLINK || st?.isSymbolicLink()) return { kind: "binary" };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (!st) {
      fs.writeFileSync(out, other);
      return { kind: "local-deleted", file: out };
    }
    const current = fs.readFileSync(path.join(root, rel));
    const base = (await blobAt(root, from, rel)) ?? Buffer.alloc(0);
    if (isBinary(current) || isBinary(other) || isBinary(base)) return { kind: "binary" };
    fs.writeFileSync(out, current);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cast-level-conflict-"));
    try {
      fs.writeFileSync(path.join(tmp, "base"), base);
      fs.writeFileSync(path.join(tmp, "other"), other);
      // merge-file writes into `out` and exits with the conflict count.
      await execFileAsync("git", ["merge-file", "-L", "yours", "-L", from.slice(0, 9), "-L", `upstream ${to.slice(0, 9)}`, out, path.join(tmp, "base"), path.join(tmp, "other")]).catch(() => {});
      return { kind: "merged", file: out };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch {
    return { kind: "none" };
  }
}

function oldestMtime(root: string, paths: string[], now: number): number {
  let oldest = now;
  for (const p of paths) {
    try { oldest = Math.min(oldest, fs.statSync(path.join(root, p)).mtimeMs); } catch {}
  }
  return oldest;
}

function action(p: string, m: Merge, to: string): string {
  const show = `git show ${to.slice(0, 9)}:${p}`;
  switch (m.kind) {
    case "merged": return `Three-way merge with conflict markers: ${m.file}. Resolve the markers there and write the result over ${p}, or redo your edit on upstream's version (${show}).`;
    case "upstream-deleted": return `Upstream deletes ${p}. Delete your copy, or move your edit to where upstream moved that code.`;
    case "local-deleted": return `You deleted ${p} here and upstream changed it. If it should stay, write upstream's version back over it by hand: it is saved at ${m.file ?? "(not saved)"} (or ${show}).`;
    case "binary": return `${p} is binary or a symlink, so there is no merge file: take upstream's version (${show}) or redo your edit on it.`;
    case "none": return `No merge file could be written; upstream's version is ${show}.`;
  }
}

async function briefFor(root: string, r: LevelResult, raced: boolean, paths: string[], merges: Map<string, Merge>): Promise<string> {
  const files = paths.join(", ");
  const one = paths.length === 1;
  const lines = [
    raced
      ? `The shared checkout ${root} moved to upstream ${r.to.slice(0, 9)}, but your ${files} changed while it moved and still ${one ? "lacks" : "lack"} upstream's change: as ${one ? "it stands" : "they stand"}, ${one ? "it" : "they"} would revert that change when shipped.`
      : `The shared checkout ${root} cannot follow upstream: your uncommitted ${one ? "edit" : "edits"} to ${files} ${one ? "conflicts" : "conflict"} with upstream's change. It stays at ${r.from.slice(0, 9)} while upstream is at ${r.to.slice(0, 9)}, so every session in it misses upstream's work.`,
  ];
  for (const p of paths) {
    const log = (await gitTry(root, ["log", "--format=- %h %s", `${r.from}..${r.to}`, "--", p])) ?? "";
    lines.push("", `${p} changed upstream in:`, log || "- (upstream's history does not name it)", action(p, merges.get(p) ?? { kind: "none" }, r.to));
  }
  lines.push(
    "",
    `Edit only the ${one ? "file" : "files"} named here. Never run git pull, merge, rebase, stash, checkout, restore, reset or commit in this shared checkout: other sessions' uncommitted work lives in it.`,
    raced
      ? "Once your file carries upstream's change, nothing else is needed."
      : "Once your file carries upstream's change, the next level sweep (within a minute) moves the checkout by itself.",
  );
  return formatSessionMessage("codecast", lines.join("\n"), { name: "level sweep" });
}

/** The same brief retried lands once: keyed by checkout, writer and what upstream holds for each path. */
function clientIdFor(gitDir: string, owner: string, paths: string[], ups: Map<string, { blob: string }>): string {
  const h = createHash("sha256").update([gitDir, owner, ...paths.map((p) => `${p}:${ups.get(p)?.blob}`)].join("\n")).digest("hex");
  return `level-conflict:${h.slice(0, 24)}`;
}

/**
 * Brief the writer of each path in a failed level's conflicts. Returns a
 * short account for the log line, or null when there is nothing to say.
 */
export async function briefLevelConflicts(root: string, gitDir: string, r: LevelResult, deps: BriefDeps): Promise<string | null> {
  if (r.ok || !r.conflicts.length) return null;
  const head = await gitTry(root, ["rev-parse", "HEAD"]);
  // Held: HEAD stayed. Raced: the level moved HEAD and left these files stale.
  // Anything else moved HEAD since; the next sweep reads it afresh.
  const raced = head === r.to;
  if (head !== r.from && !raced) return null;
  if (!deps.send) return `cannot brief writers of ${r.conflicts.join(", ")}: not signed in`;
  const send = deps.send;
  const now = deps.now ?? Date.now();
  const prior = readRecord(gitDir);
  const ups = await upstreamEntries(root, r.to, r.conflicts);
  const locals = await worktreeBlobs(root, r.conflicts);
  // Only the conflicts still standing stay recorded.
  const record: ConflictRecord = { paths: {} };
  const fresh: string[] = [];
  for (const p of r.conflicts) {
    const prev = prior.paths[p];
    const up = ups.get(p)!.blob;
    const local = locals.get(p) ?? "missing";
    const sameUp = prev?.up === up;
    if (prev && sameUp && !prev.briefed && now - prev.at < RETRY_MS) record.paths[p] = prev;
    else if (prev && sameUp && prev.briefed && prev.local === local) record.paths[p] = prev;
    else fresh.push(p);
  }

  const notes: string[] = [];
  const toBrief = new Map<string, string[]>();
  if (fresh.length) {
    const since = Math.max(oldestMtime(root, fresh, now) - 60_000, now - ATTRIBUTION_HORIZON_MS);
    const { owners } = (deps.attribute ?? attributeEdits)(root, fresh, { since });
    for (const p of fresh) {
      const prev = prior.paths[p];
      const state: PathState = { up: ups.get(p)!.blob, local: locals.get(p) ?? "missing", owner: owners.get(p)?.conversationId ?? null, briefed: false, at: now };
      record.paths[p] = state;
      if (!state.owner) continue;
      // The same writer, already told about this upstream content: only the disk moved.
      if (prev?.briefed && prev.up === state.up && prev.owner === state.owner) { record.paths[p] = { ...state, briefed: true, at: prev.at }; continue; }
      toBrief.set(state.owner, [...(toBrief.get(state.owner) ?? []), p]);
    }
  }
  // Written when it changed, and again after each delivered brief, so a later failure cannot lose one.
  let written = JSON.stringify(prior);
  const save = () => {
    const json = JSON.stringify(record);
    if (json !== written) { writeRecord(gitDir, record); written = json; }
  };
  save();

  const dir = raced ? staleDir(gitDir) : mergeDir(gitDir);
  for (const [owner, paths] of toBrief) {
    paths.sort();
    const merges = new Map<string, Merge>();
    for (const p of paths) merges.set(p, await writeMerge(root, dir, p, r.from, r.to, ups.get(p)!.mode));
    const body = await briefFor(root, r, raced, paths, merges);
    const ok = await send(owner, body, clientIdFor(gitDir, owner, paths, ups)).catch(() => false);
    notes.push(`${ok ? "briefed" : "brief failed to"} ${owner.slice(0, 7)} (${paths.join(", ")})`);
    if (ok) {
      for (const p of paths) record.paths[p] = { ...record.paths[p], briefed: true };
      save();
    }
  }

  const already = new Map<string, string[]>();
  for (const p of r.conflicts) {
    const s = record.paths[p];
    if (s?.briefed && s.owner && ![...toBrief.values()].some((ps) => ps.includes(p))) already.set(s.owner, [...(already.get(s.owner) ?? []), p]);
  }
  for (const [owner, paths] of already) notes.push(`already briefed ${owner.slice(0, 7)} (${paths.join(", ")})`);
  const waiting = r.conflicts.filter((p) => record.paths[p] && !record.paths[p].owner);
  if (waiting.length) notes.push(`no writer for ${waiting.join(", ")}`);
  return notes.join("; ") || null;
}
