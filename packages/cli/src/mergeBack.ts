/**
 * Bring an isolated worker's changes into its parent's checkout.
 *
 * The worker's own change is what `cast land` calls a tree's work: the diff
 * from the commit its worktree was cut at to its working state, untracked
 * files included (land/scan.ts worktreeBase, withWorkingIndex). Each changed
 * file is then judged against the PARENT's working copy rather than main:
 *
 *   same   the parent already holds the worker's version: nothing to do
 *   only   the parent has not touched the file since the cut: take the worker's
 *   both   both changed it: a three-way `git merge-file` against the cut, taken
 *          when it is clean
 *
 * All or nothing: one file that does not merge cleanly (overlapping lines, a
 * binary file both sides changed, a delete against an edit) and nothing is
 * written; the caller reports the conflicting files and the worktree keeps the
 * work. The parent's own uncommitted edits are never overwritten, only merged
 * with. Nothing is committed: the change lands in the parent's working tree
 * the way a person's edits would.
 *
 * After a merge, `refs/codecast/merged/<worktree>` records the worker's tree as
 * merged, so a later done from the same worker brings only what is new since,
 * and the worktree GC can tell a worktree whose every change is now in its
 * parent (worktreeMatchesMergedBack) and release it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileAsync, spawn } from "./proc.js";
import { fileVerdict, parseRawDiff, readBlobs, withWorkingIndex, worktreeBase } from "./land/scan.js";

export type MergeBackResult =
  | { state: "merged"; files: string[] }
  | { state: "empty"; files: [] }
  | { state: "conflict"; files: string[] }
  | { state: "failed"; files: []; reason: string };

const ZERO = /^0+$/;
export const MERGED_REF_PREFIX = "refs/codecast/merged/";
export const mergedBackRef = (worktreePath: string) => `${MERGED_REF_PREFIX}${path.basename(worktreePath)}`;

async function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; buffer?: boolean } = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    timeout: 120_000,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
  });
  return String(stdout).trim();
}

const tryGit = (cwd: string, args: string[]) => git(cwd, args).catch(() => "");

/** Run git with stdin, resolving its stdout (bytes); rejects on a non-zero exit. */
function gitWithInput(cwd: string, args: string[], input: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on("data", (c: Buffer) => out.push(c));
    child.stderr!.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(Buffer.concat(err).toString().trim() || `git ${args[0]} exited ${code}`)));
    child.stdin!.end(input);
  });
}

/** The blob each existing path holds in `root`'s working copy, written to the shared object store. */
async function workingBlobs(root: string, paths: string[]): Promise<Map<string, string>> {
  const present = paths.filter((p) => {
    try { return fs.lstatSync(path.join(root, p)).isFile(); } catch { return false; }
  });
  const out = new Map<string, string>();
  if (present.length === 0) return out;
  const shas = (await gitWithInput(root, ["hash-object", "-w", "--stdin-paths"], present.join("\n") + "\n")).toString().trim().split("\n");
  present.forEach((p, i) => out.set(p, shas[i]));
  return out;
}

