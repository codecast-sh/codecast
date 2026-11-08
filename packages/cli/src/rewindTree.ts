/**
 * Rewind a checkout's files to how they stood just before a turn, in place,
 * with a way to put everything back.
 *
 * Built on the turn snapshots (treeSnapshot.ts): the daemon commits the
 * working tree at every turn end, and treeSnapshots rows say which of those
 * commits close which session's turns. Each row's snapshot is one link in the
 * checkout's chain: from the snapshot before it (`prev_sha`) to its own tree.
 * The links of the session's rows after the chosen message are what this turn
 * and the later ones changed. A link of another session that shares the
 * checkout is not one of them, so its changes are left alone.
 *
 * For each path a link touched, the restore source is the tree that started
 * the FIRST of those links (the file as it stood before the session first
 * changed it), and the version the session left is the tree that ended the
 * LAST one. A path whose working copy differs from what the session left was
 * changed since by someone else (a person, another session, a formatter), and
 * staging refuses unless the person chooses to overwrite it.
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
import { snapshotStateDir } from "./treeSnapshot.js";
import { ensureSnapshotLocal, snapshotMoment, type TurnSnapshotRow } from "./turns.js";
import { SNAPSHOT_IDENTITY, defaultRemote, git, gitTry } from "./wipSnapshot.js";

export type RewindRow = Pick<TurnSnapshotRow, "sha" | "base_sha" | "prev_sha" | "taken_at" | "turn_completed_at" | "shared_sessions">;

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
  /** Most other sessions any of those snapshots' checkout was shared with. */
  shared: number;
  /** HEAD moved since the message: commits made since are kept, only files move. */
  head_moved: boolean;
  /** Files those snapshots changed in a shared checkout that the session's own edits do not name: left alone. */
  left_alone: number;
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
  constructor(message: string, readonly paths: string[] = []) {
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

/** The session's snapshot links after `at`, oldest first: [from, to] commit pairs. */
export function linksAfter(rows: RewindRow[], at: number): Array<{ from: string; to: string; shared: number }> {
  const sorted = [...rows].sort((a, b) => snapshotMoment(a) - snapshotMoment(b));
  const out: Array<{ from: string; to: string; shared: number }> = [];
  const seen = new Set<string>();
  let prevOurs: RewindRow | undefined;
  for (const row of sorted) {
    if (snapshotMoment(row) > at && !seen.has(row.sha)) {
      // A chain that restarted (treeSnapshot CHAIN_DEPTH_CAP) names no previous
      // snapshot; the session's own previous one is the nearest known tree.
      const from = row.prev_sha ?? prevOurs?.sha ?? row.base_sha;
      if (from !== row.sha) out.push({ from, to: row.sha, shared: row.shared_sessions ?? 0 });
      seen.add(row.sha);
    }
    prevOurs = row;
  }
  return out;
}

/** Blob ids of `paths` in a commit's tree; gitlinks (submodules) are reported as "gitlink". */
async function blobsIn(root: string, commit: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunks(paths)) {
    const raw = (await gitTry(root, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...part], LITERAL)) ?? "";
    for (const entry of raw.split("\0").filter(Boolean)) {
      const tab = entry.indexOf("\t");
      const [mode, , sha] = entry.slice(0, tab).split(" ");
      out.set(entry.slice(tab + 1), mode === "160000" ? "gitlink" : sha);
    }
  }
  return out;
}

