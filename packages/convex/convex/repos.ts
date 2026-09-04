// Browsing a repository from codecast.
//
// The source, history and blame pages read GitHub through the App installation
// the repository's team already has. Every fetch is a read-through cache
// (repo_cache): the page asks for what it wants, an action refreshes the row if
// it is stale, and the query answers from the row. Nothing here syncs to the
// client store — these pages are read per view, and a repository is far too
// large to mirror.
//
// Freshness is per kind, and the one rule worth stating: content addressed by a
// full commit sha never changes, so it is cached forever. Everything reached by
// a branch name is cached for minutes, because a branch moves.

import { v } from "convex/values";
import { action, query, internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { requireUser } from "./lib/auth";
import { canAccessCommit, canAccessConversation, canAccessPullRequest, canAccessTask, isTeamMember } from "./lib/access";

const MINUTE = 60 * 1000;
const TTL: Record<string, number> = {
  branches: 2 * MINUTE,
  branchdetails: 2 * MINUTE,
  tree: 10 * MINUTE,
  blob: 10 * MINUTE,
  log: 2 * MINUTE,
  blame: 60 * MINUTE,
  compare: 10 * MINUTE,
  meta: 10 * MINUTE,
  tags: 2 * MINUTE,
  readme: 10 * MINUTE,
  lastcommits: 10 * MINUTE,
  search: 5 * MINUTE,
  pulls: 2 * MINUTE,
};

/** How long the public route trusts a cached visibility answer. */
export const META_VISIBILITY_TTL = 10 * MINUTE;

const FULL_SHA = /^[0-9a-f]{40}$/i;

/** How long a cached answer stays good. Content pinned to a sha never moves. */
export function ttlFor(kind: string, ref: string, path = ""): number {
  if (FULL_SHA.test(ref) && (kind !== "compare" || FULL_SHA.test(path))) return Number.POSITIVE_INFINITY;
  return TTL[kind] ?? 5 * MINUTE;
}

function isFresh(row: { kind: string; ref: string; path?: string; fetched_at: number } | null, now: number): boolean {
  if (!row) return false;
  return now - row.fetched_at < ttlFor(row.kind, row.ref, row.path);
}

// ── Which repositories a person may browse ──

/**
 * The installation a user may use for a repository, or null.
 *
 * The one predicate behind every read here, mirroring githubApp's rule: the
 * installation must cover the repository, must not be suspended, and the caller
 * must belong to the team that owns it.
 */
async function installationForUser(
  ctx: { db: any },
  userId: Id<"users">,
  repository: string,
): Promise<{ team_id: Id<"teams">; installation_id: number } | null> {
  const [owner] = repository.split("/");
  const installations = await ctx.db
    .query("github_app_installations")
    .withIndex("by_account_login", (q: any) => q.eq("account_login", owner))
    .collect();

  for (const candidate of installations) {
    if (candidate.suspended_at) continue;
    if (
      candidate.repository_selection === "selected" &&
      !candidate.repositories?.some((r: any) => r.full_name === repository)
    ) continue;
    if (!(await isTeamMember(ctx, userId, candidate.team_id))) continue;
    return { team_id: candidate.team_id, installation_id: candidate.installation_id };
  }
  return null;
}

/**
 * The installation covering a repository, with nobody asking.
 *
 * The public route has no viewer to check membership against, so this is
 * deliberately the same rule as installationForUser minus the team test. It
 * grants nothing on its own: it only says which credential can reach GitHub,
 * and the route decides separately whether the repository may be shown.
 */
async function installationForRepository(
  ctx: { db: any },
  repository: string,
): Promise<{ team_id: Id<"teams">; installation_id: number } | null> {
  const [owner] = repository.split("/");
  const installations = await ctx.db
    .query("github_app_installations")
    .withIndex("by_account_login", (q: any) => q.eq("account_login", owner))
    .collect();

  for (const candidate of installations) {
    if (candidate.suspended_at) continue;
    if (
      candidate.repository_selection === "selected" &&
      !candidate.repositories?.some((r: any) => r.full_name === repository)
    ) continue;
    return { team_id: candidate.team_id, installation_id: candidate.installation_id };
  }
  return null;
}

async function repositoriesForUser(ctx: { db: any }, userId: Id<"users">) {
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();

  const found = new Map<string, { repository: string; team_id: Id<"teams">; installed: boolean }>();
  for (const membership of memberships) {
    const installations = await ctx.db
      .query("github_app_installations")
      .withIndex("by_team_id", (q: any) => q.eq("team_id", membership.team_id))
      .collect();

    for (const installation of installations) {
      if (installation.suspended_at) continue;
      for (const repo of installation.repositories ?? []) {
        found.set(repo.full_name, { repository: repo.full_name, team_id: membership.team_id, installed: true });
      }
    }

    // An installation with access to every repository lists none, so the
    // repositories we actually know about are the ones activity has named.
    const prs = await ctx.db
      .query("pull_requests")
      .withIndex("by_team_id", (q: any) => q.eq("team_id", membership.team_id))
      .take(500);
    const commits = await ctx.db
      .query("commits")
      .withIndex("by_team_timestamp", (q: any) => q.eq("team_id", membership.team_id))
      .order("desc")
      .take(500);

    for (const row of [...prs, ...commits]) {
      if (!row.repository || found.has(row.repository)) continue;
      found.set(row.repository, { repository: row.repository, team_id: membership.team_id, installed: false });
    }
  }
  return [...found.values()].sort((a, b) => a.repository.localeCompare(b.repository));
}

export const listRepositories = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    return await repositoriesForUser(ctx, userId);
  },
});

