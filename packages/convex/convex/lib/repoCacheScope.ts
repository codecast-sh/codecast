// The repo cache's read scope and row helpers: which rows a reader may see,
// the one keyed lookup, and the size budget for a stored payload. Split from
// repos.ts (line ratchet). Helpers only: this module defines no Convex functions.
import type { Id } from "../_generated/dataModel";
import { normalizeRepository } from "./gitRefs";

/**
 * Which cache rows a read may see. A row a checkout published carries the
 * workspace it was published to (`local_workspace`) and is seen only by a
 * reader admitted through a checkout of that same team; a row with no stamp
 * came from GitHub through an installation (or predates the stamp) and is
 * seen only by a reader an installation admits. The repository name alone
 * never admits anyone: a checkout names its own repository.
 */
export type CacheScope = { installation: boolean; local_team_id?: Id<"teams"> };

/** A reader with no identity, or a GitHub write: installation rows only. */
export const INSTALLATION_ONLY: CacheScope = { installation: true };

export function localWorkspaceOf(teamId: Id<"teams">): string {
  return `team:${String(teamId)}`;
}

export function scopeOf(access: { installation_id?: number; local_team_id?: Id<"teams"> }): CacheScope {
  return { installation: !!access.installation_id, ...(access.local_team_id ? { local_team_id: access.local_team_id } : {}) };
}

/**
 * The one cache lookup: the key's repository is the canonical spelling, and
 * only rows the scope admits are candidates. With both a checkout's row and
 * GitHub's, the newer one answers, except for meta, where GitHub's answer
 * stands over a checkout's placeholder.
 */
export async function cacheRowByKey(ctx: { db: any }, repository: string, kind: string, ref: string, path: string, scope: CacheScope = INSTALLATION_ONLY) {
  const rows: any[] = await ctx.db
    .query("repo_cache")
    .withIndex("by_key", (q: any) =>
      q.eq("repository", normalizeRepository(repository)).eq("kind", kind).eq("ref", ref).eq("path", path))
    .collect();
  const local = scope.local_team_id ? rows.find((r) => r.local_workspace === localWorkspaceOf(scope.local_team_id!)) : undefined;
  const github = scope.installation ? rows.find((r) => !r.local_workspace) : undefined;
  if (!local || !github) return local ?? github ?? null;
  if (kind === "meta") return github;
  return local.fetched_at >= github.fetched_at ? local : github;
}

/** A meta row a checkout published: the counts are placeholders and `private` is a guess. */
export function isLocalMeta(row: { kind: string; content: string } | null): boolean {
  if (!row || row.kind !== "meta") return false;
  try {
    return JSON.parse(row.content)?.source === "local";
  } catch {
    return false;
  }
}

// Convex refuses a document over 1 MiB. Blobs are admitted up to 1 MiB of raw
// bytes, then stored JSON-encoded (escapes, and an image's base64 beside its
// text), so a file near the cap became a 1.3 MiB row that failed to write on
// every view. A payload over this budget is stored as a truncated answer,
// which every reader already shows as "too large to display".
const CACHE_CONTENT_MAX_BYTES = 900 * 1024;

export function fitCacheContent(content: string, size?: number): { content: string; truncated?: boolean } {
  if (new TextEncoder().encode(content).length <= CACHE_CONTENT_MAX_BYTES) return { content };
  let sha: string | undefined;
  try { sha = JSON.parse(content)?.sha; } catch {}
  return { content: JSON.stringify({ content: "", size, truncated: true, ...(sha ? { sha } : {}) }), truncated: true };
}
