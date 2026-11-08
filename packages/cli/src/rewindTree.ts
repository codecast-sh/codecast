/**
 * Rewind a checkout's files to how they stood just before a turn, in place,
 * with a way to put everything back.
 *
 * Built on the turn snapshots (treeSnapshot.ts): the daemon commits the
 * working tree at every turn end, and treeSnapshots rows say which of those
 * commits close which session's turns. Each row's snapshot is one link in the
 * checkout's chain: from the snapshot before it (`prev_sha`) to its own tree.
 * The links of the session's rows after the chosen message hold what this
 * turn and the later ones changed, and also whatever anyone else changed in
 * the same stretch: a person between turns, another session in the same
 * checkout, a formatter. A snapshot cannot say who changed a file, so a path
 * counts as the session's only when its own tool calls named it (file_changes,
 * read through treeSnapshots.editedPaths). Everything else is left alone and
 * listed, never guessed.
 *
 * Per path, the restore source is the last tree taken before the session's
 * first edit of it (by its file_changes times), and the version the session
 * left is the first tree taken after its last edit. A path that changed in a
 * stretch between two trees with no edit of the session's in it was changed
 * by someone else, and so was one whose working copy differs from the version
 * the session left: staging refuses both unless the person chooses to
 * overwrite them.
 *
 * Staging is undoable. Before any file changes, the current versions of
 * exactly the paths it will touch are committed to a backup (no parent, kept
 * alive by refs/codecast/rewind/<id>), and the staged state is written under
 * the git dir. Put back restores them from the backup, refusing paths edited
 * after the rewind unless forced; keep drops the backup. One staged rewind per
 * checkout at a time.
 *
 * Never touches HEAD, the branch or the real index: files are written with
 * `git restore --worktree` and deleted directly.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TAKEN_AT_TRAILER, snapshotStateDir } from "./treeSnapshot.js";
import { ensureSnapshotLocal, type TurnSnapshotRow } from "./turns.js";
import { SNAPSHOT_IDENTITY, defaultRemote, git, gitTry, parseSnapshotTrailer } from "./wipSnapshot.js";
import { REWIND_ROWS_CAP } from "@codecast/shared/contracts";

export type RewindRow = Pick<TurnSnapshotRow, "sha" | "base_sha" | "prev_sha" | "taken_at" | "turn_completed_at"> & { source?: TurnSnapshotRow["source"] };

/** A file the session's own tool calls changed, and when (ms; message times). A bare path means "at some time after the message". */
export type OwnEdit = string | { path: string; at: number[] };

/** Longer than a turn snapshot's coalescing and record take: a turn row taken later than this after its turn ended is late. */
const LATE_TURN_MS = 30_000;

/** A tool call's write lands just after its message's time, perhaps after a snapshot taken in that gap. */
const EDIT_SLACK_MS = 60_000;


/**
 * restore: the file is put back to its earlier content.
 * delete: the session created it; it goes.
 * recreate: the session deleted it; it comes back.
 */
export type RewindAction = "restore" | "delete" | "recreate";

export interface RewindFile {
  path: string;
  action: RewindAction;
  /** Changed since the session last touched it, by someone else. */
  conflict: boolean;
  /** Blob the rewind writes; null when the file goes. */
  to: string | null;
  /** Blob in the working tree now; null when absent. */
  now: string | null;
  /** The snapshot whose tree holds `to`. */
  source: string;
}

export interface RewindPlan {
  root: string;
  conversation_id: string;
  /** The message the tree rewinds to just before (ms). */
  at: number;
  files: RewindFile[];
  /** The session's snapshots after the message, which the files were read from. */
  turns: number;
  /** The first link starts at the message (a prompt snapshot); false for a session from before those, whose first link starts at the previous turn's end. */
  from_prompt: boolean;
  /** HEAD moved since the message: commits made since are kept, only files move. */
  head_moved: boolean;
  /** Files those snapshots changed that the session's own edits do not name, or that cannot be written back safely: left alone. */
  left_alone: string[];
  /** Names the plan exactly; staging refuses a plan that no longer matches. */
  fingerprint: string;
}

export interface StagedRewind {
  id: string;
  conversation_id: string;
  at: number;
  staged_at: number;
  backup: string;
  files: Array<{ path: string; action: RewindAction; /** what the rewind wrote */ to: string | null; /** what the backup holds */ was: string | null }>;
}