/**
 * Actions carry no database and internal queries carry no identity, so the
 * action resolves the caller and passes them in here.
 */
export const repoAccess = internalQuery({
  args: {
    repository: v.string(),
    user_id: v.id("users"),
  },
  handler: async (ctx, args): Promise<{ team_id: Id<"teams">; installation_id: number } | null> => {
    return await installationForUser(ctx, args.user_id, args.repository);
  },
});

export const repoAccessPublic = internalQuery({
  args: { repository: v.string() },
  handler: async (ctx, args): Promise<{ team_id: Id<"teams">; installation_id: number } | null> => {
    return await installationForRepository(ctx, args.repository);
  },
});

/** Does this viewer have any way to browse this repository? */
export const canBrowse = query({
  args: { repository: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return false;
    return !!(await installationForUser(ctx, userId, args.repository));
  },
});

export const getCacheRow = internalQuery({
  args: {
    repository: v.string(),
    kind: v.string(),
    ref: v.string(),
    path: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("repo_cache")
      .withIndex("by_key", (q) =>
        q.eq("repository", args.repository).eq("kind", args.kind).eq("ref", args.ref).eq("path", args.path))
      .first();
  },
});

export const upsertCache = internalMutation({
  args: {
    team_id: v.id("teams"),
    repository: v.string(),
    kind: v.string(),
    ref: v.string(),
    path: v.string(),
    sha: v.optional(v.string()),
    content: v.string(),
    size: v.optional(v.number()),
    truncated: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("repo_cache")
      .withIndex("by_key", (q) =>
        q.eq("repository", args.repository).eq("kind", args.kind).eq("ref", args.ref).eq("path", args.path))
      .first();

    const row = {
      team_id: args.team_id,
      repository: args.repository,
      kind: args.kind,
      ref: args.ref,
      path: args.path,
      sha: args.sha,
      content: args.content,
      size: args.size,
      truncated: args.truncated,
      fetched_at: Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, row);
      return existing._id;
    }
    return await ctx.db.insert("repo_cache", row);
  },
});

