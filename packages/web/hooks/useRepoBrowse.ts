// Reading a repository: branches, trees, blobs, history and blame.
//
// None of this is store data. A repository is far too large to mirror, and
// every answer here is a window onto GitHub that the backend caches per view
// (repo_cache). So the shape is always the same two steps: call the `ensure`
// action for what the page wants, and subscribe to the matching `get` query
// for the render. The action fills the cache row; the query paints from it.
//
// Failures degrade the surface instead of unmounting it, so every read goes
// through useQueryNoThrow and every ensure keeps its error beside the data.
import { useCallback, useMemo, useState } from "react";
import { useAction } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";
import { pathSegments, type RepoTreeEntry } from "../lib/repoView";

// `api` is a proxy, so naming a function prod has not deployed yet still
// produces a reference; the call then fails and the surface reports it as an
// error instead of crashing. That is what lets these pages ship before the
// backend half is deployed.
const api = _api as any;

export type RepoRead<T> = {
  data: T | undefined;
  /** The cache row exists and holds nothing for this request. */
  missing: boolean;
  ready: boolean;
  error: Error | undefined;
};

/**
 * One read: fire the refresh action for these arguments, then subscribe to the
 * query that answers from the cache. `args === null` means "not yet" and reads
 * nothing at all.
 */
function useEnsuredRead<T>(ensureRef: unknown, queryRef: unknown, args: Record<string, unknown> | null): RepoRead<T> {
  const ensure = useAction(ensureRef as never) as (a: unknown) => Promise<unknown>;
  const [ensureError, setEnsureError] = useState<Error | undefined>(undefined);
  const key = args ? JSON.stringify(args) : null;

  useWatchEffect(() => {
    if (!args) return;
    let cancelled = false;
    setEnsureError(undefined);
    void ensure(args).catch((e: unknown) => {
      if (!cancelled) setEnsureError(e instanceof Error ? e : new Error(String(e)));
    });
    return () => {
      cancelled = true;
    };
  }, [key, ensure]);

  const { data, error } = useQueryNoThrow(queryRef as never, (args ?? "skip") as never);
  return {
    data: (data ?? undefined) as T | undefined,
    missing: data === null,
    ready: data !== undefined,
    error: error ?? ensureError,
  };
}

// ── Branches ──

export type RepoBranches = {
  default_branch: string;
  branches: { name: string; sha: string; protected: boolean }[];
};

export function useRepoBranches(repository: string | undefined): RepoRead<RepoBranches> {
  return useEnsuredRead<RepoBranches>(
    api.repos.ensureBranches,
    api.repos.getBranches,
    repository ? { repository } : null,
  );
}

// ── The source tree ──

export type RepoTree = { sha: string; truncated: boolean; entries: RepoTreeEntry[] };

/**
 * The directory at `path`, walked down one level at a time.
 *
 * GitHub answers a tree by its own sha, and a whole repository fetched
 * recursively is far larger than one cache row may hold, so a nested directory
 * is reached by descending: read the root, take the child's sha, read that. A
 * deep link costs one round trip per segment on the first visit and none after
 * (a tree sha never moves, so the backend caches it forever).
 */
export function useRepoTree(
  repository: string | undefined,
  ref: string | undefined,
  path: string,
): RepoRead<RepoTree> & { notFound: boolean } {
  const segments = useMemo(() => pathSegments(path), [path]);
  const walkKey = `${repository ?? ""}@${ref ?? ""}:${segments.join("/")}`;
  const [walk, setWalk] = useState<{ key: string; depth: number; treeRef: string; notFound: boolean }>({
    key: "",
    depth: 0,
    treeRef: "",
    notFound: false,
  });

  // Derived, not stored: a new target starts the walk over on the render that
  // asks for it, so the query never spends a beat on the previous path's tree.
  const active =
    walk.key === walkKey ? walk : { key: walkKey, depth: 0, treeRef: ref ?? "", notFound: false };

  const read = useEnsuredRead<RepoTree>(
    api.repos.ensureTree,
    api.repos.getTree,
    repository && active.treeRef ? { repository, ref: active.treeRef } : null,
  );

  useWatchEffect(() => {
    if (!read.data || active.depth >= segments.length || active.notFound) return;
    const want = segments[active.depth];
    const child = read.data.entries?.find((e) => e.path === want && e.type === "tree");
    setWalk(
      child
        ? { key: walkKey, depth: active.depth + 1, treeRef: child.sha, notFound: false }
        : { key: walkKey, depth: active.depth, treeRef: active.treeRef, notFound: true },
    );
  }, [read.data, active.depth, active.notFound, walkKey, segments]);

  const arrived = active.depth >= segments.length;
  return {
    data: arrived ? read.data : undefined,
    missing: arrived && read.missing,
    ready: arrived && read.ready,
    error: read.error,
    notFound: active.notFound,
  };
}

// ── One file ──

export type RepoBlob = { content: string; size: number; truncated: boolean; sha: string };

export function useRepoBlob(
  repository: string | undefined,
  ref: string | undefined,
  path: string | undefined,
): RepoRead<RepoBlob> {
  return useEnsuredRead<RepoBlob>(
    api.repos.ensureBlob,
    api.repos.getBlob,
    repository && ref && path ? { repository, ref, path } : null,
  );
}

