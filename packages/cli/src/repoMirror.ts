/**
 * Publishing a local checkout's git metadata as repository cache rows.
 *
 * The repo pages read one cache (convex repo_cache) whose rows GitHub used to
 * be the only writer of. This builds the same rows from a checkout on this
 * machine — branches, tags, the first page of history, the root tree one level
 * deep, the readme, the "last commit per entry" column and a meta row — in the
 * exact shapes the GitHub fetchers produce, so every page renders them without
 * knowing which side wrote them. The daemon pushes the result through
 * repos.ingestLocal whenever the refs move (see refsFingerprint).
 *
 * Bounded on purpose: the first log page, the root tree and its immediate
 * subdirectories, one readme. A whole repository is far larger than a cache
 * may hold; deeper reads are answered on demand.
 *
 * Every git call is plumbing with explicit separators, and every field that
 * GitHub knows and a checkout does not (a login, an avatar, an open pull
 * request) is left undefined rather than invented.
 */

import { execFile } from "./proc.js";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { extractRepoFromRemoteUrl, normalizeGitOrigin } from "@codecast/shared/contracts";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
/** History page size, the same page GitHub answers with. */
const LOG_PAGE = 30;
/** Branches, tags and blame-style per-entry lookups are capped so a huge repo costs bounded git calls. */
const MAX_REFS = 100;
const MAX_AHEAD_BEHIND = 50;
const MAX_TREE_ROWS = 40;
const MAX_LAST_COMMIT_ENTRIES = 60;
/** A readme past this is cut, and says so. */
const MAX_README_BYTES = 200 * 1024;
const NUL = "\x00";
const RS = "\x1e";
const US = "\x1f";

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export interface MirrorRow {
  kind: string;
  ref: string;
  path: string;
  sha?: string;
  content: string;
  size?: number;
  truncated?: boolean;
}

export interface MirrorCommit {
  sha: string;
  message: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  files_changed: number;
  insertions: number;
  deletions: number;
  branch?: string;
}

export interface RepoMirror {
  repository: string;
  remote_url?: string;
  default_branch: string;
  head_sha: string;
  rows: MirrorRow[];
  commits: MirrorCommit[];
}

export async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

/**
 * The repository key a checkout publishes under: the `owner/name` of its
 * GitHub origin when it has one, so GitHub activity and the local rows meet on
 * one row; the last two path segments of any other remote; and, with no
 * remote at all, `local/<folder>`.
 */
export function repositoryKeyFor(root: string, originUrl: string | undefined | null): string {
  const github = extractRepoFromRemoteUrl(originUrl);
  if (github) return github;
  const normalized = originUrl ? normalizeGitOrigin(originUrl) : null;
  if (normalized) {
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length >= 3) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return `local/${path.basename(root).toLowerCase()}`;
}

/** A GitHub origin's web URL, for the meta row; empty for anything else. */
function htmlUrlFor(originUrl: string | undefined): string {
  const github = extractRepoFromRemoteUrl(originUrl);
  return github ? `https://github.com/${github}` : "";
}

/**
 * Cheap change detector: the refs and HEAD, hashed. The daemon pushes a
 * checkout again only when this moves, so an idle repository costs one git
 * call per sweep and no upload.
 */
export async function refsFingerprint(root: string, run: GitRunner = runGit): Promise<string> {
  const [refs, head] = await Promise.all([
    run(root, ["for-each-ref", "--format=%(refname) %(objectname)"]).catch(() => ""),
    run(root, ["rev-parse", "HEAD"]).catch(() => ""),
  ]);
  return createHash("sha1").update(refs).update("\n").update(head).digest("hex");
}

/** Raw stdout, or undefined when git refuses. Blob contents come through here untouched. */
async function tryGit(run: GitRunner, cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await run(cwd, args);
  } catch {
    return undefined;
  }
}

/** One value on one line: a sha, a ref name, a URL, a count. */
async function tryGitLine(run: GitRunner, cwd: string, args: string[]): Promise<string | undefined> {
  const out = await tryGit(run, cwd, args);
  return out === undefined ? undefined : out.trim();
}

