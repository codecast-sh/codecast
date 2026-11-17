// What a change touches, for `cast decisions --touching`: the paths it changes
// and the conversations that wrote the lines it changes. The second half reads
// the base side of the diff through `git blame` and follows each blamed
// commit's Codecast-Session trailer back to its conversation, so a decision
// made in that conversation is found even when it named no files.

import { execFileSync } from "node:child_process";

export type ChangeEvidence = {
  root: string;
  gitRemote: string | null;
  files: string[];
  conversationIds: string[];
};

/** Old-side line spans per file from a `git diff -U0` patch. A pure insertion
 *  (count 0) spans the line it was inserted after, which places it inside the
 *  code it extends. */
export function parseOldSpans(patch: string): Map<string, Array<[number, number]>> {
  const spans = new Map<string, Array<[number, number]>>();
  let file: string | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("--- ")) {
      file = line === "--- /dev/null" ? null : line.slice(4).replace(/^a\//, "");
      continue;
    }
    const m = file && line.match(/^@@ -(\d+)(?:,(\d+))? \+/);
    if (!m || !file) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    const span: [number, number] = count === 0 ? [start, start] : [start, start + count - 1];
    if (span[0] < 1) continue;
    if (!spans.has(file)) spans.set(file, []);
    spans.get(file)!.push(span);
  }
  return spans;
}

/** Conversation ids from Codecast-Session trailer values (a conversation URL). */
export function conversationIdsFromTrailers(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\/conversation\/([a-z0-9]{20,})/g)) ids.add(m[1]);
  return [...ids];
}

/** The base the old side of a range reads from: "a...b" is their merge base,
 *  "a..b" is a, a single ref is that ref, and no range is HEAD (the working tree's change). */
function baseOf(git: (args: string[]) => string, range: string | undefined): { base: string; diffArgs: string[] } {
  if (!range) return { base: "HEAD", diffArgs: ["HEAD"] };
  const three = range.split("...");
  if (three.length === 2) return { base: git(["merge-base", three[0] || "HEAD", three[1] || "HEAD"]).trim(), diffArgs: [range] };
  const two = range.split("..");
  if (two.length === 2) return { base: two[0] || "HEAD", diffArgs: [range] };
  return { base: range, diffArgs: [range] };
}

const gitIn = (dir: string) => (args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });

/** The repository a directory sits in: its root and origin remote; null outside one. */
export function gitRepoContext(cwd: string): { root: string; gitRemote: string | null } | null {
  let root: string;
  try { root = gitIn(cwd)(["rev-parse", "--show-toplevel"]).trim(); } catch { return null; }
  let gitRemote: string | null = null;
  try { gitRemote = gitIn(root)(["remote", "get-url", "origin"]).trim() || null; } catch {}
  return { root, gitRemote };
}

export function changeEvidence(cwd: string, range?: string): ChangeEvidence {
  const repo = gitRepoContext(cwd);
  if (!repo) throw new Error("not inside a git repository");
  const { root, gitRemote } = repo;
  const git = gitIn(root);

  const { base, diffArgs } = baseOf(git, range);
  // Uncommitted work includes files not yet added, which `git diff` leaves out.
  const untracked = range ? "" : git(["ls-files", "--others", "--exclude-standard"]);
  const files = [...new Set(`${git(["diff", "--name-only", ...diffArgs])}\n${untracked}`.split("\n").filter(Boolean))];
  const spans = parseOldSpans(git(["diff", "-U0", "--no-color", "--no-ext-diff", ...diffArgs]));

  const shas = new Set<string>();
  for (const [file, ranges] of spans) {
    const args = ["blame", "--porcelain", ...ranges.flatMap(([a, b]) => ["-L", `${a},${b}`]), base, "--", file];
    let out = "";
    try { out = git(args); } catch { continue; }
    for (const m of out.matchAll(/^([0-9a-f]{40}) \d+ \d+/gm)) if (!/^0+$/.test(m[1])) shas.add(m[1]);
  }
  let trailers = "";
  if (shas.size) {
    try { trailers = git(["log", "--no-walk", "--format=%(trailers:key=Codecast-Session,valueonly)", ...shas]); } catch {}
  }
  return { root, gitRemote, files, conversationIds: conversationIdsFromTrailers(trailers) };
}