/** Three-way merge of text: the merged content, or null when the sides overlap. */
async function mergeText(current: string, base: string, theirs: string): Promise<string | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-merge-back-"));
  try {
    const [c, b, t] = ["current", "base", "theirs"].map((n) => path.join(dir, n));
    fs.writeFileSync(c, current);
    fs.writeFileSync(b, base);
    fs.writeFileSync(t, theirs);
    const { stdout } = await execFileAsync("git", ["merge-file", "-p", c, b, t], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
    return String(stdout);
  } catch {
    // merge-file exits with the number of conflicts (or <0 on error).
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

type Write =
  | { path: string; kind: "blob"; sha: string; mode: string }
  | { path: string; kind: "text"; text: string; mode: string }
  | { path: string; kind: "delete" };

export async function mergeBack(worktreePath: string, targetPath: string): Promise<MergeBackResult> {
  const fail = (reason: string): MergeBackResult => ({ state: "failed", files: [], reason });
  if (!fs.existsSync(worktreePath)) return fail(`the worktree ${worktreePath} is gone`);
  const worktree = await tryGit(worktreePath, ["rev-parse", "--show-toplevel"]);
  const target = await tryGit(targetPath, ["rev-parse", "--show-toplevel"]);
  if (!worktree) return fail(`${worktreePath} is not a git checkout`);
  if (!target) return fail(`the parent's checkout ${targetPath} is not a git checkout`);
  if (fs.realpathSync(worktree) === fs.realpathSync(target)) return fail("the worker ran in the parent's own checkout");
  const common = async (p: string) => fs.realpathSync(path.resolve(p, await git(p, ["rev-parse", "--git-common-dir"])));
  if ((await common(worktree)) !== (await common(target))) return fail("the worktree belongs to another repository than the parent's checkout");

  // Measured from the last merge back when there was one, else from the cut.
  const ref = mergedBackRef(worktree);
  const merged = await tryGit(worktree, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const branch = await tryGit(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const base = merged || await worktreeBase({ path: worktree, branch: branch === "HEAD" ? "" : branch, head: "", locked: false, primary: false }, "HEAD");
  if (!base) return fail("cannot tell which commit the worktree was cut from");

  const { rows, tree } = await withWorkingIndex(worktree, async (env) => ({
    rows: parseRawDiff(await git(worktree, ["diff", "--cached", "--raw", "--no-renames", "--no-abbrev", base], { env })),
    tree: await git(worktree, ["write-tree"], { env }),
  }));
  if (rows.length === 0) return { state: "empty", files: [] };

  const current = await workingBlobs(target, rows.map((r) => r.path));
  const writes: Write[] = [];
  const conflicts: string[] = [];
  const contested: typeof rows = [];
  for (const r of rows) {
    const verdict = fileVerdict(r.src, r.dst, current.get(r.path));
    if (verdict === "same") continue;
    if (verdict === "only") {
      writes.push(ZERO.test(r.dst) ? { path: r.path, kind: "delete" } : { path: r.path, kind: "blob", sha: r.dst, mode: r.mode });
      continue;
    }
    // Both sides changed it. Only an edit against an edit can merge; an add
    // against an add, or a delete against an edit, takes a person.
    if (ZERO.test(r.src) || ZERO.test(r.dst) || !current.has(r.path)) conflicts.push(r.path);
    else contested.push(r);
  }
  const blobs = await readBlobs(worktree, contested.flatMap((r) => [r.src, r.dst, current.get(r.path)!]));
  for (const r of contested) {
    const [b, t, c] = [blobs.get(r.src), blobs.get(r.dst), blobs.get(current.get(r.path)!)];
    // A binary or oversized blob has no text to merge.
    const text = b !== undefined && t !== undefined && c !== undefined ? await mergeText(c, b, t) : null;
    if (text === null) conflicts.push(r.path);
    else writes.push({ path: r.path, kind: "text", text, mode: r.mode });
  }
  if (conflicts.length) return { state: "conflict", files: conflicts.sort() };

  for (const w of writes) {
    const dest = path.join(target, w.path);
    if (w.kind === "delete") {
      fs.rmSync(dest, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (w.kind === "blob" && w.mode === "120000") {
      fs.rmSync(dest, { force: true });
      fs.symlinkSync(await git(worktree, ["cat-file", "blob", w.sha]), dest);
      continue;
    }
    const body = w.kind === "text" ? w.text : await blobBytes(worktree, w.sha);
    fs.writeFileSync(dest, body);
    if (w.mode === "100755") fs.chmodSync(dest, 0o755);
  }

  // Record the tree just merged, so the next merge starts from here.
  const ident = { GIT_AUTHOR_NAME: "codecast", GIT_AUTHOR_EMAIL: "merge-back@codecast.sh", GIT_COMMITTER_NAME: "codecast", GIT_COMMITTER_EMAIL: "merge-back@codecast.sh" };
  const commit = await git(worktree, ["commit-tree", tree, "-m", `merge back ${path.basename(worktree)}`], { env: ident });
  await git(worktree, ["update-ref", ref, commit]);
  return writes.length ? { state: "merged", files: writes.map((w) => w.path).sort() } : { state: "empty", files: [] };
}

async function blobBytes(cwd: string, sha: string): Promise<Buffer> {
  return gitWithInput(cwd, ["cat-file", "blob", sha], "");
}

/** True when the worktree holds nothing beyond what it last merged into its parent. */
export async function worktreeMatchesMergedBack(worktreePath: string): Promise<boolean> {
  const merged = await tryGit(worktreePath, ["rev-parse", "--verify", "--quiet", `${mergedBackRef(worktreePath)}^{tree}`]);
  if (!merged) return false;
  const tree = await withWorkingIndex(worktreePath, (env) => git(worktreePath, ["write-tree"], { env })).catch(() => "");
  return tree === merged;
}
