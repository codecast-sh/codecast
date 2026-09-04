import { useCallback, useMemo, useState } from "react";
import { useAction, useConvexAuth } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useInboxStore } from "../store/inboxStore";
import { useRepoAccess, useRepoViewerScope } from "./useRepoAccess";
import { repoBrowseKey, retainRepoBrowseRows, type RepoBrowseRow } from "../lib/repoBrowseCache";
import { useWatchEffect } from "./useWatchEffect";
import { pathSegments, type RepoTreeEntry } from "../lib/repoView";
import { publicRepoUrl, usePublicRepoRead, useRepoTransport } from "../lib/repoTransport";

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
 * One read, described once and answered by whichever transport is in force.
 *
 * `args === null` means "not yet" and reads nothing at all, on either side.
 * Both halves are always mounted — hooks cannot be conditional — and the one
 * that is not in force is handed nothing to do, so it costs a render and no
 * traffic.
 */
type ReadDescriptor = {
  ensureRef: unknown;
  queryRef: unknown;
  args: Record<string, unknown> | null;
  publicKind: string;
  /** Defaults to `args`; set it only where the two transports differ. */
  publicParams?: Record<string, unknown> | null;
};

function useEnsuredRead<T>(descriptor: ReadDescriptor): RepoRead<T> {
  const { ensureRef, queryRef, args, publicKind } = descriptor;
  const mode = useRepoTransport();
  const repository = typeof args?.repository === "string" ? args.repository : undefined;
  const access = useRepoAccess(repository, mode === "convex");
  const { isAuthenticated } = useConvexAuth();
  const live = mode === "convex" && access.allowed === true && isAuthenticated ? args : null;
  const key = repoBrowseKey(access.scope, publicKind, args);
  const ensure = useAction(ensureRef as never) as (a: unknown) => Promise<unknown>;
  const [failure, setFailure] = useState<{ key: string | null; error?: Error }>({ key: null });
  const requestKey = live ? key : null;
  useWatchEffect(() => {
    if (!live) return;
    let cancelled = false;
    setFailure({ key });
    void ensure(live).catch((e: unknown) => {
      if (!cancelled) setFailure({ key, error: e instanceof Error ? e : new Error(String(e)) });
    });
    return () => { cancelled = true; };
  }, [requestKey, ensure]);
  const select = useCallback((value: unknown) => {
    if (!key || !access.scope || !repository) return [];
    return retainRepoBrowseRows(useInboxStore.getState().repoBrowse, {
      _id: key, scope: access.scope, repository, kind: publicKind, value, updated_at: Date.now(),
    });
  }, [key, access.scope, repository, publicKind]);
  const feed = useSyncCollection("repoBrowse", queryRef as never, (live ?? "skip") as never,
    { select, syncOpts: REPO_SNAPSHOT });
  const row = useInboxStore((s) => key ? s.repoBrowse[key] as RepoBrowseRow | undefined : undefined);
  const params = descriptor.publicParams === undefined ? args : descriptor.publicParams;
  const viaPublic = usePublicRepoRead<T>(mode === "public" ? publicRepoUrl(repository, publicKind, params) : null);
  if (mode === "public") return viaPublic;
  const visible = access.allowed === true && !feed.error && !(failure.key === key && failure.error);
  return {
    data: visible && row?.value != null ? row.value as T : undefined,
    missing: visible && row?.value === null,
    ready: visible && row !== undefined,
    error: access.error ?? feed.error ?? (failure.key === key ? failure.error : undefined),
  };
}

const REPO_SNAPSHOT = { isDelta: false };

// ── Branches ──

export type RepoBranches = {
  truncated?: boolean;
  default_branch: string;
  branches: { name: string; sha: string; protected: boolean }[];
};

