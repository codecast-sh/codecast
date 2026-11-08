// What the blind risk judge reads (templates/judge.cast): a change's diff and
// the repository's own guidelines, with every sign of who made it removed.
//
// The judge scores the change the same way whoever wrote it, so nothing that
// names an author reaches it: no commit messages or trailers, no branch, no
// session, run or person. A diff carries none of those by itself except in its
// headers (`index <sha>..<sha>`, which a reader could look up) and in the
// lines it adds; the headers are dropped, and the lines lose the range's
// author names and emails, any id the flow names (`--redact`), and the trailer
// lines agents and tools sign their work with.
//
// Each part prints as one JSON object a station records whole (commandStation
// NODE_JSON_CAP), so the text is fitted under that cap: every file stays named
// with its line counts, and the files whose diffs do not fit keep both ends.
import { spawnSync } from "../proc.js";

/** Room for one part's text, and for the JSON a station records it in (commandStation NODE_JSON_CAP is 64,000). */
export const BLIND_TEXT_CAP = 60_000;
const RECORD_CAP = 63_000;

/** The largest rendering whose JSON, escaping included, fits the station's record. */
function fitRecord<T extends { text: string }>(build: (cap: number) => T, record = RECORD_CAP): T {
  let cap = record === RECORD_CAP ? BLIND_TEXT_CAP : record;
  for (;;) {
    const out = build(cap);
    const size = JSON.stringify(out).length;
    if (size <= record || cap < 1_000) return out;
    cap = Math.floor(cap * Math.min(0.95, record / size));
  }
}

const GUIDE_NAMES = ["CLAUDE.md", "AGENTS.md"];

