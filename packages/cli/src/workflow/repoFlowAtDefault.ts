// The repo's flow as its default branch has it (docs/architecture/flows.md FL2).
//
// A flow named in a checkout is read through every file it pulls in: the
// `.cast`, the chain it extends, each segment it names by slug, and each
// station's `@file`. A checkout cut before any of those moved on the default
// branch would run an old graph, while the run's scripts, the gates they read
// from the default branch and the change itself are newer: two graphs and one
// set of scripts that disagree about what happens next (ct-98334 ran Union's
// Nov 19 change flow against Nov 22 scripts, and no run could land it). So a
// flow runs as the default branch has it, written to this machine's flow cache
// at the paths the repo holds them. The checkout's own copy runs only when the
// checkout has edits of its own to those files: that is someone working on the
// flow.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "../proc.js";
import { parseWorkflowSource, type ReadFile } from "./parser.js";
import { defaultFlowsCache } from "./teamFlowIndex.js";
import { markFlowCopy } from "./flowCopy.js";

export type FlowAtDefault =
  /** The checkout's copy is the default branch's, or there is no repo flow of this name on it: run what was found. */
  | { use: "found" }
  /** The checkout has its own edits to the flow's files: run its copy, and say the files are its own. */
  | { use: "checkout"; ref: string; own: string[]; behind: string[] }
  /** Run the default branch's copy, written to `file`; `behind` names what the checkout held older (or lacked). */
  | { use: "default"; ref: string; sha: string; file: string; rel: string; source: string; behind: string[] }
  /** The default branch's copy does not parse with this cast (a segment or syntax a newer cast ships): nothing runs. */
  | { use: "unparsed"; ref: string; sha: string; error: string; behind: string[] };

type Git = (args: string[], timeout?: number) => { ok: boolean; out: string };

const gitIn = (top: string): Git => (args, timeout) => {
  const r = spawnSync("git", ["-C", top, ...args], { encoding: "utf-8", timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { ok: r.status === 0, out: String(r.stdout ?? "") };
};

const readDisk: ReadFile = (abs) => (fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs, "utf-8") : null);
const inside = (root: string, abs: string) => abs === root || abs.startsWith(root + path.sep);
const posix = (rel: string) => rel.split(path.sep).join("/");

/** The default branch as origin has it: `origin/HEAD`, else origin/main, else origin/master. */
function defaultRef(git: Git): string | null {
  const head = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).out.trim();
  if (head) return head;
  return ["origin/main", "origin/master"].find((r) => git(["rev-parse", "--verify", "--quiet", `${r}^{commit}`]).ok) ?? null;
}

/**
 * Parse a flow and return every file under `top` the parse read (repo-relative, posix), with its text. Files outside
 * `top` (the team's published flows, a shipped template) are read from disk and are not part of the repo's flow.
 */
function readSet(src: string, file: string, top: string, read: ReadFile): Map<string, string | null> {
  const seen = new Map<string, string | null>();
  const recording: ReadFile = (abs) => {
    const text = read(abs);
    if (inside(top, abs)) seen.set(posix(path.relative(top, abs)), text);
    return text;
  };
  seen.set(posix(path.relative(top, file)), src);
  parseWorkflowSource(src, path.dirname(file), { read: recording }, file);
  return seen;
}

/**
 * Which copy of the repo flow `slug` a run started in `cwd` should execute. `found` is the file name resolution
 * found in the checkout (null when the name resolved to the library or the team's pool). Fetches the default branch
 * first (bounded; a failed fetch reads the local ref). When the default branch's copy does not parse with this cast,
 * the checkout's older copy is no stand-in for it: the answer is `unparsed`, unless the checkout is the default branch's
 * (its own parse reports the error) or holds edits of its own.
 */
