/**
 * Stale copies: files in a shared checkout whose diff against HEAD undoes
 * later commits, because the file (or part of it) is older than HEAD rather
 * than edited.
 *
 * A checkout's HEAD can move while its files do not: it lagged upstream and
 * caught up without rewriting them, a per-file level skipped them, a
 * worktree's patch was applied into the shared tree on an older base. Against
 * HEAD such a file reads as an edit that removes the later work, and shipping
 * it replays those removals onto upstream as reverts. The plan holds such a
 * file back and names the commits it would revert, so a person or the level
 * resolves it.
 *
 * Read from HEAD's recent history of the changed paths in one
 * `git log --raw -p -U0` walk (bounded by WINDOW_COMMITS and WINDOW_DAYS),
 * cheapest test first:
 *   copy     the frozen content is exactly a version this path had in that
 *            history (other than HEAD's or upstream's), or the file is absent,
 *            no session removed it, and a commit in the window added it.
 *   grown    the frozen content resembles an older version more than HEAD's,
 *            and most of the lines it removes from HEAD were added after that
 *            version.
 *   reverts  a hunk of the frozen diff undoes a hunk of a commit in the
 *            window whole: it removes every line that hunk added (gone from
 *            the file and not moved to another changed file), and what it
 *            puts back is what that hunk removed, or nothing (see
 *            undoneHunks). However much genuine editing sits around it, the
 *            file holds an older copy of that part. Removing part of a hunk
 *            (a function out of a file a recent commit created), or
 *            rewriting what it added, is an edit.
 */

import { createInterface } from "node:readline";
import { spawn } from "../proc.js";
import { gitTry } from "../wipSnapshot.js";
import type { Frozen } from "./commitGroups.js";
import { readBlobs } from "./scan.js";

const WINDOW_COMMITS = 3000;
const WINDOW_DAYS = 60;
/** Versions of one path compared for resemblance, newest first. */
const MAX_VERSIONS = 40;
const NULL_SHA = /^0+$/;

export interface StaleFile {
  /** Why the plan holds it, in a sentence. */
  reason: string;
  /** The commits shipping it would revert, newest first: "<short sha> <subject>". */
  reverts: string[];
}

/** One `-U0` hunk, as the content lines it removes and adds (see `significant`). */
export interface Hunk { removed: string[]; added: string[] }
interface Touch { commit: string; subject: string; src: string | null; dst: string | null; hunks: Hunk[] }

/** A line that carries content: blank lines and lone brackets match anywhere, so they prove nothing. */
function significant(raw: string): string | null {
  const line = raw.trim();
  return line.length > 3 ? line : null;
}

/**
 * `git log --raw -p -U0` (or `git diff-tree` of the same shape) read line by
 * line into touches per path. A commit header line starts with \x01 and
 * carries "<sha> <subject>".
 */
function patchParser(paths: ReadonlySet<string>): { line: (line: string) => void; touches: Map<string, Touch[]> } {
  const touches = new Map<string, Touch[]>();
  let commit = "";
  let subject = "";
  let raw = new Map<string, { src: string | null; dst: string | null }>();
  let file: Touch | null = null;
  let hunk: Hunk | null = null;
  let inHeader = false;
  const touchFor = (p: string): Touch | null => {
    if (!paths.has(p)) return null;
    const list = touches.get(p) ?? [];
    let t = list.find((x) => x.commit === commit);
    if (!t) {
      const ids = raw.get(p) ?? { src: null, dst: null };
      t = { commit, subject, ...ids, hunks: [] };
      list.push(t);
      touches.set(p, list);
    }
    return t;
  };
  const line = (line: string) => {
    if (line.startsWith("\x01")) {
      commit = line.slice(1, 41);
      subject = line.slice(42);
      raw = new Map();
      file = null;
      return;
    }
    if (line.startsWith(":") && line.includes("\t")) {
      const [meta, p] = line.slice(1).split("\t");
      const [, , src, dst] = meta.split(" ");
      raw.set(p, { src: NULL_SHA.test(src) ? null : src, dst: NULL_SHA.test(dst) ? null : dst });
      if (paths.has(p)) touchFor(p);
      return;
    }
    if (line.startsWith("diff --git ")) { file = null; hunk = null; inHeader = true; return; }
    if (inHeader) {
      if (line.startsWith("--- a/")) file = touchFor(line.slice(6));
      else if (line.startsWith("+++ b/")) file = touchFor(line.slice(6)) ?? file;
      else if (line.startsWith("@@")) inHeader = false;
      if (inHeader) return;
    }
    if (!file) return;
    if (line.startsWith("@@")) { hunk = { removed: [], added: [] }; file.hunks.push(hunk); return; }
    if (!hunk) return;
    const text = line[0] === "-" || line[0] === "+" ? significant(line.slice(1)) : null;
    if (text) (line[0] === "-" ? hunk.removed : hunk.added).push(text);
  };
  return { line, touches };
}

