/**
 * What a level conflict's writer is handed, and the one brief the sweep sends
 * at once.
 *
 * The level sweep moves a shared checkout only when every changed path has a
 * clean answer (level.ts), so one file edited here and upstream without a
 * clean merge holds the whole checkout behind. Once that has lasted
 * LEVEL_STUCK_FILE_MS, checkoutReport.ts tells each file's writer
 * (tellWriters), with the brief written here: which of its files conflict,
 * the upstream commits that touched them, and a three-way merge per file
 * under `.git/codecast/level-conflicts/`, cleared once the checkout levels.
 *
 * A level that raced a writer moves HEAD but leaves that file without
 * upstream's change (a stale copy), which would revert upstream's change when
 * shipped. The next sweep finds the checkout level and cannot see it, so its
 * writer is told at once (briefRacedStale), with the merge kept apart under
 * `.git/codecast/level-stale/` so the next level does not delete it (pruned
 * after a day).
 *
 * Every brief is a machine wake (origin "scheduler"), never a person's
 * message: it leaves the writer's pinned state and a hidden stash alone.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatSessionMessage } from "@codecast/shared/contracts";
import { LEVEL_FORBID, levelAskWords, type LevelMerge } from "@codecast/shared/contracts/checkouts";
import { execFileAsync } from "../proc.js";
import { gitTry } from "../wipSnapshot.js";
import { attributeEdits, type Attribution } from "./attribute.js";
import type { LevelResult } from "./level.js";

/**
 * Deliver `body` to conversation `to` as a machine wake. `clientId` makes a
 * retry land once. "unreachable": the server refuses for good (a teammate's
 * session, which this machine's token may not message).
 */
export type SendBrief = (to: string, body: string, clientId: string) => Promise<"sent" | "failed" | "unreachable">;

/**
 * A send that threw: "unreachable" when the server refused because the
 * conversation is not the token user's (pendingMessages.sendMessageToSession),
 * which no retry changes; "failed" for anything transient (a timeout, a 5xx,
 * the network).
 */
export function classifySendError(e: unknown): "failed" | "unreachable" {
  const text = String((e as Error)?.message ?? e);
  return /can only send messages to your own conversations/.test(text) ? "unreachable" : "failed";
}

export interface BriefDeps {
  /** Absent when this machine cannot reach the server: then nothing is attributed or briefed. */
  send?: SendBrief;
  attribute?: (root: string, paths: string[], opts: { since: number }) => Pick<Attribution, "owners">;
  now?: number;
}

/** A write older than this cannot be the one that left a file dirty. */
const ATTRIBUTION_HORIZON_MS = 14 * 86_400_000;
const BLOB_MAX_BUFFER = 256 * 1024 * 1024;
const SYMLINK = "120000";
/** At most this many upstream commits a brief lists. */
const COMMITS_MAX = 10;

/** Merge files of conflicts holding the checkout back; cleared once it levels. */
export const mergeDir = (gitDir: string) => path.join(gitDir, "codecast", "level-conflicts");
/** Merge files of stale copies a raced level left behind; kept past the level, pruned after STALE_KEEP_MS. */
export const staleDir = (gitDir: string) => path.join(gitDir, "codecast", "level-stale");
const STALE_KEEP_MS = 86_400_000;