export function repoFlowAtDefault(slug: string, cwd: string, found: string | null, opts: { fetch?: boolean; cacheRoot?: string } = {}): FlowAtDefault {
  const top0 = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8" });
  const top = top0.status === 0 ? fs.realpathSync(String(top0.stdout).trim()) : "";
  if (!top) return { use: "found" };
  const git = gitIn(top);
  let ref = defaultRef(git);
  if (!ref) return { use: "found" };
  if (opts.fetch !== false) {
    const [remote, ...rest] = ref.split("/");
    git(["fetch", "--quiet", remote, rest.join("/")], 20_000);
    ref = defaultRef(git) ?? ref;
  }
  const sha = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).out.trim();
  if (!sha) return { use: "found" };

  const foundAbs = found ? fs.realpathSync(found) : null;
  const candidates = [...(foundAbs && inside(top, foundAbs) ? [posix(path.relative(top, foundAbs))] : []), `.codecast/flows/${slug}.cast`];
  const blob = (rel: string): string | null => {
    const r = git(["cat-file", "blob", `${sha}:${rel}`]);
    return r.ok ? r.out : null;
  };
  const rel = candidates.find((c) => blob(c) !== null);
  if (!rel) return { use: "found" };
  const atDefault: ReadFile = (abs) => (inside(top, abs) ? blob(posix(path.relative(top, abs))) : readDisk(abs));

  const mainFile = path.join(top, rel);
  let mainSet = new Map<string, string | null>([[rel, blob(rel)]]);
  let error: string | null = null;
  try {
    mainSet = readSet(blob(rel)!, mainFile, top, atDefault);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  let hereSet = new Map<string, string | null>();
  if (foundAbs && inside(top, foundAbs)) {
    try { hereSet = readSet(fs.readFileSync(foundAbs, "utf-8"), foundAbs, top, readDisk); } catch { /* the checkout's copy does not parse: the default branch's runs */ }
  }
  const files = [...new Set([...mainSet.keys(), ...hereSet.keys()])].sort();
  const behind = files.filter((f) => (mainSet.has(f) ? mainSet.get(f) : blob(f)) !== readDisk(path.join(top, f)));
  if (!behind.length && foundAbs && posix(path.relative(top, foundAbs)) === rel) return { use: "found" };

  // Edits of the checkout's own: uncommitted, or committed here and not on the default branch.
  const dirty = git(["status", "--porcelain", "--untracked-files=all", "--", ...behind]).out.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
  const ahead = git(["log", "--format=", "--name-only", `${sha}..HEAD`, "--", ...behind]).out.split("\n").map((l) => l.trim()).filter(Boolean);
  const own = [...new Set([...dirty, ...ahead])].filter((f) => behind.includes(f)).sort();
  if (own.length) return { use: "checkout", ref, own, behind: behind.filter((f) => !own.includes(f)) };
  if (error) return { use: "unparsed", ref, sha, error, behind };

  // The default branch's copy, every file it reads at its repo path, under one directory per repo and commit.
  const key = createHash("sha256").update(top).digest("hex").slice(0, 10);
  const dir = path.join(opts.cacheRoot ?? defaultFlowsCache(), `repo-${key}-${sha.slice(0, 12)}`);
  for (const [f, text] of mainSet) {
    if (text === null) continue;
    const abs = path.join(dir, f);
    if (!inside(dir, abs)) continue;
    if (fs.existsSync(abs) && fs.readFileSync(abs, "utf-8") === text) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  // Named as this repo's copy: a push of it records this directory, and the daemon runs it as the run's own flow.
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).out.trim();
  markFlowCopy(dir, common ? fs.realpathSync(common) : top, sha);
  return { use: "default", ref, sha, file: path.join(dir, rel), rel, source: mainSet.get(rel)!, behind };
}

/** One line saying which copy runs and why; null when the checkout's is the default branch's. */
export function flowAtDefaultWords(slug: string, r: FlowAtDefault): string | null {
  const list = (fs: string[]) => `${fs.slice(0, 4).join(", ")}${fs.length > 4 ? ` and ${fs.length - 4} more` : ""}`;
  if (r.use === "default") return `${slug} runs as ${r.ref} has it (${r.sha.slice(0, 10)}): this checkout's copy is older in ${list(r.behind)}`;
  if (r.use === "unparsed") return `${r.ref}'s ${slug} flow (${r.sha.slice(0, 10)}) does not parse with this cast: ${r.error}. Update cast (cast update) and run again; this checkout's older copy would run a flow ${r.ref} has replaced`;
  if (r.use === "checkout") return `${slug} runs this checkout's own edits to ${list(r.own)}${r.behind.length ? `; it is older than ${r.ref} in ${list(r.behind)}` : ""}`;
  return null;
}