/**
 * Run git and feed its output to `parser` a line at a time: a window of
 * patches runs to hundreds of megabytes, past any buffer. Throws when git
 * fails, so a plan never passes a file it could not check.
 */
async function streamPatches(root: string, args: string[], parser: ReturnType<typeof patchParser>): Promise<void> {
  const child = spawn("git", ["-C", root, ...QUOTE_OFF, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr!.on("data", (b: Buffer) => { err = (err + b.toString()).slice(-2000); });
  const exited = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  for await (const l of createInterface({ input: child.stdout!, crlfDelay: Infinity })) parser.line(l);
  const code = await exited;
  if (code !== 0) throw new Error(`git ${args[0]} failed reading history for stale copies: ${err.trim() || `exit ${code}`}`);
}

const LOG_FORMAT = "--format=%x01%H %s";
const QUOTE_OFF = ["-c", "core.quotePath=off"];

/** Every commit in HEAD's recent history that changed one of `paths`, newest first, with its hunks. */
async function touchesOf(root: string, base: string, paths: Set<string>): Promise<Map<string, Touch[]>> {
  const parser = patchParser(paths);
  await streamPatches(root, ["log", "--no-renames", "--raw", "--no-abbrev", "-p", "-U0", "--no-color", "--no-ext-diff", LOG_FORMAT, `--max-count=${WINDOW_COMMITS}`, `--since=${WINDOW_DAYS}.days`, base, "--", ...paths], parser);
  return parser.touches;
}

/** The frozen diff's hunks per path, HEAD to the frozen tree. */
async function frozenHunks(root: string, base: string, tree: string, paths: Set<string>): Promise<Map<string, Hunk[]>> {
  const parser = patchParser(paths);
  parser.line(`\x01${"0".repeat(40)} frozen`);
  await streamPatches(root, ["diff-tree", "-r", "--no-renames", "-p", "-U0", "--no-color", "--no-ext-diff", base, tree, "--", ...paths], parser);
  return new Map([...parser.touches].map(([p, list]) => [p, list.flatMap((t) => t.hunks)]));
}

/** Each path's blob at `rev` (null when it has none). */
async function blobsAt(root: string, rev: string, paths: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (!paths.length) return result;
  const out = (await gitTry(root, ["ls-tree", "-z", rev, "--", ...paths])) ?? "";
  for (const rec of out.split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab > 0) result.set(rec.slice(tab + 1), rec.slice(0, tab).split(" ")[2]);
  }
  for (const p of paths) if (!result.has(p)) result.set(p, null);
  return result;
}

function lineCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of text.split("\n")) {
    const line = significant(raw);
    if (line) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/** Lines `a` holds more often than `b`, with how many more. */
function minus(a: Map<string, number>, b: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [line, n] of a) {
    const more = n - (b.get(line) ?? 0);
    if (more > 0) out.set(line, more);
  }
  return out;
}

const size = (m: Map<string, number>) => { let n = 0; for (const v of m.values()) n += v; return n; };
const distance = (a: Map<string, number>, b: Map<string, number>) => size(minus(a, b)) + size(minus(b, a));
const label = (t: Touch) => `${t.commit.slice(0, 10)} ${t.subject}`;

/**
 * The hunks of `history` the frozen file undoes whole. Each line the commit
 * hunk added is gone from the file, each line it removed is back, and one
 * frozen hunk removes all it added while putting back no more than it removed:
 * lines that hunk adds beyond what the commit removed are matched by lines it
 * removes beyond what the commit added, a genuine edit beside the stale part.
 * A frozen hunk that rewrites what a commit added adds more than that, and is
 * an edit. A file's creation and a commit hunk whose lines mostly turn up as
 * new lines in another changed file (`movedTo`, a refactor) never count.
 */
export function undoneHunks(frozenHunks: Hunk[], gone: ReadonlyMap<string, number>, frozen: ReadonlyMap<string, number>, history: Touch[], movedTo: ReadonlySet<string>): Array<{ touch: Touch; hunk: Hunk }> {
  const undone: Array<{ touch: Touch; hunk: Hunk }> = [];
  const mine = frozenHunks.map((h) => ({ removed: new Set(h.removed), hunk: h }));
  for (const touch of history) {
    if (!touch.src) continue;
    for (const hunk of touch.hunks) {
      if (!hunk.added.length || !hunk.added.every((l) => gone.has(l)) || !hunk.removed.every((l) => frozen.has(l))) continue;
      if (hunk.added.filter((l) => movedTo.has(l)).length * 2 >= hunk.added.length) continue;
      const added = new Set(hunk.added);
      const putBack = new Set(hunk.removed);
      const undoes = mine.some(({ removed, hunk: h }) => hunk.added.every((l) => removed.has(l))
        && h.added.filter((l) => !putBack.has(l)).length <= h.removed.filter((l) => !added.has(l)).length);
      if (undoes) undone.push({ touch, hunk });
    }
  }
  return undone;
}