/** Cached repository content is disposable: anything a week old is refetched. */
export const pruneRepoCache = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - 7 * 24 * 60 * MINUTE;

    // Ordered by fetched_at and bounded at the cutoff, so the sweep reads only
    // rows it is about to delete. The unordered scan this replaces walked the
    // table in creation order: a row created long ago but refreshed every day
    // sits at the head forever, so every sweep re-read the same live rows and
    // the genuinely stale ones further in were never reached.
    const expired = await ctx.db
      .query("repo_cache")
      .withIndex("by_fetched", (q) => q.lt("fetched_at", cutoff))
      // Ascending is already the default, said out loud because the whole point
      // is to take the OLDEST first: a limited sweep that took an arbitrary
      // slice would leave the worst rows for a next run that never picks them.
      .order("asc")
      .take(args.limit ?? 500);

    for (const row of expired) await ctx.db.delete(row._id);
    return { deleted: expired.length, scanned: expired.length };
  },
});

// ── The refresh actions ──
//
// Every kind is one entry in refreshSpec: where it is cached and how it is
// fetched. Two callers walk that table — the viewer-facing ensure actions
// below, and the public route, which is the same refresh through a different
// credential. Adding a kind means adding one case, not a second copy of the
// caching, the freshness rule and the upsert.

type Refresh = {
  kind: string;
  ref: string;
  path: string;
  fetch: (token: string) => Promise<{ payload: any; sha?: string; size?: number; truncated?: boolean }>;
};

/** Everything any kind might need. Each case reads only its own fields. */
type SpecParams = {
  ref?: string;
  path?: string;
  page?: number;
  per_page?: number;
  author?: string;
  recursive?: boolean;
  base?: string;
  head?: string;
  q?: string;
  state?: string;
  paths?: string[];
  tree_ref?: string;
};

const specArgs = {
  ref: v.optional(v.string()),
  path: v.optional(v.string()),
  page: v.optional(v.number()),
  per_page: v.optional(v.number()),
  author: v.optional(v.string()),
  recursive: v.optional(v.boolean()),
  base: v.optional(v.string()),
  head: v.optional(v.string()),
  q: v.optional(v.string()),
  state: v.optional(v.string()),
  paths: v.optional(v.array(v.string())),
  tree_ref: v.optional(v.string()),
};

/**
 * The entry names in one directory, for the last-commit column.
 *
 * The walk the source page does has already cached the tree it is looking at,
 * so the names are usually free. A caller that has no cached tree (the public
 * route, which is handed a ref and a path and nothing else) leaves them unset
 * and GitHub resolves the directory instead.
 */
async function directoryEntryNames(
  ctx: any,
  repository: string,
  params: SpecParams,
): Promise<string[] | undefined> {
  if (params.paths) return params.paths;

  // A cached tree row is keyed by the tree's OWN sha. The commit-ish alone
  // therefore reaches the root tree and nothing below it: reading the root row
  // for a subdirectory would name the root's entries and prefix them with the
  // subdirectory, which is a list of paths that do not exist. A caller that has
  // already walked down passes the sha it arrived at as tree_ref; one that has
  // not leaves the names unresolved and GitHub lists the directory instead.
  const dir = params.path ?? "";
  const treeRef = params.tree_ref ?? (dir === "" ? params.ref : undefined);
  if (!treeRef) return undefined;

  const row = await ctx.runQuery(internal.repos.getCacheRow, {
    repository,
    kind: "tree",
    ref: treeRef,
    path: "",
  });
  if (!row) return undefined;

  const entries = JSON.parse(row.content)?.entries ?? [];
  return entries.map((entry: any) => (dir ? `${dir}/${entry.path}` : entry.path));
}

