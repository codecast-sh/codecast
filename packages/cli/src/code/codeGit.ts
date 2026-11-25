// Git facts about a vault for the editor: where its repository is, the
// porcelain status the tree and gutter color by, and a file's text at a ref.
// A vault root may be a repository, a subdirectory of one or a worktree, so
// every path git reports (repo-relative) is translated through the vault's
// prefix before it leaves here, and every path the browser sends is translated
// back the same way.
//
// Status runs with --no-optional-locks: agents commit in these trees all day,
// and a status that refreshed the index would take index.lock under them.

import { CODE_GIT_MERGE_BASE_REF, VAULT_MAX_SERVE_BYTES, type CodeGitBaseResponse, type CodeGitFileState, type CodeGitStatusResponse } from "@codecast/shared/contracts";
import type { VaultInfo } from "@codecast/shared/contracts";
import { execFile } from "../proc.js";

const GIT_TIMEOUT_MS = 10_000;
const STATUS_TTL_MS = 1_500;
const REPO_TTL_MS = 30_000;
/** A folder nobody has run `git init` in yet is asked again sooner. */
const NOT_REPO_TTL_MS = 5_000;

export interface GitRunOptions {
  input?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

/** One git invocation off the loop. Rejects with git's last stderr line. */
export function git(cwd: string, args: string[], opts: GitRunOptions & { buffer: true }): Promise<Buffer>;
export function git(cwd: string, args: string[], opts?: GitRunOptions): Promise<string>;
export function git(cwd: string, args: string[], opts: GitRunOptions & { buffer?: boolean } = {}): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        encoding: "buffer",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr).trim().split("\n").pop();
          reject(new Error(detail || error.message));
        } else resolve(opts.buffer ? (stdout as Buffer) : (stdout as Buffer).toString("utf8"));
      },
    );
    child.stdin?.end(opts.input ?? "");
  });
}

export interface RepoLocation {
  /** Absolute work tree root, as git prints it. */
  top: string;
  /** The vault root relative to `top`, "" or ending in "/". */
  prefix: string;
}

const repos = new Map<string, { at: number; ttl: number; repo: Promise<RepoLocation | null> }>();

/** The repository holding a vault root, or null when it is not in a work tree. */
export function locateRepo(root: string): Promise<RepoLocation | null> {
  const hit = repos.get(root);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.repo;
  const repo = git(root, ["rev-parse", "--show-toplevel", "--show-prefix"]).then(
    (out) => {
      const [top, prefix = ""] = out.split("\n");
      return top ? { top, prefix } : null;
    },
    () => null,
  );
  const entry = { at: Date.now(), ttl: REPO_TTL_MS, repo };
  repos.set(root, entry);
  void repo.then((r) => { if (!r) entry.ttl = NOT_REPO_TTL_MS; });
  return repo;
}

/** Status plus what the base route needs and the wire type leaves out. */
export interface VaultGitStatus extends CodeGitStatusResponse {
  /** Vault-relative new path to the repo-relative path it was renamed from. */
  renamedFrom: Map<string, string>;
}

/**
 * Fold `git status --porcelain=v2 -z --branch` into vault-relative states.
 * Paths outside the vault (`prefix`) are dropped. Pure, for tests.
 */
export function parsePorcelainV2(out: string, prefix: string): VaultGitStatus {
  const status: VaultGitStatus = { repo: true, branch: null, head: null, files: {}, renamedFrom: new Map() };
  const toVault = (p: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : null);
  const entries = out.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.startsWith("# ")) {
      const [key, ...rest] = entry.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") status.head = value === "(initial)" ? null : value;
      else if (key === "branch.head") status.branch = value === "(detached)" ? null : value;
      else if (key === "branch.ab") {
        const m = value.match(/^\+(\d+) -(\d+)$/);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = entry[0];
    let repoPath: string;
    let state: CodeGitFileState | null;
    if (kind === "?") {
      repoPath = entry.slice(2);
      state = "untracked";
    } else if (kind === "1" || kind === "2" || kind === "u") {
      // Space-separated fields, then the path (which may itself hold spaces).
      const fieldCount = kind === "1" ? 8 : kind === "2" ? 9 : 10;
      repoPath = afterFields(entry, fieldCount);
      const xy = entry.slice(2, 4);
      if (kind === "u") state = "conflicted";
      else if (kind === "2") {
        // A rename's source path is the next NUL-separated field.
        const from = entries[++i] ?? "";
        state = xy.includes("C") ? "added" : "renamed";
        const rel = toVault(repoPath);
        if (rel !== null && state === "renamed") status.renamedFrom.set(rel, from);
      } else state = foldXY(xy);
    } else continue; // "!" (ignored) is never requested.
    const rel = toVault(repoPath);
    if (rel && state) status.files[rel] = state;
  }
  return status;
}

function afterFields(entry: string, count: number): string {
  let at = 0;
  for (let n = 0; n < count; n++) {
    at = entry.indexOf(" ", at) + 1;
    if (at === 0) return "";
  }
  return entry.slice(at);
}