export class RewindRefused extends Error {
  /** `blocked`: the paths are things in the way that must be moved; no overwrite gets past them. */
  constructor(message: string, readonly paths: string[] = [], readonly blocked = false) {
    super(message);
  }
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fc6536ff";
const LITERAL: NodeJS.ProcessEnv = { ...process.env, GIT_LITERAL_PATHSPECS: "1" };
const CHUNK = 400;

function chunks<T>(xs: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** A tree the session's rows recorded: when it was taken, and whether it closed a turn. */
/** `boundary`: taken at a turn's end or a prompt: every write of the turn before it had landed. `late`: recorded after the fact, so it vouches for nothing. */
type OwnTree = { sha: string; at: number; turn: boolean; boundary?: boolean; late?: boolean };

/**
 * The session's own trees from the message on, oldest first by when each was
 * taken (what the tree holds is the files as of that moment). The first is
 * the tree at the message: the prompt snapshot the daemon took when it was
 * submitted, else the session's last tree before it (a session from before
 * prompt snapshots; `fromPrompt` says so), else the first later row's parent.
 * Only the session's own rows: whatever other snapshots sit between them in
 * the checkout's chain, the diff between two own trees holds everything that
 * changed in between, and the session's edit times decide what was its own.
 */
export function ownTrees(rows: RewindRow[], at: number): { trees: OwnTree[]; fromPrompt: boolean; before?: RewindRow; startIsCommit: boolean } {
  const sorted = [...rows].sort((a, b) => a.taken_at - b.taken_at);
  // The message's own prompt snapshot is taken just after it was sent, on the same machine's clock.
  // The hook fires after the message is written, on the same machine's clock:
  // the first prompt snapshot at or after it, unless a turn ended in between
  // (then that snapshot is a later message's). A slow snapshot still counts.
  const candidate = sorted.find((r) => r.source === "prompt" && r.taken_at >= at);
  const turnBetween = candidate && sorted.some((r) => r.source !== "prompt" && r.turn_completed_at !== undefined && r.turn_completed_at >= at && r.turn_completed_at < candidate.taken_at);
  const prompt = candidate && !turnBetween ? candidate : undefined;
  const start = prompt ?? sorted.filter((r) => r.taken_at <= at).pop();
  const after = sorted.filter((r) => r !== start && r.taken_at > (start ? start.taken_at : at));
  const isTurn = (r: RewindRow) => r.source !== "sweep" && r.source !== "prompt" && r.turn_completed_at !== undefined;
  const first = start ? { sha: start.sha, at: start.taken_at, turn: false, boundary: true } : after[0] ? { sha: after[0].prev_sha ?? after[0].base_sha, at, turn: false, boundary: true } : null;
  const trees: OwnTree[] = first ? [first] : [];
  for (const r of after) {
    if (r.sha === trees[trees.length - 1]?.sha) continue;
    // A turn row taken long after its turn ended (recorded late, or a snapshot that queued for minutes) holds whatever happened meanwhile.
    const late = isTurn(r) && r.taken_at - (r.turn_completed_at ?? r.taken_at) > LATE_TURN_MS;
    trees.push({ sha: r.sha, at: r.taken_at, turn: isTurn(r), boundary: (isTurn(r) && !late) || r.source === "prompt", late });
  }
  const before = sorted.filter((r) => r.taken_at <= at).pop();
  // No tree of the session's from before the message and no snapshot before
  // its first later one: the start would be a bare commit, without the
  // uncommitted work the checkout held.
  const startIsCommit = !start && !!after[0] && !after[0].prev_sha;
  return { trees, fromPrompt: !!prompt, before, startIsCommit };
}

/** When a snapshot commit's tree was taken (its codecast-taken-at trailer), or null when it is not one. */
async function takenAt(root: string, sha: string): Promise<number | null> {
  const raw = await gitTry(root, ["show", "-s", "--format=%B", sha]);
  const t = raw ? parseSnapshotTrailer(raw, TAKEN_AT_TRAILER) : undefined;
  const ms = t ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** "<mode> <blob>" of `paths` in a commit's tree, so a chmod is a change; gitlinks (submodules) are reported as "gitlink". */
async function blobsIn(root: string, commit: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const noModes = await ignoresFileMode(root);
  for (const part of chunks(paths)) {
    const raw = (await gitTry(root, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...part], LITERAL)) ?? "";
    for (const entry of raw.split("\0").filter(Boolean)) {
      const tab = entry.indexOf("\t");
      const [mode, , sha] = entry.slice(0, tab).split(" ");
      out.set(entry.slice(tab + 1), mode === "160000" ? "gitlink" : `${noModes && mode === "100755" ? "100644" : mode} ${sha}`);
    }
  }
  return out;
}

/** "<mode> <blob>" of the working copies of `paths` as git would store them; absent paths are left out. */
// A checkout with core.fileMode=false keeps no executable bits: git stores 100644 whatever the disk says.
const fileModeOff = new Map<string, Promise<boolean>>();
function ignoresFileMode(root: string): Promise<boolean> {
  if (!fileModeOff.has(root)) fileModeOff.set(root, gitTry(root, ["config", "--bool", "core.fileMode"]).then((v) => v === "false"));
  return fileModeOff.get(root)!;
}

async function workingBlobs(root: string, paths: string[], write = false): Promise<Map<string, string>> {
  const noModes = await ignoresFileMode(root);
  const out = new Map<string, string>();
  const files: string[] = [];
  const modes = new Map<string, string>();
  for (const p of paths) {
    let st: fs.Stats;
    try { st = fs.lstatSync(path.join(root, p)); } catch { continue; }
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(path.join(root, p));
      out.set(p, `120000 ${await git(root, ["hash-object", ...(write ? ["-w"] : []), "--stdin"], undefined, target)}`);
    } else if (st.isFile()) {
      files.push(p);
      modes.set(p, !noModes && st.mode & 0o100 ? "100755" : "100644"); // git reads the owner's execute bit only
    } else if (st.isDirectory()) {
      out.set(p, "directory");
    }
  }
  for (const part of chunks(files)) {
    const shas = (await git(root, ["hash-object", ...(write ? ["-w"] : []), "--stdin-paths"], undefined, part.join("\n") + "\n")).split("\n");
    part.forEach((p, i) => out.set(p, `${modes.get(p)} ${shas[i]}`));
  }
  return out;
}

/**
 * The session's own edited paths, root-relative. Tool calls name paths as the
 * agent saw them: absolute (perhaps through a symlink the root does not use,
 * /var vs /private/var) or relative to its working folder.
 */
function ownPaths(root: string, cwd: string, edited: OwnEdit[]): { paths: Map<string, number[] | null>; outside: string[] } {
  const real = (p: string) => {
    // The file may be gone (a delete); its folder, or the nearest one that exists, resolves the link.
    let dir = p;
    const rest: string[] = [];
    for (let i = 0; i < 64 && dir !== path.dirname(dir); i++) {
      try { return path.join(fs.realpathSync(dir), ...rest.reverse()); } catch {}
      rest.push(path.basename(dir));
      dir = path.dirname(dir);
    }
    return p;
  };
  const realRoot = real(root);
  const out = new Map<string, number[] | null>();
  const outside = new Set<string>();
  for (const e of edited) {
    const p = typeof e === "string" ? e : e.path;
    const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
    const rel = path.relative(realRoot, real(abs)).split(path.sep).join("/");
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      outside.add(abs);
      continue;
    }
    const prev = out.get(rel);
    // null: edited at some unknown time after the message.
    out.set(rel, typeof e === "string" || !e.at.length || prev === null ? null : [...(prev ?? []), ...e.at].sort((x, y) => x - y));
  }
  return { paths: out, outside: [...outside] };
}

