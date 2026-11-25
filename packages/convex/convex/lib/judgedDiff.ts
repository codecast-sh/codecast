// The judged diff and its key: what a person's approval of a change is bound to (ct-100350, sd-4635). The key is
// `git patch-id --stable` of the diff of the judged files alone,
//
//   git diff --no-renames <merge-base(main, head)> <head> -- <judged paths> | git patch-id --stable
//
// so it ignores line numbers, hunk positions and whitespace: a rebase over unrelated work on main keeps it, and any
// change to what a judged file's diff says asks again. Union's bash computes it from git itself; the server rebuilds
// the same diff from GitHub's per-file patches (changeApprovals.ts) and hashes it with the port of git's algorithm
// below. judgedDiff.vectors.json holds cases cut by real `git patch-id --stable` (scripts/judgedDiffVectors.ts).
//
// A judges file lists one entry a line, as Union's gate.sh reads it: the exact path; a directory written with its
// trailing "/", which covers everything under it; or `name#key` (`package.json#scripts`), which covers any file named
// `name` whose top-level JSON `key` changed between the merge base and the head (missing reads null; a file that does
// not parse counts as changed). Blank lines and lines starting with "#" say nothing; lines are trimmed. A `name#key`
// hit puts the whole file's diff in the key.

/** The key of a diff with no judged path in it: git patch-id prints nothing for an empty diff. */
export const NO_JUDGED_PATHS = "none";

/** The entries of a judges file: each line a path or a "dir/" prefix, minus blanks and comments. */
export function parseJudges(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
}