function refreshSpec(ctx: any, repository: string, kind: string, params: SpecParams): Refresh {
  const ref = params.ref ?? "-";
  const path = params.path ?? "";
  const page = params.page ?? 1;
  const call = (name: string, extra: Record<string, unknown>) => async (token: string) => ({
    payload: await ctx.runAction((internal.githubApi as any)[name], {
      repository,
      github_access_token: token,
      ...extra,
    }),
  });

  switch (kind) {
    case "branches":
      return { kind, ref: "-", path: "", fetch: call("listBranches", {}) };

    case "branchdetails":
      return { kind, ref: "-", path: "", fetch: call("listBranchDetails", {}) };

    case "meta":
      return { kind, ref: "-", path: "", fetch: call("getRepoMeta", {}) };

    case "tags":
      return { kind, ref: "-", path: "", fetch: call("listTags", {}) };

    case "readme":
      return {
        kind,
        ref,
        path: "",
        // A repository with no README is an ordinary answer, and the cache
        // stores objects, so "there isn't one" is a field rather than a null
        // row that a reader cannot tell from a cache miss.
        fetch: async (token) => {
          const data = await ctx.runAction(internal.githubApi.getReadme, {
            repository,
            ref,
            github_access_token: token,
          });
          return { payload: data ? { found: true, ...data } : { found: false }, sha: data?.sha };
        },
      };

    case "tree":
      return {
        kind,
        ref,
        path: params.recursive ? "**" : "",
        fetch: async (token) => {
          const data = await ctx.runAction(internal.githubApi.getTree, {
            repository,
            ref,
            recursive: params.recursive,
            github_access_token: token,
          });
          return { payload: data, sha: data.sha, truncated: data.truncated };
        },
      };

    case "blob":
      return {
        kind,
        ref,
        path,
        fetch: async (token) => {
          const data = await ctx.runAction(internal.githubApi.getBlob, {
            repository,
            ref,
            path,
            github_access_token: token,
          });
          return { payload: data, sha: data.sha, size: data.size, truncated: data.truncated };
        },
      };

    case "log":
      return {
        kind,
        ref,
        path: `${path}#${page}#${params.author ?? ""}`,
        fetch: call("listCommits", {
          sha: ref,
          path: path || undefined,
          per_page: 30,
          page,
          author: params.author,
        }),
      };

    case "blame":
      return { kind, ref, path, fetch: call("getBlame", { ref, path }) };

    case "lastcommits":
      return {
        kind,
        ref,
        path,
        fetch: async (token) => ({
          payload: await ctx.runAction(internal.githubApi.lastCommitsForPaths, {
            repository,
            ref,
            dir: path,
            paths: await directoryEntryNames(ctx, repository, params),
            github_access_token: token,
          }),
        }),
      };

    case "compare":
      return {
        kind,
        ref: params.base ?? "-",
        path: params.head ?? "",
        fetch: call("compare", { base: params.base, head: params.head }),
      };

    case "search":
      return {
        kind,
        ref: "-",
        path: `scoped-v2:${params.q ?? ""}#${page}`,
        fetch: call("searchCode", { q: params.q, page }),
      };

    case "pulls":
      return {
        kind,
        ref: params.state ?? "open",
        path: `#${page}`,
        fetch: call("listPulls", { state: params.state ?? "open", page }),
      };

    default:
      throw new Error(`Unknown repository read: ${kind}`);
  }
}

/** The installation covering a repository the caller is allowed to browse. */
async function requireRepoAccess(ctx: any, repository: string): Promise<any> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Unauthorized");

  const access = await ctx.runQuery(internal.repos.repoAccess, { repository, user_id: userId });
  if (!access) throw new Error(`No GitHub App installation you can use covers ${repository}`);
  return access;
}

/**
 * Minted only once the caller has decided it needs GitHub. Every read-through
 * here checks what it already has first, so a cache hit costs no token call.
 */
async function installationToken(ctx: any, access: any): Promise<string> {
  const tokenResult = await ctx.runAction(internal.githubApp.getInstallationToken, {
    installation_id: access.installation_id,
  });
  return tokenResult.token;
}