export function useRepoBranches(repository: string | undefined): RepoRead<RepoBranches> {
  return useEnsuredRead<RepoBranches>({
    ensureRef: api.repos.ensureBranches,
    queryRef: api.repos.getBranches,
    args: repository ? { repository } : null,
    publicKind: "branches",
  });
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

  const read = useEnsuredRead<RepoTree>({
    ensureRef: api.repos.ensureTree,
    queryRef: api.repos.getTree,
    args: repository && active.treeRef ? { repository, ref: active.treeRef } : null,
    publicKind: "tree",
  });

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

export type RepoBlob = { base64?: string; content: string; size: number; truncated: boolean; sha: string };

export function useRepoBlob(
  repository: string | undefined,
  ref: string | undefined,
  path: string | undefined,
): RepoRead<RepoBlob> {
  return useEnsuredRead<RepoBlob>({
    ensureRef: api.repos.ensureBlob,
    queryRef: api.repos.getBlob,
    args: repository && ref && path ? { repository, ref, path } : null,
    publicKind: "blob",
  });
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
  return useEnsuredRead<RepoBlame>({
    ensureRef: api.repos.ensureBlame,
    queryRef: api.repos.getBlame,
    args: enabled && repository && ref && path ? { repository, ref, path } : null,
    publicKind: "blame",
  });
}

// ── History ──

const NO_COMMITS: RepoLogCommit[] = [];

export type RepoLogCommit = {
  additions?: number;
  deletions?: number;
  changed_files?: number;
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
  author?: string,
): {
  commits: RepoLogCommit[];
  ready: boolean;
  error: Error | undefined;
  loadingMore: boolean;
  exhausted: boolean;
  loadOlder: () => void;
} {
  const viewer = useRepoViewerScope();
  const mode = useRepoTransport();
  const access = useRepoAccess(repository, mode === "convex");
  const scope = `${mode}:${viewer}:${access.allowed}:${repository ?? ""}@${ref ?? ""}:${path ?? ""}:${author ?? ""}`;
  const [state, setState] = useState<{ scope: string; page: number; older: RepoLogCommit[] }>({
    scope: "",
    page: 1,
    older: [],
  });
  const active = state.scope === scope ? state : { scope, page: 1, older: [] };

  const read = useEnsuredRead<{ commits: RepoLogCommit[] }>({
    ensureRef: api.repos.ensureLog,
    queryRef: api.repos.getLog,
    args: repository && ref
      ? {
          repository,
          ref,
          ...(path ? { path } : {}),
          ...(author ? { author } : {}),
          page: active.page,
        }
      : null,
    publicKind: "log",
  });

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
  const scope = useRepoViewerScope();
  const { isAuthenticated } = useConvexAuth();
  const key = repoBrowseKey(scope, "repositories", {});
  const select = useCallback((value: unknown) => !key || !scope ? [] : retainRepoBrowseRows(useInboxStore.getState().repoBrowse,
    { _id: key, scope, repository: "", kind: "repositories", value, updated_at: Date.now() }), [key, scope]);
  const feed = useSyncCollection("repoBrowse", api.repos.listRepositories, scope && isAuthenticated ? {} : "skip",
    { select, syncOpts: REPO_SNAPSHOT });
  const row = useInboxStore((s) => key ? s.repoBrowse[key] : undefined);
  return { rows: feed.error ? [] : (row?.value as RepositoryRow[] ?? []), ready: !!row, error: feed.error };
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

// ── The repository itself ──

export type RepoMeta = {
  private: boolean;
  description: string | null;
  homepage: string | null;
  topics: string[];
  default_branch: string;
  size: number;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  open_pulls_count?: number;
  pushed_at: number | null;
  archived: boolean;
  html_url: string;
  license: string | null;
  languages: Record<string, number>;
};

export function useRepoMeta(repository: string | undefined): RepoRead<RepoMeta> {
  return useEnsuredRead<RepoMeta>({
    ensureRef: api.repos.ensureMeta,
    queryRef: api.repos.getMeta,
    args: repository ? { repository } : null,
    publicKind: "meta",
  });
}

// ── Refs ──

export type RepoTags = { truncated?: boolean; tags: { name: string; sha: string; subject?: string; committed_at?: number; author_login?: string }[] };

export function useRepoTags(repository: string | undefined): RepoRead<RepoTags> {
  return useEnsuredRead<RepoTags>({
    ensureRef: api.repos.ensureTags,
    queryRef: api.repos.getTags,
    args: repository ? { repository } : null,
    publicKind: "tags",
  });
}

export type RepoBranchDetail = {
  name: string;
  sha: string;
  subject: string;
  committed_at: number;
  author_name?: string;
  author_login?: string;
  author_avatar_url?: string;
  /** Absent when the installation cannot resolve the comparison. */
  ahead_by?: number;
  behind_by?: number;
  open_pr: { number: number; title: string } | null;
};

export type RepoBranchDetails = { truncated?: boolean; default_branch: string; branches: RepoBranchDetail[] };

/** The branch table: tip commit, drift from the default branch, open pull
 *  request. Heavier than useRepoBranches, which is the picker's plain list. */
export function useRepoBranchDetails(repository: string | undefined): RepoRead<RepoBranchDetails> {
  return useEnsuredRead<RepoBranchDetails>({
    ensureRef: api.repos.ensureBranchDetails,
    queryRef: api.repos.getBranchDetails,
    args: repository ? { repository } : null,
    publicKind: "branchdetails",
  });
}

// ── The README ──

export type RepoReadme = { found: boolean; path?: string; content?: string; sha?: string };

export function useRepoReadme(
  repository: string | undefined,
  ref: string | undefined,
): RepoRead<RepoReadme> {
  return useEnsuredRead<RepoReadme>({
    ensureRef: api.repos.ensureReadme,
    queryRef: api.repos.getReadme,
    args: repository && ref ? { repository, ref } : null,
    publicKind: "readme",
  });
}

// ── The last commit beside every row of a directory ──

export type RepoLastCommit = {
  sha: string;
  subject: string;
  committed_at: number;
  author_name?: string;
  author_login?: string;
  author_avatar_url?: string;
};

/** Keyed by full repository-relative path. */
export type RepoLastCommits = Record<string, RepoLastCommit>;

/**
 * The commit column GitHub shows against every file in a folder.
 *
 * `treeRef` is an optimization, not a requirement: a caller that already has
 * the directory's tree sha lets the backend read the entry names out of the
 * cache instead of asking GitHub to list the directory again.
 */
export function useRepoLastCommits(
  repository: string | undefined,
  ref: string | undefined,
  dirPath: string,
  treeRef?: string,
): RepoRead<RepoLastCommits> {
  return useEnsuredRead<RepoLastCommits>({
    ensureRef: api.repos.ensureLastCommits,
    queryRef: api.repos.getLastCommits,
    args: repository && ref
      ? { repository, ref, path: dirPath, ...(treeRef ? { tree_ref: treeRef } : {}) }
      : null,
    publicKind: "lastcommits",
    // tree_ref only tells the backend where to find the names; it is not part
    // of the cache key, and the public route resolves the directory itself.
    publicParams: repository && ref ? { ref, path: dirPath } : null,
  });
}

// ── Two refs side by side ──

export type RepoCompare = {
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  status: string;
  commits: {
    sha: string;
    message: string;
    author_name: string;
    author_login?: string;
    author_avatar_url?: string;
    timestamp: number;
  }[];
  files: {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
    patch_truncated?: boolean;
  }[];
};

export function useRepoCompare(
  repository: string | undefined,
  base: string | undefined,
  head: string | undefined,
): RepoRead<RepoCompare> {
  return useEnsuredRead<RepoCompare>({
    ensureRef: api.repos.ensureCompare,
    queryRef: api.repos.getCompare,
    args: repository && base && head ? { repository, base, head } : null,
    publicKind: "compare",
  });
}

// ── Code search ──

export type RepoSearch = {
  /** Always false: GitHub's code index covers the default branch only. */
  ref_scoped: boolean;
  total_count: number;
  incomplete_results: boolean;
  items: {
    path: string;
    sha: string;
    html_url: string;
    matches: { fragment: string; indices: [number, number][] }[];
  }[];
};

export function useRepoSearch(
  repository: string | undefined,
  q: string | undefined,
  page = 1,
): RepoRead<RepoSearch> {
  return useEnsuredRead<RepoSearch>({
    ensureRef: api.repos.ensureSearch,
    queryRef: api.repos.getSearch,
    args: repository && q ? { repository, q, page } : null,
    publicKind: "search",
  });
}

// ── Pull requests ──

export type RepoPull = {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  merged_at: number | null;
  created_at: number | null;
  updated_at: number | null;
  closed_at: number | null;
  author_login?: string;
  author_avatar_url?: string;
  head_ref?: string;
  base_ref?: string;
  labels: { name: string; color: string }[];
  html_url: string;
  // Present only on the signed-in transport: what codecast knows about the
  // pull request. The public route joins nothing.
  conversation_id?: string | null;
  shepherd_enabled?: boolean | null;
  shepherd_state?: string | null;
  checks_state?: string | null;
  review_decision?: string | null;
};

export type RepoPulls = { pulls: RepoPull[] };

export function useRepoPulls(
  repository: string | undefined,
  state: "open" | "closed" | "all" = "open",
  page = 1,
): RepoRead<RepoPulls> {
  return useEnsuredRead<RepoPulls>({
    ensureRef: api.repos.ensurePulls,
    queryRef: api.repos.getPulls,
    args: repository ? { repository, state, page } : null,
    publicKind: "pulls",
  });
}

// ── Every path in the repository, for the file finder ──

export type RepoFileIndex = RepoTree;

/**
 * The whole tree in one read.
 *
 * This is the file finder's index, and it is the one read here that can be
 * megabytes, so it is fetched only once something actually opens the finder.
 * GitHub truncates very large repositories and says so, which the caller should
 * show rather than silently offering a partial index.
 */
export function useRepoFileIndex(
  repository: string | undefined,
  ref: string | undefined,
  enabled: boolean,
): RepoRead<RepoFileIndex> {
  return useEnsuredRead<RepoFileIndex>({
    ensureRef: api.repos.ensureTree,
    queryRef: api.repos.getTree,
    args: enabled && repository && ref ? { repository, ref, recursive: true } : null,
    publicKind: "tree",
  });
}

// ── May this viewer browse through Convex at all? ──

/**
 * Null until the answer is known, and null for good when nobody is signed in.
 *
 * The standalone shell asks this to choose its transport, and "not signed in"
 * is not a "no" it should ever render: there is simply no viewer to have an
 * installation, so the public route is the only question left to ask.
 */
export function useRepoCanBrowse(repository: string | undefined): boolean | null {
  return useRepoAccess(repository).allowed;
}