/** Whether `p` lies inside a submodule of `commit`'s tree. */
async function insideGitlink(root: string, commit: string, p: string): Promise<boolean> {
  const parts = p.split("/");
  const prefixes = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
  if (!prefixes.length) return false;
  const raw = (await gitTry(root, ["ls-tree", "-z", "--full-tree", commit, "--", ...prefixes], LITERAL)) ?? "";
  return raw.split("\0").some((entry) => entry.startsWith("160000 "));
}

/** Every file under directory `rel`, root-relative. */
function listFiles(root: string, rel: string): string[] {
  const out: string[] = [];
  const walk = (r: string) => {
    for (const e of fs.readdirSync(path.join(root, r), { withFileTypes: true })) {
      const child = path.join(r, e.name);
      if (e.isDirectory()) walk(child);
      else out.push(child);
    }
  };
  try { walk(rel); } catch {}
  return out;
}

function fingerprintOf(files: RewindFile[]): string {
  const h = crypto.createHash("sha1");
  for (const f of files) h.update(`${f.path}\0${f.action}\0${f.to ?? "-"}\0${f.now ?? "-"}\0${f.conflict ? 1 : 0}\n`);
  return h.digest("hex").slice(0, 16);
}

/**
 * What a rewind to just before `at` would do to the checkout at `root`: every
 * path the session's turns since then changed, what it goes back to, and
 * whether someone else changed it after the session did.
 */