/**
 * Refresh one cache row if it has gone stale, using an already-resolved
 * installation. The access decision happens above this, which is what lets the
 * viewer path and the public path share one body.
 */
async function fillCache(
  ctx: any,
  repository: string,
  access: { team_id: Id<"teams">; installation_id: number },
  spec: Refresh,
): Promise<{ cached: boolean }> {
  const cached = await ctx.runQuery(internal.repos.getCacheRow, {
    repository,
    kind: spec.kind,
    ref: spec.ref,
    path: spec.path,
  });
  if (isFresh(cached, Date.now())) return { cached: true };

  const result = await spec.fetch(await installationToken(ctx, access));

  await ctx.runMutation(internal.repos.upsertCache, {
    team_id: access.team_id,
    repository,
    kind: spec.kind,
    ref: spec.ref,
    path: spec.path,
    sha: result.sha,
    content: JSON.stringify(result.payload),
    size: result.size,
    truncated: result.truncated,
  });
  return { cached: false };
}

async function ensureCached(ctx: any, repository: string, spec: Refresh): Promise<{ cached: boolean }> {
  return await fillCache(ctx, repository, await requireRepoAccess(ctx, repository), spec);
}

/** One ensure action per kind, so the client keeps naming what it wants. */
function ensureAction(kind: string) {
  return action({
    args: { repository: v.string(), ...specArgs },
    handler: async (ctx, args): Promise<{ cached: boolean }> => {
      return await ensureCached(ctx, args.repository, refreshSpec(ctx, args.repository, kind, args));
    },
  });
}

export const ensureBranches = ensureAction("branches");
export const ensureBranchDetails = ensureAction("branchdetails");
export const ensureMeta = ensureAction("meta");
export const ensureTags = ensureAction("tags");
export const ensureReadme = ensureAction("readme");
export const ensureTree = ensureAction("tree");
export const ensureBlob = ensureAction("blob");
export const ensureLog = ensureAction("log");
export const ensureBlame = ensureAction("blame");
export const ensureLastCommits = ensureAction("lastcommits");
export const ensureCompare = ensureAction("compare");
export const ensureSearch = ensureAction("search");
export const ensurePulls = ensureAction("pulls");

/**
 * The same refresh, reached without a viewer.
 *
 * Internal only: the public HTTP route calls it after it has established that
 * the repository is public, and nothing else may. The credential comes from
 * whichever installation covers the repository rather than from the caller,
 * because on this path there is no caller.
 */
export const ensureCachedPublic = internalAction({
  args: { repository: v.string(), kind: v.string(), ...specArgs },
  handler: async (ctx, args): Promise<{ cached: boolean; installed: boolean }> => {
    const access = await ctx.runQuery(internal.repos.repoAccessPublic, { repository: args.repository });
    if (!access) return { cached: false, installed: false };

    const spec = refreshSpec(ctx, args.repository, args.kind, args);
    return { ...(await fillCache(ctx, args.repository, access, spec)), installed: true };
  },
});

/**
 * What the public route knows about a repository's visibility.
 *
 * `known` false means nothing has ever been cached and the route must refresh
 * before it can answer; `stale` means the answer is older than the route
 * trusts. Reporting both separately is what keeps "never seen" from being
 * silently treated as "public".
 */
export const repoVisibility = internalQuery({
  args: { repository: v.string() },
  handler: async (ctx, args): Promise<{ known: boolean; private: boolean; stale: boolean }> => {
    const row = await ctx.db
      .query("repo_cache")
      .withIndex("by_key", (q) =>
        q.eq("repository", args.repository).eq("kind", "meta").eq("ref", "-").eq("path", ""))
      .first();
    if (!row) return { known: false, private: true, stale: true };

    const meta = JSON.parse(row.content);
    return {
      known: true,
      private: meta?.private !== false,
      stale: Date.now() - row.fetched_at >= META_VISIBILITY_TTL,
    };
  },
});