/** origin/HEAD when the remote told us, else main, else master, else whatever is checked out. */
async function defaultBranchFor(run: GitRunner, root: string, current: string | undefined): Promise<string> {
  const originHead = await tryGitLine(run, root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) return originHead.replace(/^origin\//, "");
  for (const candidate of ["main", "master"]) {
    if ((await tryGit(run, root, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`])) !== undefined) return candidate;
  }
  return current && current !== "HEAD" ? current : "HEAD";
}

type RefLine = { name: string; sha: string; committed_at: number; subject: string; author_name: string; author_email: string };

async function branchLines(run: GitRunner, root: string): Promise<RefLine[]> {
  const out = await tryGit(run, root, [
    "for-each-ref",
    `--count=${MAX_REFS}`,
    "--sort=-committerdate",
    "--format=%(refname:short)%00%(objectname)%00%(committerdate:unix)%00%(subject)%00%(authorname)%00%(authoremail)",
    "refs/heads",
  ]);
  if (!out) return [];
  return out.split("\n").filter(Boolean).map((line) => {
    const [name, sha, at, subject, author_name, author_email] = line.split(NUL);
    return { name, sha, committed_at: Number(at) * 1000, subject: subject ?? "", author_name: author_name ?? "", author_email: (author_email ?? "").replace(/^<|>$/g, "") };
  });
}

/** Tags point at a commit directly (lightweight) or through a tag object (annotated); `*` fields are the peeled commit. */
async function tagLines(run: GitRunner, root: string): Promise<{ name: string; sha: string; committed_at?: number; subject?: string }[]> {
  const out = await tryGit(run, root, [
    "for-each-ref",
    `--count=${MAX_REFS}`,
    "--sort=-creatordate",
    "--format=%(refname:short)%00%(*objectname)%00%(objectname)%00%(*committerdate:unix)%00%(committerdate:unix)%00%(*subject)%00%(subject)",
    "refs/tags",
  ]);
  if (!out) return [];
  return out.split("\n").filter(Boolean).map((line) => {
    const [name, peeledSha, sha, peeledAt, at, peeledSubject, subject] = line.split(NUL);
    const when = Number(peeledAt || at);
    return {
      name,
      sha: peeledSha || sha,
      committed_at: when ? when * 1000 : undefined,
      subject: peeledSubject || subject || undefined,
    };
  });
}

type TreeEntry = { path: string; type: string; sha: string; size?: number };

/** `git ls-tree -l`: `<mode> <type> <sha> <size>\t<path>`; size is "-" for a tree. */
async function lsTree(run: GitRunner, root: string, ref: string): Promise<TreeEntry[] | undefined> {
  const out = await tryGit(run, root, ["ls-tree", "-l", ref]);
  if (out === undefined) return undefined;
  return out.split("\n").filter(Boolean).map((line) => {
    const [meta, entryPath] = line.split("\t");
    const [, type, sha, size] = meta.trim().split(/\s+/);
    return { path: entryPath, type, sha, ...(size !== "-" ? { size: Number(size) } : {}) };
  });
}

/**
 * One page of history in the GitHub listCommits shape, plus the rows the
 * commits table takes. Record separators keep a multi-line body intact:
 * each record is `RS sha NUL author NUL email NUL time NUL body US` followed
 * by that commit's numstat lines.
 */
async function logPage(run: GitRunner, root: string, ref: string, htmlBase: string): Promise<{ payload: any; commits: MirrorCommit[] }> {
  const out = await tryGit(run, root, [
    "log",
    `-${LOG_PAGE}`,
    "--format=%x1e%H%x00%an%x00%ae%x00%at%x00%B%x1f",
    "--numstat",
    ref,
    "--",
  ]);
  const commits: MirrorCommit[] = [];
  for (const record of (out ?? "").split(RS)) {
    if (!record.trim()) continue;
    const [header, stats = ""] = record.split(US);
    const [sha, author_name, author_email, at, body = ""] = header.split(NUL);
    if (!sha) continue;
    let insertions = 0;
    let deletions = 0;
    let files = 0;
    for (const line of stats.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (!m) continue;
      files++;
      if (m[1] !== "-") insertions += Number(m[1]);
      if (m[2] !== "-") deletions += Number(m[2]);
    }
    commits.push({
      sha,
      message: body.replace(/\n+$/, ""),
      author_name: author_name ?? "",
      author_email: author_email ?? "",
      timestamp: Number(at) * 1000,
      files_changed: files,
      insertions,
      deletions,
      branch: ref,
    });
  }
  return {
    payload: {
      commits: commits.map((c) => ({
        sha: c.sha,
        additions: c.insertions,
        deletions: c.deletions,
        changed_files: c.files_changed,
        message: c.message,
        author_name: c.author_name,
        timestamp: c.timestamp,
        html_url: htmlBase ? `${htmlBase}/commit/${c.sha}` : "",
      })),
    },
    commits,
  };
}

/** A rough languages map from file sizes by extension, the way GitHub's meta names them. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", go: "Go", rs: "Rust", rb: "Ruby", swift: "Swift", kt: "Kotlin", java: "Java", scala: "Scala",
  c: "C", h: "C", cpp: "C++", cc: "C++", hpp: "C++", m: "Objective-C", cs: "C#", php: "PHP", dart: "Dart",
  css: "CSS", scss: "SCSS", html: "HTML", vue: "Vue", svelte: "Svelte", sh: "Shell", bash: "Shell", zsh: "Shell",
  sql: "SQL", lua: "Lua", ex: "Elixir", exs: "Elixir", erl: "Erlang", hs: "Haskell", clj: "Clojure", r: "R", jl: "Julia",
};

async function languagesFor(run: GitRunner, root: string, ref: string): Promise<Record<string, number>> {
  const out = await tryGit(run, root, ["ls-tree", "-r", "-l", ref]);
  const totals: Record<string, number> = {};
  for (const line of (out ?? "").split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const [, type, , size] = line.slice(0, tab).trim().split(/\s+/);
    if (type !== "blob") continue;
    const ext = path.extname(line.slice(tab + 1)).slice(1).toLowerCase();
    const language = LANGUAGE_BY_EXT[ext];
    if (!language) continue;
    totals[language] = (totals[language] ?? 0) + (Number(size) || 0);
  }
  return totals;
}

/**
 * Everything the daemon publishes for one checkout, or null when the folder
 * is not a repository with at least one commit.
 */
export async function buildRepoMirror(root: string, run: GitRunner = runGit): Promise<RepoMirror | null> {
  const headSha = await tryGitLine(run, root, ["rev-parse", "HEAD"]);
  if (!headSha) return null;
  const current = await tryGitLine(run, root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const origin = await tryGitLine(run, root, ["remote", "get-url", "origin"]);
  const repository = repositoryKeyFor(root, origin);
  const htmlBase = htmlUrlFor(origin);
  const defaultBranch = await defaultBranchFor(run, root, current);
  const rows: MirrorRow[] = [];
  const row = (kind: string, ref: string, rowPath: string, payload: unknown, extra: Partial<MirrorRow> = {}) => {
    rows.push({ kind, ref, path: rowPath, content: JSON.stringify(payload), ...extra });
  };

  // Branches, twice: the plain list, and the detailed list the branches page reads.
  const branches = await branchLines(run, root);
  row("branches", "-", "", {
    default_branch: defaultBranch,
    truncated: branches.length === MAX_REFS,
    branches: branches.map((b) => ({ name: b.name, sha: b.sha, protected: false })),
  });
  const details = [];
  for (const [index, b] of branches.entries()) {
    let ahead_by: number | undefined;
    let behind_by: number | undefined;
    if (index < MAX_AHEAD_BEHIND && b.name !== defaultBranch) {
      const counts = await tryGitLine(run, root, ["rev-list", "--left-right", "--count", `${defaultBranch}...${b.name}`]);
      const m = counts?.match(/^(\d+)\s+(\d+)$/);
      if (m) {
        behind_by = Number(m[1]);
        ahead_by = Number(m[2]);
      }
    }
    details.push({ name: b.name, sha: b.sha, subject: b.subject, committed_at: b.committed_at, author_name: b.author_name, ahead_by, behind_by, open_pr: null });
  }
  row("branchdetails", "-", "", { default_branch: defaultBranch, truncated: branches.length === MAX_REFS, branches: details });

  const tags = await tagLines(run, root);
  row("tags", "-", "", { truncated: tags.length === MAX_REFS, tags });

  // The root tree under the branch name (what the home page asks for) and
  // under its own sha (what the walk asks for), then each subdirectory by sha.
  const rootTreeSha = await tryGitLine(run, root, ["rev-parse", `${defaultBranch}^{tree}`]);
  const rootEntries = (await lsTree(run, root, defaultBranch)) ?? [];
  const treePayload = { sha: rootTreeSha ?? "", truncated: false, entries: rootEntries };
  row("tree", defaultBranch, "", treePayload, { sha: rootTreeSha });
  if (rootTreeSha) row("tree", rootTreeSha, "", treePayload, { sha: rootTreeSha });
  let treeRows = 2;
  for (const entry of rootEntries) {
    if (entry.type !== "tree" || treeRows >= MAX_TREE_ROWS) continue;
    const entries = await lsTree(run, root, entry.sha);
    if (!entries) continue;
    row("tree", entry.sha, "", { sha: entry.sha, truncated: false, entries }, { sha: entry.sha });
    treeRows++;
  }

  // The readme, found by name in the root tree; "there isn't one" is a row too.
  const readme = rootEntries.find((e) => e.type === "blob" && /^readme(\.[a-z0-9]+)?$/i.test(e.path));
  if (readme) {
    const raw = await tryGit(run, root, ["show", `${defaultBranch}:${readme.path}`]);
    const content = raw ?? "";
    const truncated = Buffer.byteLength(content, "utf-8") > MAX_README_BYTES;
    row("readme", defaultBranch, "", { found: true, path: readme.path, content: truncated ? content.slice(0, MAX_README_BYTES) : content, sha: readme.sha }, { sha: readme.sha, truncated });
  } else {
    row("readme", defaultBranch, "", { found: false });
  }

  // History: the first page for the default branch, and for the checked-out
  // branch when that is a different one. The same commits feed the commits table.
  const commits: MirrorCommit[] = [];
  const seen = new Set<string>();
  const pages = [defaultBranch];
  if (current && current !== "HEAD" && current !== defaultBranch) pages.push(current);
  for (const branch of pages) {
    const page = await logPage(run, root, branch, htmlBase);
    row("log", branch, "#1#", page.payload);
    for (const commit of page.commits) {
      if (seen.has(commit.sha)) continue;
      seen.add(commit.sha);
      commits.push(commit);
    }
  }
  if (pages.length > 1 && current) {
    const currentTreeSha = await tryGitLine(run, root, ["rev-parse", `${current}^{tree}`]);
    const entries = await lsTree(run, root, current);
    if (entries) row("tree", current, "", { sha: currentTreeSha ?? "", truncated: false, entries }, { sha: currentTreeSha });
  }

  // The last commit that touched each root entry, the column beside the tree.
  const last: Record<string, unknown> = {};
  for (const entry of rootEntries.slice(0, MAX_LAST_COMMIT_ENTRIES)) {
    const line = await tryGitLine(run, root, ["log", "-1", "--format=%H%x00%s%x00%ct%x00%an", defaultBranch, "--", entry.path]);
    if (!line) continue;
    const [sha, subject, at, author_name] = line.split(NUL);
    last[entry.path] = { sha, subject: subject ?? "", committed_at: Number(at) * 1000, author_name };
  }
  row("lastcommits", defaultBranch, "", last);

  // Meta. A checkout says nothing about GitHub-side counts, so those are zero
  // and private stays true: the public route must never open on a local row.
  const headTime = commits[0]?.timestamp ?? null;
  row("meta", "-", "", {
    private: true,
    description: null,
    homepage: null,
    topics: [],
    default_branch: defaultBranch,
    size: 0,
    stargazers_count: 0,
    forks_count: 0,
    open_issues_count: 0,
    pushed_at: headTime,
    archived: false,
    html_url: htmlBase,
    license: null,
    languages: await languagesFor(run, root, defaultBranch),
    source: "local",
  });

  return { repository, remote_url: origin || undefined, default_branch: defaultBranch, head_sha: headSha, rows, commits };
}