/** Whether a path entry covers `path`: the exact path, or a listed "dir/" it sits under. `name#key` entries read content. */
export function isJudged(path: string, entries: ReadonlyArray<string>): boolean {
  return entries.some((entry) => !entry.includes("#") && (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

/** The `name#key` entries: a file name and the top-level JSON key whose change makes such a file judged. */
export function keyEntries(entries: ReadonlyArray<string>): Array<{ name: string; key: string }> {
  return entries.filter((e) => e.includes("#")).map((e) => ({ name: e.slice(0, e.indexOf("#")), key: e.slice(e.indexOf("#") + 1) }));
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The `name#key` entries a path's name falls under: its content decides whether it is judged. */
export const keyEntriesFor = (path: string, entries: ReadonlyArray<string>) => keyEntries(entries).filter((k) => k.name === basename(path));

/** Whether a path may be judged: a path entry covers it, or it carries a `name#key` entry's name. What Ship lists. */
export const mayBeJudged = (path: string, entries: ReadonlyArray<string>) => isJudged(path, entries) || keyEntriesFor(path, entries).length > 0;

/** gate.sh's read of one side: JSON.stringify(JSON.parse(text)[key] ?? null), null for an absent or empty file. */
function keyValue(text: string | null, key: string): string {
  return JSON.stringify(text && text.trim() ? JSON.parse(text)[key] ?? null : null);
}

/** Whether `key` reads differently on the two sides (null: the file is absent there). One that does not parse is a hit. */
export function keyChanged(base: string | null, head: string | null, key: string): boolean {
  try {
    return keyValue(base, key) !== keyValue(head, key);
  } catch {
    return true;
  }
}

/** Bytewise (UTF-8) order, as git sorts paths; JavaScript's `<` compares UTF-16 units and disagrees past U+FFFF. */
export function compareBytes(a: string, b: string): number {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/**
 * J: the changed paths the judges cover, once each, in git's order. A rename names both of its paths. `keyHits` are
 * the paths a `name#key` entry judged from their content (the caller read both sides; keyChanged).
 */
export function judgedPaths(changed: Iterable<string>, entries: ReadonlyArray<string>, keyHits: Iterable<string> = []): string[] {
  const hits = new Set(keyHits);
  return [...new Set([...changed].filter((path) => isJudged(path, entries) || hits.has(path)))].sort(compareBytes);
}

/** The owners map kept beside the judges file: `path-prefix  person` a line, blank and "#" lines skipped. */
export function parseOwners(text: string): Array<{ prefix: string; person: string }> {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).flatMap((l) => {
    const m = /^(\S+)\s+(.+)$/.exec(l);
    return m ? [{ prefix: m[1], person: m[2].trim() }] : [];
  });
}

/** The person owning the area of these paths: the longest owners prefix that covers one of them, else null. */
export function ownerOf(paths: ReadonlyArray<string>, owners: ReadonlyArray<{ prefix: string; person: string }>): string | null {
  let best: { prefix: string; person: string } | null = null;
  for (const o of owners) if (paths.some((p) => p.startsWith(o.prefix)) && (!best || o.prefix.length > best.prefix.length)) best = o;
  return best?.person ?? null;
}

/** The person a commit names as asking for the work (`Requested-by: <name>`), the newest commit's first. */
export function requestedBy(messages: ReadonlyArray<string>): string | null {
  for (const m of [...messages].reverse()) {
    const hit = /^Requested-by:\s*(.+?)\s*$/m.exec(m);
    if (hit) return hit[1];
  }
  return null;
}

// ── git patch-id --stable ──

async function sha1(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes as Uint8Array<ArrayBuffer>));
}

/** git's remove_space: every isspace() byte goes (space, \t, \n, \v, \f, \r). */
const removeSpace = (line: string) => line.replace(/[ \t\n\v\f\r]/g, "");

/** git's scan_hunk_header: the line counts of "@@ -a[,b] +c[,d] @@", each 1 when left out. */
function hunkCounts(line: string): [number, number] | null {
  const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
  return m ? [m[1] === undefined ? 1 : Number(m[1]), m[2] === undefined ? 1 : Number(m[2])] : null;
}

/**
 * `git patch-id --stable` of one diff (builtin/patch-id.c get_one_patchid, stable, not verbatim): each file's lines
 * are hashed with whitespace removed, its `index` line, hunk headers and "\ No newline" lines left out, and the
 * files' SHA-1s are summed bytewise with carry, so their order does not matter. A binary file's patch would hash
 * its abbreviated blob ids, which nothing here can match, so callers never feed one. Null for an empty diff.
 */
export async function patchIdStable(diff: string): Promise<string | null> {
  const result = new Uint8Array(20);
  let chunk: string[] = [];
  let any = false;
  const flush = async () => {
    const hash = await sha1(new TextEncoder().encode(chunk.join("")));
    chunk = [];
    let carry = 0;
    for (let i = 0; i < 20; i++) {
      carry += result[i] + hash[i];
      result[i] = carry & 0xff;
      carry >>= 8;
    }
  };
  let before = -1, after = -1, patchlen = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("\\ ") && line.length + 1 > 12) continue;
    if (!patchlen && !line.startsWith("diff ")) continue;
    if (before === -1) {
      if (line.startsWith("index ")) continue;
      if (line.startsWith("--- ")) before = after = 1;
      else if (!/^[A-Za-z]/.test(line)) break;
    }
    if (before === 0 && after === 0) {
      const counts = line.startsWith("@@ -") ? hunkCounts(line) : null;
      if (counts) { [before, after] = counts; continue; }
      if (!line.startsWith("diff ")) break;
      await flush();
      before = after = -1;
    }
    if (line[0] === "-" || line[0] === " ") before--;
    if (line[0] === "+" || line[0] === " ") after--;
    const kept = removeSpace(line);
    patchlen += kept.length;
    chunk.push(kept);
    any = true;
  }
  if (!any) return null;
  await flush();
  return Array.from(result, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── One path's diff, rebuilt from what GitHub says about it ──

/**
 * One path of a `--no-renames` diff. `base_mode` null: the path is added; `head_mode` null: deleted. `hunks` is the
 * diff body from its first "@@" line (GitHub's `patch` field), "" when there is none (an empty file, a mode change).
 */
export type PathDiff = { path: string; base_mode: string | null; head_mode: string | null; hunks: string };

/** The text `git diff --no-renames` prints for one path, minus its `index` line, which patch-id skips. */
export function gitDiffText(d: PathDiff): string {
  const lines = [`diff --git a/${d.path} b/${d.path}`];
  if (d.base_mode === null && d.head_mode !== null) lines.push(`new file mode ${d.head_mode}`);
  else if (d.head_mode === null && d.base_mode !== null) lines.push(`deleted file mode ${d.base_mode}`);
  else if (d.base_mode !== d.head_mode) lines.push(`old mode ${d.base_mode}`, `new mode ${d.head_mode}`);
  if (d.hunks) {
    lines.push(d.base_mode === null ? "--- /dev/null" : `--- a/${d.path}`, d.head_mode === null ? "+++ /dev/null" : `+++ b/${d.path}`);
    lines.push(d.hunks.replace(/\n$/, ""));
  }
  return lines.join("\n") + "\n";
}

/** The hunk a whole file makes when it is added (`side` "+") or deleted ("-"): what a rename is under --no-renames. */
export function wholeFileHunk(text: string, side: "+" | "-"): string {
  if (text === "") return "";
  const lines = text.split("\n");
  const noNewline = !text.endsWith("\n");
  if (!noNewline) lines.pop();
  const n = lines.length;
  const header = side === "+" ? `@@ -0,0 +1,${n} @@` : `@@ -1,${n} +0,0 @@`;
  return [header, ...lines.map((l) => side + l), ...(noNewline ? ["\\ No newline at end of file"] : [])].join("\n");
}

/**
 * The diff that undoes `d`: sides and modes swapped, each hunk's counts swapped and its "+" and "-" lines flipped. In a
 * run of changed lines git prints the removals first, so the flipped run is put back in that order, as `git diff -R`
 * prints it.
 */
export function invertPathDiff(d: PathDiff): PathDiff {
  const out: string[] = [];
  let removed: string[] = [], added: string[] = [];
  const endRun = () => { out.push(...removed, ...added); removed = []; added = []; };
  for (const line of d.hunks ? d.hunks.split("\n") : []) {
    const m = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@(.*)$/.exec(line);
    if (line.startsWith("+")) removed.push("-" + line.slice(1));
    else if (line.startsWith("-")) added.push("+" + line.slice(1));
    else if (line.startsWith("\\ ")) (added.length ? added : removed).push(line);
    else { endRun(); out.push(m ? `@@ -${m[2]} +${m[1]} @@${m[3]}` : line); }
  }
  endRun();
  return { path: d.path, base_mode: d.head_mode, head_mode: d.base_mode, hunks: out.join("\n") };
}

/** The blob of an empty file: an added or deleted empty file has no patch and needs none. */
export const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

/**
 * One file as GitHub's pull request (or commit) files API lists it, with what the server read beside it: each side's
 * mode, and for a rename both texts (null when unreadable: binary, too large). `base_*` is the merge base's (or a
 * commit's parent's), `head_*` the head's; a rename's base is its previous_filename.
 */
export type GitHubFile = {
  filename: string;
  status: string;
  previous_filename?: string;
  patch?: string;
  sha?: string;
  additions?: number;
  deletions?: number;
  base_mode: string | null;
  head_mode: string | null;
  base_text?: string | null;
  head_text?: string | null;
};

/** The paths GitHub's entry stands for under --no-renames: a rename is its old path and its new one. */
export const pathsOf = (f: Pick<GitHubFile, "filename" | "previous_filename">): string[] => (f.previous_filename ? [f.previous_filename, f.filename] : [f.filename]);

/**
 * The --no-renames diff of the paths `keep` selects, rebuilt from GitHub's entries, or the first path whose diff
 * cannot be rebuilt exactly (a patch GitHub left out: binary, too large; a mode or a rename's text not read). An
 * entry the server cannot rebuild exactly is never guessed at, since a guessed key would carry an approval wrongly.
 */
export function pathDiffsOf(files: ReadonlyArray<GitHubFile>, keep: (path: string) => boolean): { diffs: PathDiff[] } | { unreadable: string } {
  const diffs: PathDiff[] = [];
  for (const f of files) {
    if (f.status === "unchanged") continue;
    if (f.status === "renamed" && f.previous_filename) {
      if (keep(f.previous_filename)) {
        if (typeof f.base_text !== "string" || !f.base_mode) return { unreadable: f.previous_filename };
        diffs.push({ path: f.previous_filename, base_mode: f.base_mode, head_mode: null, hunks: wholeFileHunk(f.base_text, "-") });
      }
      if (keep(f.filename)) {
        if (typeof f.head_text !== "string" || !f.head_mode) return { unreadable: f.filename };
        diffs.push({ path: f.filename, base_mode: null, head_mode: f.head_mode, hunks: wholeFileHunk(f.head_text, "+") });
      }
      continue;
    }
    if (!keep(f.filename)) continue;
    const empty = !f.additions && !f.deletions;
    if (f.status === "added") {
      if (!f.head_mode || (f.patch === undefined && f.sha !== EMPTY_BLOB)) return { unreadable: f.filename };
      diffs.push({ path: f.filename, base_mode: null, head_mode: f.head_mode, hunks: f.patch ?? "" });
    } else if (f.status === "removed") {
      if (!f.base_mode || (f.patch === undefined && !(empty && f.sha === EMPTY_BLOB))) return { unreadable: f.filename };
      diffs.push({ path: f.filename, base_mode: f.base_mode, head_mode: null, hunks: f.patch ?? "" });
    } else if (f.status === "modified" || f.status === "changed") {
      if (!f.base_mode || !f.head_mode) return { unreadable: f.filename };
      // No patch is a mode change only when the modes differ and no line moved; otherwise binary or too large.
      if (f.patch === undefined && !(empty && f.base_mode !== f.head_mode)) return { unreadable: f.filename };
      diffs.push({ path: f.filename, base_mode: f.base_mode, head_mode: f.head_mode, hunks: f.patch ?? "" });
    } else {
      return { unreadable: f.filename };
    }
  }
  return { diffs };
}

/** patch-id --stable of several paths' diffs, or "none" when there are none. */
export async function diffKey(diffs: ReadonlyArray<PathDiff>): Promise<string> {
  if (!diffs.length) return NO_JUDGED_PATHS;
  const sorted = [...diffs].sort((a, b) => compareBytes(a.path, b.path));
  return (await patchIdStable(sorted.map(gitDiffText).join(""))) ?? NO_JUDGED_PATHS;
}

/** The commits a message says it reverts: git's own `This reverts commit <sha>` line, full shas only. */
export function revertedShas(message: string): string[] {
  return [...message.matchAll(/^This reverts commit ([0-9a-f]{40})\b/gm)].map((m) => m[1]);
}