/** An ordinary changed entry against HEAD. X is the index, Y the work tree. */
function foldXY(xy: string): CodeGitFileState | null {
  const [x, y] = xy;
  // Added to the index, then removed from disk: absent from HEAD and from the
  // tree alike, so nothing differs.
  if (x === "A" && y === "D") return null;
  if (x === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  return "modified";
}

const statuses = new Map<string, { at: number; status: Promise<VaultGitStatus> }>();

/**
 * The vault's status, shared by every caller inside a short window so a tree,
 * a gutter and a tab bar asking together cost one `git status`.
 */
export function vaultGitStatus(vault: VaultInfo, opts: { fresh?: boolean } = {}): Promise<VaultGitStatus> {
  const hit = statuses.get(vault.id);
  if (!opts.fresh && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.status;
  const status = (async (): Promise<VaultGitStatus> => {
    const repo = await locateRepo(vault.root);
    if (!repo) return { repo: false, branch: null, head: null, files: {}, renamedFrom: new Map() };
    const out = await git(vault.root, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", "."], {
      timeoutMs: 20_000,
    });
    return parsePorcelainV2(out, repo.prefix);
  })();
  statuses.set(vault.id, { at: Date.now(), status });
  // A failed status (a timeout on a huge tree) is not remembered.
  status.catch(() => {
    if (statuses.get(vault.id)?.status === status) statuses.delete(vault.id);
  });
  return status;
}

/** Drop a vault's cached status, or every vault's. Cheap; the next read pays. */
export function invalidateGitStatus(vaultId?: string): void {
  if (vaultId) statuses.delete(vaultId);
  else statuses.clear();
}

/** The status as the wire carries it. */
export function statusResponse(status: VaultGitStatus): CodeGitStatusResponse {
  const { renamedFrom: _renamedFrom, ...wire } = status;
  return wire;
}

// A ref is passed to git as `<ref>:<path>`, so it may not carry a colon, start
// like an option or hold whitespace. This admits branch names, shas, tags and
// HEAD~2 / main^ / @{u} forms.
const REF_RE = /^[\w@{}~^./-]+$/;

export function isSafeRef(ref: string): boolean {
  return REF_RE.test(ref) && !ref.startsWith("-") && !ref.includes("..");
}

/** A ref form of codecast's own, never a name git reads: the commit where
 *  HEAD left the default branch (`git merge-base HEAD <default>`), so a diff
 *  against it shows everything this branch changed. */
export const MERGE_BASE_REF = CODE_GIT_MERGE_BASE_REF;

/** The default branch: what origin/HEAD points at, else main, else master. */
export async function defaultBranch(root: string): Promise<string | null> {
  const origin = await git(root, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]).then((o) => o.trim(), () => "");
  if (origin) return origin.replace(/^refs\/remotes\//, "");
  for (const name of ["main", "master"]) {
    const ok = await git(root, ["rev-parse", "--verify", "-q", `refs/heads/${name}`]).then((o) => !!o.trim(), () => false);
    if (ok) return name;
  }
  return null;
}

/** A ref as git can read it: `@merge-base` resolved to its commit, anything
 *  else as given. Null when it names nothing (no default branch, no common
 *  history). */
export async function resolveRef(root: string, ref: string): Promise<string | null> {
  if (ref !== MERGE_BASE_REF) return ref;
  const branch = await defaultBranch(root);
  if (!branch) return null;
  const sha = await git(root, ["merge-base", "HEAD", branch]).then((o) => o.trim(), () => "");
  return /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
}

export type GitBaseResult = CodeGitBaseResponse | { error: "not a repo" | "unknown ref" | "too large"; size?: number };

/** The commit HEAD names, or null on an unborn branch. One rev-parse, no tree walk. */
export function headSha(root: string): Promise<string | null> {
  return git(root, ["rev-parse", "--verify", "-q", "HEAD"]).then((out) => out.trim() || null, () => null);
}

/**
 * The repo-relative path a vault file was renamed from in the index (a staged
 * `git mv`), or null. Asked only for a path missing at HEAD. A status already
 * in the cache answers it; otherwise index against HEAD, which never stats the
 * work tree.
 */
export async function renamedFromAtHead(vault: VaultInfo, repo: RepoLocation, rel: string): Promise<string | null> {
  const hit = statuses.get(vault.id);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) {
    const status = await hit.status.catch(() => null);
    if (status) return status.renamedFrom.get(rel) ?? null;
  }
  const out = await git(repo.top, ["diff", "--cached", "-M", "--name-status", "-z", "HEAD"]).catch(() => "");
  // R<score> NUL from NUL to NUL, repeated; other entries carry one path.
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    if (fields[i].startsWith("R") || fields[i].startsWith("C")) {
      if (fields[i].startsWith("R") && fields[i + 2] === repo.prefix + rel) return fields[i + 1];
      i += 2;
    } else i += 1;
  }
  return null;
}

/**
 * A vault file's text at `ref`. A file renamed in the index reads from its
 * old name at HEAD, so a `git mv` does not show the whole file as new.
 */
export async function gitBase(vault: VaultInfo, rel: string, ref: string): Promise<GitBaseResult> {
  const repo = await locateRepo(vault.root);
  if (!repo) return { error: "not a repo" };
  const rev = await resolveRef(vault.root, ref);
  if (!rev) return { error: "unknown ref" };
  const lookup = async (repoPath: string) => {
    const check = await git(vault.root, ["cat-file", "--batch-check"], { input: `${rev}^{commit}\n${rev}:${repoPath}\n` });
    const [commitLine = "", blobLine = ""] = check.split("\n");
    return { commit: / commit \d+$/.test(commitLine), blob: blobLine.match(/^([0-9a-f]+) blob (\d+)$/) };
  };
  let found = await lookup(repo.prefix + rel);
  if (!found.commit) return { error: "unknown ref" };
  if (!found.blob && ref === "HEAD") {
    const from = await renamedFromAtHead(vault, repo, rel);
    if (from) found = await lookup(from);
  }
  const blob = found.blob;
  if (!blob) return { path: rel, ref, exists: false };
  const size = Number(blob[2]);
  if (size > VAULT_MAX_SERVE_BYTES) return { error: "too large", size };
  const content = await git(vault.root, ["cat-file", "blob", blob[1]], { buffer: true, maxBuffer: VAULT_MAX_SERVE_BYTES + 1024 });
  return { path: rel, ref, exists: true, content: content.toString("utf8"), sha: blob[1] };
}