/**
 * A cache row read with no identity at all.
 *
 * Deliberately joins nothing. Every viewer-facing query below enriches its
 * answer with what codecast knows — sessions, tasks, pull requests — and none
 * of that may leave through a route that never asked who is reading.
 */
export const publicRead = internalQuery({
  args: { repository: v.string(), kind: v.string(), ref: v.string(), path: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("repo_cache")
      .withIndex("by_key", (q) =>
        q.eq("repository", args.repository).eq("kind", args.kind).eq("ref", args.ref).eq("path", args.path))
      .first();
    if (!row) return null;
    return { ...JSON.parse(row.content), _fetched_at: row.fetched_at, _stale: !isFresh(row, Date.now()) };
  },
});

/**
 * Where a kind lands in the cache, for a caller that holds only params.
 *
 * The public route has to read the same row the refresh just wrote, and the
 * key rules are per kind and fiddly (a log page carries its page and author in
 * the path, a compare carries the head there). Deriving the key from the one
 * table means the route can never drift from the writer. The fetch closure is
 * built and discarded unused, so the context it would have needed is not.
 */
export function cacheKeyFor(kind: string, params: SpecParams): { ref: string; path: string } {
  const spec = refreshSpec(null as any, "", kind, params);
  return { ref: spec.ref, path: spec.path };
}

// ── The reads ──

async function readCache(ctx: any, repository: string, kind: string, ref: string, path: string) {
  const userId = await requireUser(ctx);
  if (!(await installationForUser(ctx, userId, repository))) return null;

  const row = await ctx.db
    .query("repo_cache")
    .withIndex("by_key", (q: any) =>
      q.eq("repository", repository).eq("kind", kind).eq("ref", ref).eq("path", path))
    .first();
  if (!row) return null;

  return {
    ...JSON.parse(row.content),
    _fetched_at: row.fetched_at,
    _stale: !isFresh(row, Date.now()),
  };
}

/**
 * Fill in one commit's diff, once.
 *
 * A commit ingested from a push has no patch in it, so the commit page has
 * nothing to render. This fetches the diff and writes it onto the commit row
 * rather than into repo_cache: a sha never moves, so the answer is permanent
 * and every reader of that commit benefits, not just the page that asked.
 *
 * A sha with no commit row is reported rather than invented. The row is created
 * by ingest, which knows the provenance that decides who may read it. A row that
 * came from a transcript and never learned its remote is still filled in, and
 * learns the remote in the process.
 */
export const ensureCommitFiles = action({
  args: { repository: v.string(), sha: v.string() },
  handler: async (ctx, args): Promise<{ fetched: boolean; reason?: string }> => {
    const access = await requireRepoAccess(ctx, args.repository);

    const state = await ctx.runQuery(internal.commits.commitFilesState, {
      repository: args.repository,
      sha: args.sha,
    });
    if (!state) return { fetched: false, reason: "unknown_commit" };
    if (state.has_files) return { fetched: false, reason: "already_present" };

    const data = await ctx.runAction(internal.githubApi.getCommit, {
      repository: args.repository,
      sha: args.sha,
      github_access_token: await installationToken(ctx, access),
    });

    await ctx.runMutation(internal.commits.applyCommitFiles, {
      commit_id: state.commit_id,
      files: data.files,
      additions: data.additions,
      deletions: data.deletions,
      author_login: data.author_login,
      author_avatar_url: data.author_avatar_url,
      repository: state.needs_repository ? args.repository : undefined,
    });
    return { fetched: true };
  },
});

/**
 * The plain read for a kind: same key rules as its ensure, one line each.
 * Only the two kinds that join codecast's own rows are written out below.
 */
function readAction(kind: string) {
  return query({
    args: { repository: v.string(), ...specArgs },
    handler: async (ctx, args) => {
      const { ref, path } = cacheKeyFor(kind, args);
      return await readCache(ctx, args.repository, kind, ref, path);
    },
  });
}