// ── Blame ──

export type RepoBlame = {
  ranges: {
    start_line: number;
    end_line: number;
    sha: string;
    message?: string;
    author_name?: string;
    author_login?: string;
    author_avatar_url?: string;
    committed_at?: number;
  }[];
};

/** Blame is expensive and most readers never ask for it, so it is fetched only
 *  once `enabled` turns on and stays cached after. */
export function useRepoBlame(
  repository: string | undefined,
  ref: string | undefined,
  path: string | undefined,
  enabled: boolean,
): RepoRead<RepoBlame> {
  return useEnsuredRead<RepoBlame>(
    api.repos.ensureBlame,
    api.repos.getBlame,
    enabled && repository && ref && path ? { repository, ref, path } : null,
  );
}

// ── History ──

const NO_COMMITS: RepoLogCommit[] = [];

export type RepoLogCommit = {
  sha: string;
  message: string;
  author_name: string;
  author_login?: string;
  author_avatar_url?: string;
  timestamp: number;
  html_url?: string;
  conversation_id?: string | null;
  session?: { _id: string; title?: string } | null;
  tasks?: { _id: string; short_id?: string; title?: string }[];
  pr_number?: number | null;
};

/**
 * A page of history, plus every page already read.
 *
 * History is append-only in the direction we read it, so older pages are kept
 * as they arrive and only the newest request stays live. "Load older" asks for
 * the next page; nothing already on screen re-fetches.
 */
export function useRepoLog(
  repository: string | undefined,
  ref: string | undefined,
  path: string | undefined,
): {
  commits: RepoLogCommit[];
  ready: boolean;
  error: Error | undefined;
  loadingMore: boolean;
  exhausted: boolean;
  loadOlder: () => void;
} {
  const scope = `${repository ?? ""}@${ref ?? ""}:${path ?? ""}`;
  const [state, setState] = useState<{ scope: string; page: number; older: RepoLogCommit[] }>({
    scope: "",
    page: 1,
    older: [],
  });
  const active = state.scope === scope ? state : { scope, page: 1, older: [] };

  const read = useEnsuredRead<{ commits: RepoLogCommit[] }>(
    api.repos.ensureLog,
    api.repos.getLog,
    repository && ref ? { repository, ref, ...(path ? { path } : {}), page: active.page } : null,
  );

  // Stable identity: a fresh `[]` every render would re-make loadOlder and
  // re-run the merge below on every tick.
  const page = useMemo(() => read.data?.commits ?? NO_COMMITS, [read.data]);
  const loadOlder = useCallback(() => {
    setState((prev) => {
      const current = prev.scope === scope ? prev : { scope, page: 1, older: [] };
      return { scope, page: current.page + 1, older: [...current.older, ...page] };
    });
  }, [scope, page]);

  const commits = useMemo(() => {
    const seen = new Set<string>();
    return [...active.older, ...page].filter((c) => {
      if (seen.has(c.sha)) return false;
      seen.add(c.sha);
      return true;
    });
  }, [active.older, page]);

  return {
    commits,
    ready: read.ready || active.older.length > 0,
    error: read.error,
    loadingMore: active.page > 1 && !read.ready,
    exhausted: read.ready && page.length === 0,
    loadOlder,
  };
}

// ── Which repositories this viewer may browse ──

export type RepositoryRow = { repository: string; team_id: string; installed: boolean };

export function useRepositories(): { rows: RepositoryRow[]; ready: boolean; error: Error | undefined } {
  const { data, error } = useQueryNoThrow(api.repos.listRepositories, {});
  return { rows: (data as RepositoryRow[]) ?? [], ready: data !== undefined, error };
}

// ── Filling in a commit's diff ──

/**
 * Fetch one commit's files when the row arrived without them.
 *
 * A commit that came in by webhook carries its message and counts but no
 * patches, so the page asks for them once and the commit row updates itself
 * through the store feeder. Answers with the backend's own reason when there is
 * nothing to fetch, so the page can tell "still reading" from "nothing to read".
 */
export function useEnsureCommitFiles(
  repository: string | undefined,
  sha: string | undefined,
  enabled: boolean,
): { pending: boolean; reason: string | undefined; error: Error | undefined } {
  const ensure = useAction(api.repos.ensureCommitFiles);
  const [state, setState] = useState<{ key: string; pending: boolean; reason?: string; error?: Error }>({
    key: "",
    pending: false,
  });
  const key = enabled && repository && sha ? `${repository}@${sha}` : "";

  useWatchEffect(() => {
    if (!key) return;
    let cancelled = false;
    setState({ key, pending: true });
    void ensure({ repository, sha })
      .then((result: any) => {
        if (!cancelled) setState({ key, pending: false, reason: result?.reason });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({ key, pending: false, error: e instanceof Error ? e : new Error(String(e)) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key, ensure]);

  const current = state.key === key ? state : { pending: !!key, reason: undefined, error: undefined };
  return { pending: current.pending, reason: current.reason, error: current.error };
}