/** Remove stale-copy merge files older than a day, and the directories they leave empty. Wall clock: it reads file mtimes. */
export function pruneStale(gitDir: string): void {
  const dir = staleDir(gitDir);
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - STALE_KEEP_MS;
  const walk = (d: string): boolean => {
    let empty = true;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory() ? walk(f) : fs.statSync(f).mtimeMs < cutoff) fs.rmSync(f, { recursive: true, force: true });
      else empty = false;
    }
    return empty;
  };
  try { if (walk(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** Forget the held conflicts' merge files: the checkout is level again. */
export function clearMerges(gitDir: string): void {
  fs.rmSync(mergeDir(gitDir), { recursive: true, force: true });
}

/** Each path's mode in `rev`; "" when it has none. */
async function upstreamModes(root: string, rev: string, paths: string[]): Promise<Map<string, string>> {
  const out = (await gitTry(root, ["--literal-pathspecs", "ls-tree", "-r", "-z", rev, "--", ...paths])) ?? "";
  const modes = new Map(paths.map((p) => [p, ""]));
  for (const entry of out.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab <= 0) continue;
    modes.set(entry.slice(tab + 1), entry.slice(0, tab).split(" ")[0]);
  }
  return modes;
}

async function blobAt(root: string, rev: string, rel: string): Promise<Buffer | null> {
  try {
    return (await execFileAsync("git", ["-C", root, "cat-file", "blob", `${rev}:${rel}`], { encoding: "buffer", maxBuffer: BLOB_MAX_BUFFER })).stdout;
  } catch {
    return null;
  }
}

const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);

/**
 * What to hand the writer for one path: `git merge-file` of the old HEAD's
 * blob (base), the working file and upstream's blob, written under `dir`.
 * Never throws: a merge file that cannot be written (a long path, a full disk,
 * a directory in the way) is "none", and the brief still goes out.
 */
async function writeMerge(root: string, dir: string, rel: string, from: string, to: string, upMode: string): Promise<LevelMerge> {
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

/** A three-way merge of each path under `dir`, from the level's base `from` and upstream `to`. Never throws. */
export async function writeMerges(root: string, dir: string, paths: string[], from: string, to: string): Promise<Map<string, LevelMerge>> {
  const modes = await upstreamModes(root, to, paths).catch(() => new Map<string, string>());
  const merges = new Map<string, LevelMerge>();
  for (const p of paths) merges.set(p, await writeMerge(root, dir, p, from, to, modes.get(p) ?? ""));
  return merges;
}

/** The upstream commits in from..to that touched any of `paths`, newest first, capped. */
async function upstreamCommits(root: string, from: string, to: string, paths: string[]): Promise<string[]> {
  const log = (await gitTry(root, ["--literal-pathspecs", "log", "--format=- %h %s", `${from}..${to}`, "--", ...paths])) ?? "";
  const lines = log.split("\n").filter(Boolean);
  if (!lines.length) return ["- (upstream's history does not name them)"];
  return lines.length > COMMITS_MAX ? [...lines.slice(0, COMMITS_MAX), `- +${lines.length - COMMITS_MAX} more`] : lines;
}

/**
 * The brief for a checkout held behind upstream, to one writer (or, `whose:
 * "nobody"`, the finding for files no session wrote): writes a three-way merge
 * of each of its files under `.git/codecast/level-conflicts/`, reads the
 * upstream commits that touched them, and says it in levelAskWords' words,
 * which the pipeline page's ask shares.
 */
export async function heldBrief(c: {
  root: string; gitDir: string; upstream: string | null; behind: number | null; level: { files: string[]; since: number };
  mine: string[]; from: string; to: string; list: string; host: string; whose: "session" | "nobody";
}): Promise<{ title: string; body: string }> {
  const dir = mergeDir(c.gitDir);
  const merges = await writeMerges(c.root, dir, c.mine, c.from, c.to);
  const commits = await upstreamCommits(c.root, c.from, c.to, c.mine);
  return levelAskWords({ path: c.root, upstream: c.upstream, behind: c.behind }, c.level, c.mine, { list: c.list, mergeDir: dir, merges: Object.fromEntries(merges), commits, to: c.to }, { host: c.host, whose: c.whose });
}

function oldestMtime(root: string, paths: string[], now: number): number {
  let oldest = now;
  for (const p of paths) {
    try { oldest = Math.min(oldest, fs.statSync(path.join(root, p)).mtimeMs); } catch {}
  }
  return oldest;
}

function action(p: string, m: LevelMerge, to: string): string {
  const show = `git show ${to.slice(0, 9)}:${p}`;
  switch (m.kind) {
    case "merged": return `Three-way merge with conflict markers: ${m.file}. Resolve the markers there and write the result over ${p}, or redo your edit on upstream's version (${show}).`;
    case "upstream-deleted": return `Upstream deletes ${p}. Delete your copy, or move your edit to where upstream moved that code.`;
    case "local-deleted": return `You deleted ${p} here and upstream changed it. If it should stay, write upstream's version back over it by hand: it is saved at ${m.file ?? "(not saved)"} (or ${show}).`;
    case "binary": return `${p} is binary or a symlink, so there is no merge file: take upstream's version (${show}) or redo your edit on it.`;
    case "none": return `No merge file could be written; upstream's version is ${show}.`;
  }
}

async function racedBrief(root: string, r: LevelResult, paths: string[], merges: Map<string, LevelMerge>): Promise<string> {
  const one = paths.length === 1;
  const lines = [`The shared checkout ${root} moved to upstream ${r.to.slice(0, 9)}, but your ${paths.join(", ")} changed while it moved and still ${one ? "lacks" : "lack"} upstream's change: as ${one ? "it stands" : "they stand"}, ${one ? "it" : "they"} would revert that change when shipped.`];
  for (const p of paths) {
    lines.push("", `${p} changed upstream in:`, ...(await upstreamCommits(root, r.from, r.to, [p])), action(p, merges.get(p) ?? { kind: "none" }, r.to));
  }
  lines.push("", `Edit only the ${one ? "file" : "files"} named here. ${LEVEL_FORBID}`, "Once your file carries upstream's change, nothing else is needed.");
  return formatSessionMessage("codecast", lines.join("\n"), { name: "level sweep" });
}

/**
 * Brief the writer of each file a raced level left stale, at once: the next
 * sweep finds the checkout level and will not see it. Returns a short account
 * for the log line, or null when the level did not race (HEAD is not on `to`).
 */
export async function briefRacedStale(root: string, gitDir: string, r: LevelResult, deps: BriefDeps): Promise<string | null> {
  if (r.ok || !r.conflicts.length) return null;
  if ((await gitTry(root, ["rev-parse", "HEAD"])) !== r.to) return null;
  if (!deps.send) return `cannot brief writers of ${r.conflicts.join(", ")}: not signed in`;
  const now = deps.now ?? Date.now();
  const since = Math.max(oldestMtime(root, r.conflicts, now) - 60_000, now - ATTRIBUTION_HORIZON_MS);
  const { owners } = (deps.attribute ?? attributeEdits)(root, r.conflicts, { since });
  const byOwner = new Map<string, string[]>();
  const nobody: string[] = [];
  for (const p of r.conflicts) {
    const owner = owners.get(p)?.conversationId;
    if (owner) byOwner.set(owner, [...(byOwner.get(owner) ?? []), p]);
    else nobody.push(p);
  }
  const notes: string[] = [];
  for (const [owner, paths] of byOwner) {
    paths.sort();
    const body = await racedBrief(root, r, paths, await writeMerges(root, staleDir(gitDir), paths, r.from, r.to));
    const clientId = `level-raced:${createHash("sha256").update([gitDir, owner, r.to, ...paths].join("\n")).digest("hex").slice(0, 24)}`;
    const outcome = await deps.send(owner, body, clientId).catch(() => "failed" as const);
    notes.push(outcome === "sent" ? `briefed ${owner.slice(0, 7)} (${paths.join(", ")})`
      : outcome === "unreachable" ? `${owner.slice(0, 7)} is a teammate's session; brief not sent (${paths.join(", ")})`
      : `brief failed to ${owner.slice(0, 7)} (${paths.join(", ")})`);
  }
  if (nobody.length) notes.push(`no writer for ${nobody.join(", ")}`);
  return notes.join("; ") || null;
}