export const getBranches = readAction("branches");
export const getBranchDetails = readAction("branchdetails");
export const getMeta = readAction("meta");
export const getTags = readAction("tags");
export const getReadme = readAction("readme");
export const getTree = readAction("tree");
export const getBlob = readAction("blob");
export const getBlame = readAction("blame");
export const getLastCommits = readAction("lastcommits");
export const getCompare = readAction("compare");
export const getSearch = readAction("search");

/**
 * A page of history, with each commit already joined to what codecast knows
 * about it: the session that wrote it, the tasks it names, the pull request it
 * belongs to. The page renders links straight from this, with no second pass.
 */
export const getLog = query({
  args: {
    repository: v.string(),
    ref: v.string(),
    path: v.optional(v.string()),
    page: v.optional(v.number()),
    author: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { ref, path } = cacheKeyFor("log", args);
    const cached = await readCache(ctx, args.repository, "log", ref, path);
    if (!cached) return null;
    const userId = await requireUser(ctx);

    const commits = [];
    for (const commit of cached.commits ?? []) {
      const candidates = await ctx.db
        .query("commits")
        .withIndex("by_sha", (q) => q.eq("sha", commit.sha))
        .collect();
      let row = null;
      for (const candidate of candidates) {
        if (candidate.repository === args.repository && await canAccessCommit(ctx, userId, candidate)) {
          row = candidate;
          break;
        }
      }

      const tasks = [];
      for (const taskId of row?.task_ids ?? []) {
        const task = await ctx.db.get(taskId);
        if (task && await canAccessTask(ctx, userId, task)) {
          tasks.push({ _id: task._id, short_id: task.short_id, title: task.title });
        }
      }

      let session = null;
      if (row?.conversation_id) {
        const conversation = await ctx.db.get(row.conversation_id);
        if (conversation && await canAccessConversation(ctx, userId, conversation)) {
          session = { _id: conversation._id, title: conversation.title };
        }
      }

      commits.push({
        ...commit,
        conversation_id: session?._id ?? null,
        session,
        tasks,
        pr_number: row?.pr_number ?? null,
      });
    }

    return { ...cached, commits };
  },
});

/**
 * A page of pull requests, each joined to what codecast knows about it.
 *
 * GitHub's own list answers the pull request; the codecast row answers what is
 * happening to it here — which session is shepherding it, what the folded
 * review and checks state is. Both come back in one read, so the page needs no
 * second pass, and a pull request codecast has never seen simply carries none
 * of it.
 */
export const getPulls = query({
  args: { repository: v.string(), state: v.optional(v.string()), page: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { ref, path } = cacheKeyFor("pulls", args);
    const cached = await readCache(ctx, args.repository, "pulls", ref, path);
    if (!cached) return null;
    const userId = await requireUser(ctx);

    const pulls = [];
    for (const pull of cached.pulls ?? []) {
      const candidates = await ctx.db
        .query("pull_requests")
        .withIndex("by_repository_number", (q) =>
          q.eq("repository", args.repository).eq("number", pull.number))
        .collect();
      let row = null;
      for (const candidate of candidates) {
        if (await canAccessPullRequest(ctx, userId, candidate)) {
          row = candidate;
          break;
        }
      }
      const conversation = row?.shepherd_conversation_id ? await ctx.db.get(row.shepherd_conversation_id) : null;
      const conversationId = conversation && await canAccessConversation(ctx, userId, conversation)
        ? conversation._id : null;

      pulls.push({
        ...pull,
        conversation_id: conversationId,
        shepherd_enabled: row?.shepherd_enabled ?? null,
        shepherd_state: row?.shepherd_state ?? null,
        checks_state: row?.checks_state ?? null,
        review_decision: row?.review_decision ?? null,
      });
    }

    return { ...cached, pulls };
  },
});
