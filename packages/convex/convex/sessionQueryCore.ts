// Pure narrowing logic for session query operators (sessionQuerySearch.ts
// wraps these with db reads; tests hit them directly with bun:test).
//
// Every operator turns into a candidate map, conversation id -> the time of
// the activity that matched (a file edit, a commit), or undefined when the
// operator matches the session as a whole (a label, a pull request link).
// Maps intersect, so operators AND together; the matched time orders an
// operator-only result by the recency of the matching change.

import { normalizeRepoName } from "@codecast/shared/search";

export type Candidates = Map<string, number | undefined>;

/** Keep ids present in both, carrying the newest matched time either side has. */
export function intersectCandidates(a: Candidates | null, b: Candidates): Candidates {
  if (a === null) return b;
  const out: Candidates = new Map();
  for (const [id, at] of a) {
    if (!b.has(id)) continue;
    const other = b.get(id);
    out.set(id, at === undefined ? other : other === undefined ? at : Math.max(at, other));
  }
  return out;
}

/** Record a matched time for an id, keeping the newest. */
export function addCandidate(map: Candidates, id: string, at?: number): void {
  const prev = map.get(id);
  if (!map.has(id) || (at !== undefined && (prev === undefined || at > prev))) map.set(id, at);
}

export function inWindow(ts: number, after?: number, before?: number): boolean {
  return (after === undefined || ts >= after) && (before === undefined || ts <= before);
}

/**
 * The absolute paths a file operator names. Stored edit paths are absolute
 * and each session's checkout sits somewhere else (another home directory, a
 * worktree), so a repo-relative path is tried under every checkout root the
 * viewer's sessions ran in. An absolute path names itself.
 */
export function fileQueryPrefixes(path: string, roots: string[]): string[] {
  if (path.startsWith("/")) return [path];
  const out = new Set<string>();
  for (const root of roots) {
    if (!root.startsWith("/")) continue;
    out.add(`${root.replace(/\/+$/, "")}/${path}`);
  }
  return [...out];
}

/** A stored path matches a prefix when it is that file or sits under that folder. */
export function pathMatchesPrefix(filePath: string, prefix: string): boolean {
  return filePath === prefix || filePath.startsWith(`${prefix}/`);
}

function basename(path?: string | null): string {
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

/**
 * `repo:` names a repository as owner/repo (matched against the session's git
 * remote), as a bare repository name (the remote's last segment), or as the
 * checkout folder's name.
 */
export function repoMatchesConversation(
  conv: { git_remote_url?: string | null; git_root?: string | null; project_path?: string | null },
  repo: string,
): boolean {
  const slug = conv.git_remote_url ? normalizeRepoName(conv.git_remote_url) : "";
  if (slug && (slug === repo || slug.endsWith(`/${repo}`))) return true;
  if (repo.includes("/")) return false;
  return basename(conv.git_root) === repo || basename(conv.project_path) === repo;
}

export type AuthorLite = { _id: { toString(): string }; name?: string | null; email?: string | null; github_username?: string | null };

/**
 * The user ids an `author:` value names among the people whose sessions the
 * viewer can search. "me" is the viewer; anything else matches a name, email
 * or GitHub login by substring, the same rule as `cast search -m`.
 */
export function matchAuthorIds(users: AuthorLite[], value: string, viewerId: string): Set<string> {
  const v = value.toLowerCase();
  if (v === "me") return new Set([viewerId]);
  const ids = new Set<string>();
  for (const u of users) {
    const fields = [u.name, u.email, u.github_username].map((f) => (f ?? "").toLowerCase());
    if (fields.some((f) => f && f.includes(v))) ids.add(u._id.toString());
  }
  return ids;
}