/** Files whose diff says nothing a reader can judge: their counts stay, their lines go. */
const NOISE = [/(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum)$/, /\.(png|jpe?g|gif|webp|ico|pdf|mp4|mov|woff2?|ttf|zip)$/i, /(^|\/)__snapshots__\//];

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${String(r.stderr || "").trim() || `exit ${r.status}`}`);
  return String(r.stdout);
}

/** Lines tools and agents sign work with: they name the author, so they never reach the judge. */
const SIGNATURE_LINE = /^[+\- ].*\b(Co-Authored-By|Signed-off-by|Codecast-Session|Generated with|Reviewed-by|Authored-by):/i;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Removes the given names and ids, every email, and signature lines from diff text. */
export function scrubAuthorSigns(text: string, names: string[]): string {
  // A full name goes, and so does each capitalized part of it ("Dana" alone in a comment).
  const parts = names.flatMap((n) => [n, ...n.split(/\s+/).filter((w) => /^[A-Z][a-z]{3,}$/.test(w))]);
  const words = [...new Set(parts.map((n) => n.trim()).filter((n) => n.length >= 3))].sort((a, b) => b.length - a.length);
  const nameRe = words.length ? new RegExp(words.map((w) => (/^\w/.test(w) ? "\\b" : "") + escapeRe(w) + (/\w$/.test(w) ? "\\b" : "")).join("|"), "gi") : null;
  return text
    .split("\n")
    .filter((l) => !SIGNATURE_LINE.test(l))
    .map((l) => {
      let out = l.replace(EMAIL, "[email]");
      if (nameRe) out = out.replace(nameRe, "[redacted]");
      return out;
    })
    .join("\n");
}

type FileDiff = { path: string; added: number; removed: number; body: string; noise: boolean };

/** Splits `git diff` output into one entry per file, without the `index` header line. */
export function splitDiff(diff: string, counts: Map<string, { added: number; removed: number }>): FileDiff[] {
  const files: FileDiff[] = [];
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith("diff --git ")) continue;
    const m = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const path = m ? m[2] : chunk.slice(11, chunk.indexOf("\n"));
    const body = chunk.split("\n").filter((l) => !/^index [0-9a-f]+\.\.[0-9a-f]+/.test(l)).join("\n").trimEnd();
    const c = counts.get(path) ?? { added: 0, removed: 0 };
    files.push({ path, added: c.added, removed: c.removed, body, noise: NOISE.some((re) => re.test(path)) });
  }
  return files;
}

/** Cuts text to `cap` characters keeping its head and tail, the cut marked in lines. */
function keepLines(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const lines = text.split("\n");
  const head: string[] = [];
  const tail: string[] = [];
  let used = 80;
  let i = 0;
  let j = lines.length - 1;
  while (i <= j) {
    const takeHead = head.length <= tail.length * 2;
    const line = takeHead ? lines[i] : lines[j];
    if (used + line.length + 1 > cap) break;
    used += line.length + 1;
    if (takeHead) head.push(lines[i++]);
    else tail.unshift(lines[j--]);
  }
  return [...head, `[... ${j - i + 1} lines left out here ...]`, ...tail].join("\n");
}

/** Shares `budget` among sizes so small ones keep everything and the big ones split the rest evenly. */
function fairShares(sizes: number[], budget: number): number[] {
  const shares = sizes.map(() => 0);
  let left = budget;
  let open = sizes.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b]);
  while (open.length) {
    const even = Math.floor(left / open.length);
    const i = open[0];
    if (sizes[i] <= even) {
      shares[i] = sizes[i];
      left -= sizes[i];
      open = open.slice(1);
    } else {
      for (const k of open) shares[k] = even;
      break;
    }
  }
  return shares;
}

/** The diff as the judge reads it: a file list with counts, then each file's diff, fitted under `cap`. */
export function renderBlindDiff(files: FileDiff[], cap = BLIND_TEXT_CAP): string {
  const list = files.map((f) => `${f.path} (+${f.added} -${f.removed})${f.noise ? " [lockfile, binary or snapshot: lines not shown]" : ""}`).join("\n");
  const header = `Files changed (${files.length}):\n${list}\n\n`;
  const shown = files.filter((f) => !f.noise);
  const sep = "\n\n";
  const budget = Math.max(0, cap - header.length - shown.length * sep.length);
  const shares = fairShares(shown.map((f) => f.body.length), budget);
  return (header + shown.map((f, i) => keepLines(f.body, shares[i])).join(sep)).slice(0, cap);
}

/** `unified`: lines of context around each hunk (a large number shows each changed file whole); `record`: the JSON size to fit, the station's record unless a caller has room for more. */
export type BlindRange = { cwd: string; base: string; head: string; redact?: string[]; unified?: number; record?: number };

/** The change from the merge base of `base` and `head` to `head`, scrubbed of its authors. */
export function blindDiff(r: BlindRange): { text: string; files: number; added: number; removed: number } {
  const range = `${r.base}...${r.head}`;
  const authors = git(r.cwd, ["log", "--format=%an%n%ae%n%cn%n%ce", `${r.base}..${r.head}`]).split("\n");
  const counts = new Map<string, { added: number; removed: number }>();
  for (const line of git(r.cwd, ["diff", "--numstat", "-M", "--no-color", range]).split("\n")) {
    const [a, d, ...p] = line.split("\t");
    if (!p.length) continue;
    const path = p.join("\t").replace(/^(.*)\{(.*) => (.*)\}(.*)$/, "$1$3$4").replace(/^.* => /, "");
    counts.set(path, { added: Number(a) || 0, removed: Number(d) || 0 });
  }
  const raw = git(r.cwd, ["diff", "-M", "--no-color", "--no-ext-diff", `--unified=${r.unified ?? 5}`, range]);
  const files = splitDiff(scrubAuthorSigns(raw, [...authors, ...(r.redact ?? [])]), counts);
  return {
    ...fitRecord((cap) => ({ text: renderBlindDiff(files, cap) }), r.record),
    files: files.length,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
  };
}

/** The directories whose guidelines bear on `paths`: the root and every ancestor of each path. */
export function guideDirs(paths: string[]): string[] {
  const dirs = new Set<string>([""]);
  for (const p of paths) {
    const parts = p.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
}

/** A guide file's text at `commit`, following a symlink (a CLAUDE.md that links to AGENTS.md); null when absent. */
function readGuide(cwd: string, commit: string, path: string, hops = 0): string | null {
  const entry = spawnSync("git", ["-C", cwd, "ls-tree", commit, "--", path], { encoding: "utf-8" });
  const mode = String(entry.stdout ?? "").split(/\s/)[0];
  if (entry.status !== 0 || !mode) return null;
  const blob = spawnSync("git", ["-C", cwd, "show", `${commit}:${path}`], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (blob.status !== 0) return null;
  const text = String(blob.stdout);
  if (mode !== "120000") return text.trim();
  if (hops > 3) return null;
  const target = [...path.split("/").slice(0, -1), text.trim()].join("/").split("/").reduce<string[]>((acc, part) => (part === ".." ? acc.slice(0, -1) : part && part !== "." ? [...acc, part] : acc), []).join("/");
  return readGuide(cwd, commit, target, hops + 1);
}

/**
 * The repository's guidelines for the change, as they stood at its base: each
 * CLAUDE.md or AGENTS.md at the root or above a changed file, once per distinct
 * text (an AGENTS.md that repeats its CLAUDE.md is read once), fitted under `cap`.
 */
export function blindGuidelines(r: BlindRange): { text: string; files: string[] } {
  const base = git(r.cwd, ["merge-base", r.base, r.head]).trim();
  const paths = git(r.cwd, ["diff", "--name-only", "--no-renames", `${r.base}...${r.head}`]).split("\n").filter(Boolean);
  const seen = new Set<string>();
  const found: Array<{ path: string; text: string }> = [];
  for (const dir of guideDirs(paths)) {
    for (const name of GUIDE_NAMES) {
      const path = dir ? `${dir}/${name}` : name;
      const text = readGuide(r.cwd, base, path);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      found.push({ path, text });
    }
  }
  if (!found.length) return { text: "(This repository has no CLAUDE.md or AGENTS.md.)", files: [] };
  const titles = found.map((f) => `=== ${f.path} ===\n`);
  const sep = "\n\n";
  return fitRecord((cap) => {
    const budget = Math.max(0, cap - titles.reduce((n, t) => n + t.length + sep.length, 0));
    const shares = fairShares(found.map((f) => f.text.length), budget);
    return { text: found.map((f, i) => titles[i] + keepLines(f.text, shares[i])).join(sep), files: found.map((f) => f.path) };
  });
}