/**
 * The frozen changes that are stale copies, by path: `tree` is the frozen
 * tree and `base` the HEAD it was frozen on. `claimed` says whether a
 * session's transcript wrote the path (attribute.ts): an absent file nobody
 * removed is the only deletion this can call stale.
 */
export async function findStaleCopies(root: string, opts: { base: string; tree: string; upstream: string; changes: Frozen["changes"]; claimed: (path: string) => boolean }): Promise<Map<string, StaleFile>> {
  const stale = new Map<string, StaleFile>();
  // A file HEAD lacks has no older version to be a copy of.
  const candidates = opts.changes.filter((c) => c.from);
  if (!candidates.length) return stale;
  const touches = await touchesOf(root, opts.base, new Set(candidates.map((c) => c.path)));
  const upstreamBlobs = await blobsAt(root, opts.upstream, candidates.filter((c) => touches.has(c.path)).map((c) => c.path));

  const edited: Array<{ change: Frozen["changes"][number]; history: Touch[] }> = [];
  for (const change of candidates) {
    const history = touches.get(change.path);
    if (!history) continue;
    if (change.blob === upstreamBlobs.get(change.path)) continue;  // upstream's own content (or its own deletion): the replay drops it
    if (!change.blob) {
      const added = history.findIndex((t) => !t.src);
      if (added >= 0 && !opts.claimed(change.path)) {
        stale.set(change.path, { reason: `absent as it was before ${history[added].commit.slice(0, 10)} added it, and no session removed it`, reverts: history.slice(0, added + 1).map(label) });
      }
      continue;
    }
    const made = history.findIndex((t) => t.dst === change.blob);
    if (made >= 0) {
      const later = history.slice(0, made);
      stale.set(change.path, { reason: `an exact copy of the version ${history[made].commit.slice(0, 10)} left; ${later.length} later commit(s) changed it`, reverts: later.map(label) });
      continue;
    }
    edited.push({ change, history });
  }
  if (!edited.length) return stale;

  const wanted = [...opts.changes.flatMap((c) => [c.blob, c.from]), ...edited.flatMap(({ history }) => history.slice(0, MAX_VERSIONS).map((t) => t.dst))];
  const texts = await readBlobs(root, wanted.filter((b): b is string => !!b));
  const counts = new Map<string, Map<string, number>>();
  const countsOf = (blob: string | null) => {
    if (!blob) return null;
    if (!counts.has(blob)) { const t = texts.get(blob); if (t === undefined) return null; counts.set(blob, lineCounts(t)); }
    return counts.get(blob)!;
  };

  // Lines each changed file gained in the freeze: where moved code went.
  const gained = new Map(opts.changes.map((c) => [c.path, new Set(minus(countsOf(c.blob) ?? new Map(), countsOf(c.from) ?? new Map()).keys())]));
  const movedOutOf = (path: string) => {
    const lines = new Set<string>();
    for (const [p, set] of gained) if (p !== path) for (const l of set) lines.add(l);
    return lines;
  };

  const hunksOf = await frozenHunks(root, opts.base, opts.tree, new Set(edited.map((e) => e.change.path)));
  for (const { change, history } of edited) {
    const frozen = countsOf(change.blob);
    const head = countsOf(change.from);
    if (!frozen || !head) continue;
    const gone = minus(head, frozen);
    if (size(gone) === 0) continue;  // adds only: nothing to revert

    // grown: the version it grew from is an older one, and most of what it removes came after that version.
    const headDistance = distance(frozen, head);
    let grewFrom: { at: number; lines: Map<string, number>; d: number } | null = null;
    for (const [at, t] of history.slice(0, MAX_VERSIONS).entries()) {
      const lines = t.dst === change.from ? null : countsOf(t.dst);
      if (!lines) continue;
      const d = distance(frozen, lines);
      if (d < headDistance && (!grewFrom || d < grewFrom.d)) grewFrom = { at, lines, d };
    }
    if (grewFrom) {
      const unseen = minus(gone, grewFrom.lines);
      const n = size(unseen);
      if (n >= 2 && n * 2 >= size(gone)) {
        const reverts = history.slice(0, grewFrom.at).filter((t) => t.hunks.some((k) => k.added.some((l) => unseen.has(l))));
        stale.set(change.path, { reason: `grew from the version ${history[grewFrom.at].commit.slice(0, 10)} left and would remove ${n} of ${size(gone)} removed line(s) that later commits added`, reverts: reverts.map(label) });
        continue;
      }
    }

    // reverts: commit hunks undone whole, whatever genuine editing surrounds them.
    const undone = undoneHunks(hunksOf.get(change.path) ?? [], gone, frozen, history, movedOutOf(change.path));
    if (undone.length) {
      const commits = [...new Map(undone.map((u) => [u.touch.commit, u.touch])).values()];
      const lines = undone.reduce((n, u) => n + u.hunk.added.length, 0);
      stale.set(change.path, { reason: `undoes ${undone.length} hunk(s) of ${commits.length} later commit(s), ${lines} line(s) they added; that part is an older copy`, reverts: commits.map(label) });
    }
  }
  return stale;
}