/** Blob ids of the working copies of `paths` as git would store them; absent paths are left out. */
async function workingBlobs(root: string, paths: string[], write = false): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const files: string[] = [];
  for (const p of paths) {
    let st: fs.Stats;
    try { st = fs.lstatSync(path.join(root, p)); } catch { continue; }
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(path.join(root, p));
      out.set(p, await git(root, ["hash-object", ...(write ? ["-w"] : []), "--stdin"], undefined, target));
    } else if (st.isFile()) {
      files.push(p);
    } else if (st.isDirectory()) {
      out.set(p, "directory");
    }
  }
  for (const part of chunks(files)) {
    const shas = (await git(root, ["hash-object", ...(write ? ["-w"] : []), "--stdin-paths"], undefined, part.join("\n") + "\n")).split("\n");
    part.forEach((p, i) => out.set(p, shas[i]));
  }
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
   * root-relative). A snapshot taken while other sessions shared the checkout
   * holds their changes too, so only these of its paths count; null when
   * unknown, which counts none of them: a rewind leaves a file alone rather
   * than guess it was this session's.
   */
  edited: string[] | null = null,
): Promise<RewindPlan> {
  const links = linksAfter(rows, at);
  const remote = links.length ? await defaultRemote(root) : null;
  for (const sha of new Set(links.flatMap((l) => [l.from, l.to]))) {
    if (!(await ensureSnapshotLocal(root, sha, conversationId, remote))) {
      throw new RewindRefused(`snapshot ${sha.slice(0, 10)} is not in this checkout and could not be fetched`);
    }
  }
  const first = new Map<string, string>(); // path -> tree it goes back to
  const last = new Map<string, string>(); // path -> tree the session left it in
  const ours = new Set((edited ?? []).map((p) => (path.isAbsolute(p) ? path.relative(root, p) : p)).filter((p) => p && !p.startsWith("..")));
  const others = new Set<string>();
  for (const link of links) {
    const raw = (await gitTry(root, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", `${link.from}^{tree}`, `${link.to}^{tree}`])) ?? "";
    for (const p of raw.split("\0").filter(Boolean)) {
      if (link.shared > 0 && !ours.has(p)) {
        others.add(p);
        continue;
      }
      if (!first.has(p)) first.set(p, link.from);
      last.set(p, link.to);
    }
  }
  const paths = [...first.keys()].sort();
  const bySource = new Map<string, string[]>();
  for (const p of paths) bySource.set(first.get(p)!, [...(bySource.get(first.get(p)!) ?? []), p]);
  const byLeft = new Map<string, string[]>();
  for (const p of paths) byLeft.set(last.get(p)!, [...(byLeft.get(last.get(p)!) ?? []), p]);
  const source = new Map<string, string>();
  for (const [sha, ps] of bySource) for (const [p, b] of await blobsIn(root, sha, ps)) source.set(p, b);
  const left = new Map<string, string>();
  for (const [sha, ps] of byLeft) for (const [p, b] of await blobsIn(root, sha, ps)) left.set(p, b);
  const now = await workingBlobs(root, paths);

  const files: RewindFile[] = [];
  for (const p of paths) {
    const to = source.get(p) ?? null;
    const cur = now.get(p) ?? null;
    // A submodule pointer or a path that is a directory now is not a file the rewind can write.
    if (to === "gitlink" || left.get(p) === "gitlink" || cur === "directory") continue;
    if (to === cur) continue; // already as it was
    files.push({
      path: p,
      action: to === null ? "delete" : cur === null ? "recreate" : "restore",
      conflict: cur !== (left.get(p) ?? null),
      to,
      now: cur,
      source: first.get(p)!,
    });
  }
  const head = await gitTry(root, ["rev-parse", "--verify", "HEAD"]);
  const before = [...rows].sort((a, b) => snapshotMoment(a) - snapshotMoment(b)).filter((r) => snapshotMoment(r) <= at).pop();
  const startBase = before?.base_sha ?? rows.find((r) => snapshotMoment(r) > at)?.base_sha;
  return {
    root,
    conversation_id: conversationId,
    at,
    files,
    turns: links.length,
    shared: Math.max(0, ...links.map((l) => l.shared)),
    head_moved: !!head && !!startBase && head !== startBase,
    left_alone: [...others].filter((p) => !first.has(p)).length,
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

/** Write `blob`-bearing paths from `commit` into the working tree, or delete paths whose blob is null. */
async function writePaths(root: string, commit: string, items: Array<{ path: string; blob: string | null }>): Promise<void> {
  const writes = items.filter((i) => i.blob !== null).map((i) => i.path);
  for (const part of chunks(writes)) {
    // A file the session turned into a directory (or back) must be cleared first.
    for (const p of part) {
      try { if (fs.lstatSync(path.join(root, p)).isDirectory()) fs.rmSync(path.join(root, p), { recursive: true, force: true }); } catch {}
    }
    await git(root, ["restore", `--source=${commit}`, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], LITERAL, part.join("\0"));
  }
  for (const i of items) {
    if (i.blob !== null) continue;
    const abs = path.join(root, i.path);
    try { fs.rmSync(abs, { force: true }); } catch {}
    // Leave no empty directory behind the files the turn created.
    for (let dir = path.dirname(abs); dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
      try { fs.rmdirSync(dir); } catch { break; }
    }
  }
}

/**
 * Stage `plan`: back up the current versions of its paths, then rewind them.
 * `fingerprint` is the plan the person reviewed; a tree that moved since is
 * refused. Conflicts are refused unless `overwrite`.
 */
export async function stageRewind(plan: RewindPlan, opts: { fingerprint: string; overwrite?: boolean }): Promise<StagedRewind> {
  const root = plan.root;
  const open = await readStaged(root);
  if (open) throw new RewindRefused("a rewind is already staged in this checkout: put it back or keep it first");
  if (plan.fingerprint !== opts.fingerprint) throw new RewindRefused("the files changed since the review: look again");
  if (!plan.files.length) throw new RewindRefused("nothing to rewind: the files are already as they were");
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

  const bySource = new Map<string, RewindFile[]>();
  for (const f of plan.files) bySource.set(f.source, [...(bySource.get(f.source) ?? []), f]);
  for (const [source, fs_] of bySource) await writePaths(root, source, fs_.map((f) => ({ path: f.path, blob: f.to })));
  return staged;
}

/**
 * Put the staged rewind back: every path returns to the version the backup
 * holds. A path edited after the rewind (the fork's agent, a person) is
 * refused unless `force`, since putting back would discard that edit.
 */
export async function putBackRewind(root: string, opts: { force?: boolean } = {}): Promise<{ staged: StagedRewind; restored: number }> {
  const staged = await readStaged(root);
  if (!staged) throw new RewindRefused("no rewind is staged in this checkout");
  const now = await workingBlobs(root, staged.files.map((f) => f.path));
  const edited = staged.files.filter((f) => (now.get(f.path) ?? null) !== f.to).map((f) => f.path);
  if (edited.length && !opts.force) throw new RewindRefused(`${edited.length} file${edited.length === 1 ? " was" : "s were"} edited after the rewind`, edited);
  await writePaths(root, staged.backup, staged.files.map((f) => ({ path: f.path, blob: f.was })));
  await clearStaged(root, staged);
  return { staged, restored: staged.files.length };
}

/** Keep the rewound files and drop the backup. */
export async function keepRewind(root: string): Promise<StagedRewind> {
  const staged = await readStaged(root);
  if (!staged) throw new RewindRefused("no rewind is staged in this checkout");
  await clearStaged(root, staged);
  return staged;
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
    const a = f.now ? written.get(f.path) ?? empty : empty;
    const b = f.to ?? empty;
    const body = (await gitTry(root, ["diff", "--no-color", a, b])) ?? "";
    const hunks = body.slice(Math.max(0, body.indexOf("\n@@") + 1));
    out += `diff ${f.path}\n--- ${f.now ? `a/${f.path}` : "/dev/null"}\n+++ ${f.to ? `b/${f.path}` : "/dev/null"}\n${body.includes("@@") ? hunks : body.includes("Binary") ? "Binary file\n" : ""}\n`;
    if (out.length > DIFF_CAP) return { diff: out.slice(0, DIFF_CAP), truncated: true };
  }
  return { diff: out, truncated: false };
}