export async function planRewind(
  root: string,
  conversationId: string,
  rows: RewindRow[],
  at: number,
  /**
   * The files the session's own tool calls changed after `at` (absolute or
   * root-relative): the only paths that count. Null when unknown, which
   * counts none: a rewind leaves a file alone rather than guess it was this
   * session's.
   */
  edited: OwnEdit[] | null = null,
  opts: {
    /** The session's working folder, which relative edited paths are relative to (defaults to the root). */
    cwd?: string;
    /** How long before a snapshot an edit's message time may be and its write still land after it. */
    slackMs?: number;
    /** Edits by the person's other sessions in this checkout over the same stretch: a file one of them touched is a conflict. */
    others?: OwnEdit[];
    /** The server's row cap cut the session's older rows (before any per-checkout filtering). */
    truncated?: boolean;
  } = {},
): Promise<RewindPlan> {
  const cwd = opts.cwd ?? root;
  const slack = opts.slackMs ?? EDIT_SLACK_MS;
  if ((opts.truncated ?? rows.length >= REWIND_ROWS_CAP) && Math.min(...rows.map((r) => r.taken_at)) > at) {
    throw new RewindRefused(`more than ${REWIND_ROWS_CAP} snapshots were taken since that message: rewind to a later one`);
  }
  const own = ownTrees(rows, at);
  const fromPrompt = own.fromPrompt;
  if (own.startIsCommit) throw new RewindRefused("no snapshot of the files from before this message exists, so the rewind cannot tell your uncommitted work from the session's");
  // Only edits after the message count; a path the session edited only before it is not part of this rewind.
  const owned = ownPaths(root, cwd, edited ?? []);
  const ours = new Map([...owned.paths].map(([p, t]) => [p, t && t.filter((x) => x > at)] as const).filter(([, t]) => t === null || t.length > 0));
  const theirs = ownPaths(root, cwd, opts.others ?? []).paths;
  // The tree at the message was read while the agent may already have been
  // writing (a slow snapshot, or one queued behind another): an edit before
  // it finished may be inside it. Those files go back to the session's tree
  // from before the message instead, and are flagged, since a person may
  // have changed them in between.
  const earliest = Math.min(...[...ours.values()].flatMap((t) => t ?? []));
  const early = fromPrompt && own.trees.length > 0 && earliest <= own.trees[0].at;
  if (early && !own.before) {
    const names = [...ours].filter(([, t]) => t?.some((x) => x <= own.trees[0].at)).map(([p]) => p);
    throw new RewindRefused("the agent was already writing before the snapshot of this message was taken, and no earlier one exists", names);
  }
  const pre = early ? { sha: own.before!.sha, at: own.before!.taken_at, turn: false, boundary: true } : null;
  const remote = own.trees.length ? await defaultRemote(root) : null;
  for (const t of [...(pre ? [pre] : []), ...own.trees]) {
    if (!(await ensureSnapshotLocal(root, t.sha, conversationId, remote))) {
      throw new RewindRefused(`snapshot ${t.sha.slice(0, 10)} is not in this checkout and could not be fetched`);
    }
  }
  // The snapshot just before each of the session's own (another session's turn
  // end, a sweep) splits the stretch between two of its trees: a finer
  // timeline, timed by when each tree was actually taken.
  const trees: OwnTree[] = [...(pre && pre.sha !== own.trees[0]?.sha ? [pre] : []), ...own.trees];
  const shas = new Set(trees.map((t) => t.sha));
  for (const r of rows) {
    if (!r.prev_sha || shas.has(r.prev_sha) || !own.trees.some((t) => t.sha === r.sha)) continue;
    const taken = await takenAt(root, r.prev_sha);
    if (taken === null || taken <= own.trees[0].at) continue;
    trees.push({ sha: r.prev_sha, at: taken, turn: false });
    shas.add(r.prev_sha);
  }
  trees.sort((a, b) => a.at - b.at);
  // What changed between each two of the session's trees, whoever changed it.
  const steps: Array<Set<string>> = [];
  const changed = new Set<string>();
  for (let i = 1; i < trees.length; i++) {
    const raw = (await gitTry(root, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", `${trees[i - 1].sha}^{tree}`, `${trees[i].sha}^{tree}`])) ?? "";
    const set = new Set(raw.split("\0").filter(Boolean));
    steps.push(set);
    for (const p of set) changed.add(p);
  }
  // Only edits after the message count; a path the session edited only before it is not part of this rewind.
  // A message delivered mid-turn has no prompt snapshot of its own while the
  // session does take them: its turn began earlier, and the files as they
  // stood at the message itself were never recorded.
  if (!fromPrompt && rows.some((r) => r.source === "prompt" && r.taken_at < at)) {
    throw new RewindRefused("no snapshot was taken when this message was sent (it arrived mid-turn, or snapshots were paused): rewind to the message that started that turn");
  }
  const others = new Set([...changed].filter((p) => !ours.has(p)));
  // Edited files no snapshot holds (gitignored, inside a submodule) or outside
  // the checkout: never rewound, so listed rather than silently passed over.
  const unseen = [...ours.keys()].filter((p) => !changed.has(p));
  if (unseen.length && trees.length) {
    const ignored = new Set(((await gitTry(root, ["check-ignore", "-z", "--stdin"], undefined, unseen.join("\0"))) ?? "").split("\0").filter(Boolean));
    const lastTree = await blobsIn(root, trees[trees.length - 1].sha, unseen);
    const nowUnseen = await workingBlobs(root, unseen);
    for (const p of unseen) {
      if (ignored.has(p) || (await insideGitlink(root, trees[trees.length - 1].sha, p))) others.add(p);
      // Edited after the session's last snapshot (one skipped while the checkout was parked): listed, never silently kept.
      else if ((nowUnseen.get(p) ?? null) !== (lastTree.get(p) ?? null)) others.add(p);
    }
  }
  for (const p of owned.outside) others.add(p);
  // Per path: the tree just before the session first edited it, the tree just
  // after it last did, and whether the path changed in a stretch where the
  // session made no edit to it (someone else's change, which a rewind would discard).
  const sourceIdx = new Map<string, number>();
  const leftIdx = new Map<string, number>();
  const foreign = new Set<string>();
  for (const [p, times] of ours) {
    if (!changed.has(p)) continue;
    const firstEdit = times?.[0] ?? -Infinity;
    const lastEdit = times?.[times.length - 1] ?? Infinity;
    let src = 0;
    while (src + 1 < trees.length && trees[src + 1].at < firstEdit) src++;
    // The first tree that surely holds the last write: a turn's end or a prompt, or one taken a slack after the edit.
    let left = trees.length - 1;
    for (let i = src; i < trees.length; i++) if (trees[i].at >= lastEdit && (trees[i].boundary || trees[i].at >= lastEdit + slack)) { left = i; break; }
    sourceIdx.set(p, src);
    leftIdx.set(p, left);
    // Going back to the tree from before the message's own snapshot: what a person did in between is in the way.
    if (pre && src === 0) foreign.add(p);
    // Another of the person's sessions in this checkout edited the file too.
    const other = theirs.get(p);
    if (other === null || other?.some((t) => t > trees[src].at - slack)) foreign.add(p);
    if (times) {
      for (let i = src; i < steps.length; i++) {
        if (!steps[i].has(p)) continue;
        // An edit's write can land a little after its message's time, so an
        // edit just before a snapshot still excuses the stretch after it,
        // but never across a turn's end or a prompt: every write of a turn
        // has landed before either is taken.
        let boundaryAt = -Infinity;
        for (let j = i; j >= 0; j--) if (trees[j].boundary) { boundaryAt = trees[j].at; break; }
        const from = Math.max(trees[i].at - slack, boundaryAt);
        const to = trees[i + 1].at;
        if (!times.some((t) => t > from && t <= to)) foreign.add(p);
      }
    }
    // A tree recorded after the fact holds whatever happened since the turn
    // ended: it cannot show the version the session left.
    if (trees[left].late) foreign.add(p);
  }
  const paths = [...sourceIdx.keys()].sort();
  const blobsAt = async (idx: Map<string, number>) => {
    const out = new Map<string, string>();
    const by = new Map<number, string[]>();
    for (const p of paths) by.set(idx.get(p)!, [...(by.get(idx.get(p)!) ?? []), p]);
    for (const [i, ps] of by) for (const [p, b] of await blobsIn(root, trees[i].sha, ps)) out.set(p, b);
    return out;
  };
  const source = await blobsAt(sourceIdx);
  const left = await blobsAt(leftIdx);
  const now = await workingBlobs(root, paths);
  const sourceSha = (p: string) => trees[sourceIdx.get(p)!].sha;

  const files: RewindFile[] = [];
  const dirs: string[] = [];
  for (const p of paths) {
    const to = source.get(p) ?? null;
    const cur = now.get(p) ?? null;
    // A submodule pointer is not a file the rewind can write.
    if (to === "gitlink" || left.get(p) === "gitlink") {
      others.add(p);
      continue;
    }
    if (cur === "directory") {
      // The session turned a file into a directory: decided below, once the files inside are known.
      if (to !== null) dirs.push(p);
      // A file the session created that is now a directory (someone else's): not the session's to remove.
      else others.add(p);
      continue;
    }
    if (to === cur) continue; // already as it was
    files.push({
      path: p,
      action: to === null ? "delete" : cur === null ? "recreate" : "restore",
      conflict: cur !== (left.get(p) ?? null) || foreign.has(p),
      to,
      now: cur,
      source: sourceSha(p),
    });
  }
  // A directory where the file was comes back as the file only when every file
  // inside it is one the rewind deletes; otherwise someone else's file would go.
  const deleted = new Set(files.filter((f) => f.to === null).map((f) => f.path));
  for (const p of dirs) {
    const inside = listFiles(root, p);
    if (inside.every((f) => deleted.has(f))) {
      files.push({ path: p, action: "recreate", conflict: (left.get(p) ?? null) !== null || foreign.has(p), to: source.get(p)!, now: null, source: sourceSha(p) });
    } else {
      others.add(p);
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const head = await gitTry(root, ["rev-parse", "--verify", "HEAD"]);
  const startBase = rows.find((r) => r.sha === trees[0]?.sha)?.base_sha ?? [...rows].sort((a, b) => a.taken_at - b.taken_at).find((r) => r.taken_at > at)?.base_sha;
  return {
    root,
    conversation_id: conversationId,
    at,
    files,
    turns: trees.filter((t) => t.turn).length,
    from_prompt: fromPrompt || trees.length < 2,
    head_moved: !!head && !!startBase && head !== startBase,
    left_alone: [...others].filter((p) => !files.some((f) => f.path === p)).sort(),
    fingerprint: fingerprintOf(files),
  };
}

// ─── Staged state ────────────────────────────────────────────────────────────

async function stateFile(root: string): Promise<string> {
  const dir = await snapshotStateDir(root);
  if (!dir) throw new RewindRefused("not a git checkout");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "rewind.json");
}

const backupRef = (id: string) => `refs/codecast/rewind/${id}`;

export async function readStaged(root: string): Promise<StagedRewind | null> {
  try {
    const parsed = JSON.parse(fs.readFileSync(await stateFile(root), "utf8")) as StagedRewind;
    if (!parsed?.id || !parsed.backup || !Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function clearStaged(root: string, staged: StagedRewind): Promise<void> {
  await gitTry(root, ["update-ref", "-d", backupRef(staged.id)]);
  try { fs.unlinkSync(await stateFile(root)); } catch {}
}

/**
 * Bring each path to its blob: null deletes it, otherwise it is written from
 * `commit`'s tree. Deletes go first, so a file can take the place of the
 * directory it had become (and the other way round).
 */
async function writePaths(root: string, items: Array<{ path: string; blob: string | null; commit: string }>): Promise<void> {
  for (const i of items) {
    if (i.blob !== null) continue;
    const abs = path.join(root, i.path);
    try { fs.rmSync(abs, { force: true }); } catch {}
    // Leave no empty directory behind the files the turn created.
    for (let dir = path.dirname(abs); dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
      try { fs.rmdirSync(dir); } catch { break; }
    }
  }
  const byCommit = new Map<string, string[]>();
  for (const i of items) if (i.blob !== null) byCommit.set(i.commit, [...(byCommit.get(i.commit) ?? []), i.path]);
  // A private index: `git restore` takes the index lock, and the checkout's
  // own index.lock is often held by an editor's background `git status`.
  const idx = path.join(path.dirname(await stateFile(root)), `rewind.write.${process.pid}.index`);
  const env = { ...LITERAL, GIT_INDEX_FILE: idx };
  try {
    for (const [commit, paths] of byCommit) {
      for (const part of chunks(paths)) {
        // Where the file goes back, the directory it had become is now empty (the plan deleted what was inside).
        for (const p of part) {
          try { if (fs.lstatSync(path.join(root, p)).isDirectory()) fs.rmdirSync(path.join(root, p)); } catch {}
        }
        await git(root, ["restore", `--source=${commit}`, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], env, part.join("\0"));
      }
    }
  } finally {
    for (const f of [idx, `${idx}.lock`]) try { fs.unlinkSync(f); } catch {}
  }
}

/**
 * What stands in the way of writing these items: `git restore` removes it
 * without asking. A file where a folder on the way should be, or a folder
 * holding files where a file goes, unless those are themselves being deleted.
 */
function blockers(root: string, items: Array<{ path: string; blob: string | null }>): string[] {
  const deleting = new Set(items.filter((i) => i.blob === null).map((i) => i.path));
  const out = new Set<string>();
  for (const i of items) {
    if (i.blob === null) continue;
    const parts = i.path.split("/");
    for (let n = 1; n < parts.length; n++) {
      const dir = parts.slice(0, n).join("/");
      try {
        if (!fs.lstatSync(path.join(root, dir)).isDirectory() && !deleting.has(dir)) out.add(dir);
      } catch {}
    }
    try {
      if (fs.lstatSync(path.join(root, i.path)).isDirectory()) {
        for (const f of listFiles(root, i.path)) if (!deleting.has(f)) out.add(f);
      }
    } catch {}
  }
  return [...out].sort();
}

const LOCK_STALE_MS = 10 * 60_000;

/** One stage, put back or keep at a time per checkout, across processes (two daemons can share a machine). */
async function withLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(path.dirname(await stateFile(root)), "rewind.lock");
  // A stale lock (a crashed step) is taken over by renaming it away: only one
  // of two steps that both saw it stale can win the rename, so neither can
  // delete the other's fresh lock.
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
      const gone = `${lock}.stale.${process.pid}.${Date.now()}`;
      fs.renameSync(lock, gone);
      fs.unlinkSync(gone);
    }
  } catch {}
  let fd: number;
  try {
    fd = fs.openSync(lock, "wx");
  } catch {
    throw new RewindRefused("another rewind step is running in this checkout: try again in a moment");
  }
  try {
    return await fn();
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch {}
  }
}

/**
 * Stage `plan`: back up the current versions of its paths, then rewind them.
 * `fingerprint` is the plan the person reviewed; a tree that moved since is
 * refused. Conflicts are refused unless `overwrite`.
 */
export async function stageRewind(plan: RewindPlan, opts: { fingerprint: string; overwrite?: boolean }): Promise<StagedRewind> {
  return withLock(plan.root, () => stageLocked(plan, opts));
}

async function stageLocked(plan: RewindPlan, opts: { fingerprint: string; overwrite?: boolean }): Promise<StagedRewind> {
  const root = plan.root;
  const open = await readStaged(root);
  if (open) throw new RewindRefused("a rewind is already staged in this checkout: put it back or keep it first");
  if (plan.fingerprint !== opts.fingerprint) throw new RewindRefused("the files changed since the review: look again");
  if (!plan.files.length) throw new RewindRefused("nothing to rewind: the files are already as they were");
  const blocked = blockers(root, plan.files.map((f) => ({ path: f.path, blob: f.to })));
  if (blocked.length) throw new RewindRefused("something now stands where a file goes back: move it first", blocked, true);
  const conflicts = plan.files.filter((f) => f.conflict).map((f) => f.path);
  if (conflicts.length && !opts.overwrite) throw new RewindRefused(`${conflicts.length} file${conflicts.length === 1 ? " was" : "s were"} changed since by someone else`, conflicts);

  // The backup: a parentless commit of exactly the paths about to change, as they are now.
  const dir = path.dirname(await stateFile(root));
  const idx = path.join(dir, `rewind.${process.pid}.index`);
  const env = { ...LITERAL, GIT_INDEX_FILE: idx };
  let backup: string;
  try {
    await git(root, ["read-tree", "--empty"], env);
    const present = plan.files.filter((f) => f.now !== null).map((f) => f.path);
    for (const part of chunks(present)) await git(root, ["update-index", "--add", "-z", "--stdin"], env, part.join("\0"));
    const tree = present.length ? await git(root, ["write-tree"], env) : EMPTY_TREE;
    // The backup read the files now; one saved since the plan was made would be
    // rewound on a judgement made about its older content.
    const held = present.length ? await blobsIn(root, tree, present) : new Map<string, string>();
    // A path the plan brings back (absent then) that someone created since would be overwritten with nothing to put back.
    // (A directory there is the one the plan empties to put the file back.)
    const appeared = (p: string) => { try { return !fs.lstatSync(path.join(root, p)).isDirectory(); } catch { return false; } };
    const moved = plan.files.filter((f) => (f.now !== null ? held.get(f.path) !== f.now : appeared(f.path))).map((f) => f.path);
    if (moved.length) throw new RewindRefused("files changed while the rewind was starting: look again", moved);
    backup = await git(root, ["commit-tree", tree, "-m", `codecast rewind backup\n\ncodecast-conversation: ${plan.conversation_id}`], { ...process.env, ...SNAPSHOT_IDENTITY });
  } finally {
    try { fs.unlinkSync(idx); } catch {}
  }
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  await git(root, ["update-ref", backupRef(id), backup]);
  const staged: StagedRewind = {
    id, conversation_id: plan.conversation_id, at: plan.at, staged_at: Date.now(), backup,
    files: plan.files.map((f) => ({ path: f.path, action: f.action, to: f.to, was: f.now })),
  };
  // State first: a crash mid-write still leaves the way back on disk.
  fs.writeFileSync(await stateFile(root), JSON.stringify(staged, null, 2), { mode: 0o600 });

  try {
    await writePaths(root, plan.files.map((f) => ({ path: f.path, blob: f.to, commit: f.source })));
  } catch (e) {
    // Part way through: put every path back from the backup, so a failed
    // rewind changes nothing. If even that fails, the staged state stays and
    // Put back is the way out.
    const why = (e as Error)?.message?.split("\n").find((l) => /fatal|error/i.test(l)) ?? "git failed";
    try {
      await writePaths(root, staged.files.map((f) => ({ path: f.path, blob: f.was, commit: backup })));
      await clearStaged(root, staged);
    } catch {
      throw new RewindRefused(`the rewind stopped part way (${why}): Put back restores every file`);
    }
    throw new RewindRefused(`could not write the files (${why}); nothing was changed`);
  }
  return staged;
}

/**
 * Put the staged rewind back: every path returns to the version the backup
 * holds. A path edited after the rewind (the fork's agent, a person) is
 * refused unless `force`, since putting back would discard that edit.
 */
export async function putBackRewind(root: string, opts: { force?: boolean } = {}): Promise<{ staged: StagedRewind; restored: number }> {
  return withLock(root, async () => {
    const staged = await readStaged(root);
    if (!staged) throw new RewindRefused("no rewind is staged in this checkout");
    const now = await workingBlobs(root, staged.files.map((f) => f.path));
    const edited = staged.files.filter((f) => (now.get(f.path) ?? null) !== f.to).map((f) => f.path);
    if (edited.length && !opts.force) throw new RewindRefused(`${edited.length} file${edited.length === 1 ? " was" : "s were"} edited after the rewind`, edited);
    // Even forced: what was made since in a restored file's way has no backup to come back from.
    const blocked = blockers(root, staged.files.map((f) => ({ path: f.path, blob: f.was })));
    if (blocked.length) throw new RewindRefused("something made since the rewind stands where a file goes back: move it first", blocked, true);
    await writePaths(root, staged.files.map((f) => ({ path: f.path, blob: f.was, commit: staged.backup })));
    await clearStaged(root, staged);
    return { staged, restored: staged.files.length };
  });
}

/** Keep the rewound files and drop the backup. */
export async function keepRewind(root: string): Promise<StagedRewind> {
  return withLock(root, async () => {
    const staged = await readStaged(root);
    if (!staged) throw new RewindRefused("no rewind is staged in this checkout");
    await clearStaged(root, staged);
    return staged;
  });
}

// ─── Diffs ───────────────────────────────────────────────────────────────────

const DIFF_CAP = 100_000;

/** The unified diff of what staging would do: from each working copy now to what it goes back to. */
export async function diffRewind(plan: RewindPlan, only?: string): Promise<{ diff: string; truncated: boolean }> {
  const root = plan.root;
  const files = plan.files.filter((f) => !only || f.path === only);
  // The working copies go into the object store so git can diff them as blobs.
  const written = await workingBlobs(root, files.filter((f) => f.now).map((f) => f.path), true);
  const empty = await git(root, ["hash-object", "-w", "--stdin"], undefined, "");
  let out = "";
  for (const f of files) {
    const blob = (v: string | null | undefined) => (v ? v.split(" ").pop()! : empty);
    const a = blob(f.now ? written.get(f.path) : null);
    const b = blob(f.to);
    const body = (await gitTry(root, ["diff", "--no-color", a, b])) ?? "";
    const hunks = body.slice(Math.max(0, body.indexOf("\n@@") + 1));
    out += `diff ${f.path}\n--- ${f.now ? `a/${f.path}` : "/dev/null"}\n+++ ${f.to ? `b/${f.path}` : "/dev/null"}\n${body.includes("@@") ? hunks : body.includes("Binary") ? "Binary file\n" : ""}\n`;
    if (out.length > DIFF_CAP) return { diff: out.slice(0, DIFF_CAP), truncated: true };
  }
  return { diff: out, truncated: false };
}
