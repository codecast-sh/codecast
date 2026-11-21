/**
 * Bring a level conflict to the session that wrote the file.
 *
 * The level sweep moves a shared checkout only when every changed path has a
 * clean answer (level.ts), so one file edited here and upstream without a
 * clean merge holds the whole checkout behind. Nobody reads the daemon log, so
 * the writer of each conflicting file is told: which of its files conflict
 * with which upstream commits, and where the three-way merge sits with its
 * markers. Once the file carries upstream's change the next sweep levels by
 * itself.
 *
 * Each writer hears once per (path set, upstream sha): what was sent lives in
 * `.git/codecast/level-conflicts.json`, and a clean level (or a checkout found
 * already level) clears it with the merge files.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileAsync } from "../proc.js";
import { gitTry } from "../wipSnapshot.js";
import { attributeEdits, type Attribution } from "./attribute.js";
import type { LevelResult } from "./level.js";

/** Deliver `body` to conversation `to`, waking it; true once the server took it. */
export type SendBrief = (to: string, body: string) => Promise<boolean>;

export interface BriefDeps {
  send: SendBrief;
  attribute?: (root: string, paths: string[], opts: { since: number }) => Pick<Attribution, "owners">;
  now?: number;
}

interface ConflictRecord {
  /** The upstream sha the record is about; a new one starts it over. */
  to: string;
  /** `<conversation>\n<path>\n<path>...` per brief delivered for `to`. */
  sent: string[];
  unattributed: string[];
}

/** A write older than this cannot be the one that left a file dirty. */
const ATTRIBUTION_HORIZON_MS = 14 * 86_400_000;
const BLOB_MAX_BUFFER = 256 * 1024 * 1024;

const recordFile = (gitDir: string) => path.join(gitDir, "codecast", "level-conflicts.json");
export const mergeDir = (gitDir: string) => path.join(gitDir, "codecast", "level-conflicts");

function readRecord(gitDir: string): ConflictRecord | null {
  try { return JSON.parse(fs.readFileSync(recordFile(gitDir), "utf-8")); } catch { return null; }
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

async function blobAt(root: string, rev: string, rel: string): Promise<Buffer | null> {
  try {
    return (await execFileAsync("git", ["-C", root, "cat-file", "blob", `${rev}:${rel}`], { encoding: "buffer", maxBuffer: BLOB_MAX_BUFFER })).stdout;
  } catch {
    return null;
  }
}

/**
 * `git merge-file` of HEAD's blob (base), the working file and upstream's blob
 * into the merge dir; null when there is nothing to merge (the file is gone
 * here or upstream deletes it).
 */
async function writeMergeFile(root: string, gitDir: string, rel: string, head: string, to: string): Promise<string | null> {
  const other = await blobAt(root, to, rel);
  let current: Buffer;
  try { current = fs.readFileSync(path.join(root, rel)); } catch { return null; }
  if (!other) return null;
  const out = path.join(mergeDir(gitDir), rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, current);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cast-level-conflict-"));
  try {
    const base = path.join(tmp, "base");
    const oth = path.join(tmp, "other");
    fs.writeFileSync(base, (await blobAt(root, head, rel)) ?? Buffer.alloc(0));
    fs.writeFileSync(oth, other);
    // merge-file writes into `out` and exits with the conflict count.
    await execFileAsync("git", ["merge-file", "-L", "yours", "-L", head.slice(0, 9), "-L", `upstream ${to.slice(0, 9)}`, out, base, oth]).catch(() => {});
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function oldestMtime(root: string, paths: string[], now: number): number {
  let oldest = now;
  for (const p of paths) {
    try { oldest = Math.min(oldest, fs.statSync(path.join(root, p)).mtimeMs); } catch {}
  }
  return oldest;
}

async function briefFor(root: string, head: string, to: string, paths: string[], merges: Map<string, string | null>): Promise<string> {
  const lines = [
    `The shared checkout ${root} cannot follow upstream: your uncommitted ${paths.length === 1 ? "edit" : "edits"} to ${paths.join(", ")} ${paths.length === 1 ? "conflicts" : "conflict"} with upstream's change. It stays at ${head.slice(0, 9)} while upstream is at ${to.slice(0, 9)}, so every session in it misses upstream's work.`,
  ];
  for (const p of paths) {
    const log = (await gitTry(root, ["log", "--format=  %h %s", `${head}..${to}`, "--", p])) ?? "";
    const merge = merges.get(p);
    lines.push("", `${p} changed upstream in:`, log || "  (upstream's history does not name it)");
    lines.push(merge ? `Three-way merge with conflict markers: ${merge}` : fs.existsSync(path.join(root, p)) ? "Upstream deletes it." : "You deleted it here; upstream changed it.");
  }
  lines.push(
    "",
    `Bring upstream's change into your working copy: resolve the markers in the merge file and copy it over yours, or redo your edit on upstream's version (git show ${to.slice(0, 9)}:<path>). Do not commit or reset the checkout. Once your file carries upstream's change, the next level sweep (within a minute) moves the checkout by itself.`,
  );
  return lines.join("\n");
}

/**
 * Brief the writer of each path in a failed level's conflicts. Returns a
 * short account for the log line, or null when there is nothing to say.
 */
export async function briefLevelConflicts(root: string, gitDir: string, r: LevelResult, deps: BriefDeps): Promise<string | null> {
  if (r.ok || !r.conflicts.length) return null;
  // A level that raced a writer has already moved HEAD; the next sweep finds it level.
  if ((await gitTry(root, ["rev-parse", "HEAD"])) !== r.from) return null;
  const now = deps.now ?? Date.now();
  const prior = readRecord(gitDir);
  const record: ConflictRecord = prior?.to === r.to ? { ...prior, unattributed: [] } : { to: r.to, sent: [], unattributed: [] };

  fs.rmSync(mergeDir(gitDir), { recursive: true, force: true });
  const merges = new Map<string, string | null>();
  for (const p of r.conflicts) merges.set(p, await writeMergeFile(root, gitDir, p, r.from, r.to));

  const since = Math.max(oldestMtime(root, r.conflicts, now) - 60_000, now - ATTRIBUTION_HORIZON_MS);
  const { owners } = (deps.attribute ?? attributeEdits)(root, r.conflicts, { since });
  const byWriter = new Map<string, string[]>();
  for (const p of r.conflicts) {
    const conv = owners.get(p)?.conversationId;
    if (!conv) { record.unattributed.push(p); continue; }
    byWriter.set(conv, [...(byWriter.get(conv) ?? []), p]);
  }

  const notes: string[] = [];
  for (const [conv, paths] of byWriter) {
    paths.sort();
    const key = [conv, ...paths].join("\n");
    const who = `${conv.slice(0, 7)} (${paths.join(", ")})`;
    if (record.sent.includes(key)) { notes.push(`already briefed ${who}`); continue; }
    const ok = await deps.send(conv, await briefFor(root, r.from, r.to, paths, merges)).catch(() => false);
    if (ok) record.sent.push(key);
    notes.push(ok ? `briefed ${who}` : `brief to ${who} failed`);
  }
  if (record.unattributed.length) notes.push(`no writer for ${record.unattributed.join(", ")}`);
  writeRecord(gitDir, record);
  return notes.join("; ") || null;
}
