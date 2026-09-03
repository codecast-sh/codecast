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
import { action, query, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { requireUser } from "./lib/auth";
import { isTeamMember } from "./lib/access";

const MINUTE = 60 * 1000;
const TTL: Record<string, number> = {
  branches: 2 * MINUTE,
  tree: 10 * MINUTE,
  blob: 10 * MINUTE,
  log: 2 * MINUTE,
  blame: 60 * MINUTE,
  compare: 10 * MINUTE,
};

const FULL_SHA = /^[0-9a-f]{40}$/i;

/** How long a cached answer stays good. Content pinned to a sha never moves. */
function ttlFor(kind: string, ref: string): number {
  if (FULL_SHA.test(ref)) return Number.POSITIVE_INFINITY;
  return TTL[kind] ?? 5 * MINUTE;
}

function isFresh(row: { kind: string; ref: string; fetched_at: number } | null, now: number): boolean {
  if (!row) return false;
  return now - row.fetched_at < ttlFor(row.kind, row.ref);
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
    const oldest = await ctx.db.query("repo_cache").take(args.limit ?? 500);
    let deleted = 0;
    for (const row of oldest) {
      if (row.fetched_at >= cutoff) continue;
      await ctx.db.delete(row._id);
      deleted++;
    }
    return { deleted, scanned: oldest.length };
  },
});

// ── The refresh actions ──

type Refresh = {
  kind: string;
  ref: string;
  path: string;
  fetch: (token: string) => Promise<{ payload: any; sha?: string; size?: number; truncated?: boolean }>;
};

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

async function ensureCached(ctx: any, repository: string, spec: Refresh): Promise<{ cached: boolean }> {
  const access = await requireRepoAccess(ctx, repository);

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

export const ensureBranches = action({
  args: { repository: v.string() },
  handler: async (ctx, args): Promise<{ cached: boolean }> => {
    return await ensureCached(ctx, args.repository, {
      kind: "branches",
      ref: "-",
      path: "",
      fetch: async (token) => ({
        payload: await ctx.runAction(internal.githubApi.listBranches, {
          repository: args.repository,
          github_access_token: token,
        }),
      }),
    });
  },
});

export const ensureTree = action({
  args: { repository: v.string(), ref: v.string(), recursive: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ cached: boolean }> => {
    return await ensureCached(ctx, args.repository, {
      kind: "tree",
      ref: args.ref,
      path: args.recursive ? "**" : "",
      fetch: async (token) => {
        const data = await ctx.runAction(internal.githubApi.getTree, {
          repository: args.repository,
          ref: args.ref,
          recursive: args.recursive,
          github_access_token: token,
        });
        return { payload: data, sha: data.sha, truncated: data.truncated };
      },
    });
  },
});

export const ensureBlob = action({
  args: { repository: v.string(), ref: v.string(), path: v.string() },
  handler: async (ctx, args): Promise<{ cached: boolean }> => {
    return await ensureCached(ctx, args.repository, {
      kind: "blob",
      ref: args.ref,
      path: args.path,
      fetch: async (token) => {
        const data = await ctx.runAction(internal.githubApi.getBlob, {
          repository: args.repository,
          ref: args.ref,
          path: args.path,
          github_access_token: token,
        });
        return { payload: data, sha: data.sha, size: data.size, truncated: data.truncated };
      },
    });
  },
});

export const ensureLog = action({
  args: {
    repository: v.string(),
    ref: v.string(),
    path: v.optional(v.string()),
    per_page: v.optional(v.number()),
    page: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ cached: boolean }> => {
    return await ensureCached(ctx, args.repository, {
      kind: "log",
      ref: args.ref,
      path: `${args.path ?? ""}#${args.page ?? 1}`,
      fetch: async (token) => ({
        payload: await ctx.runAction(internal.githubApi.listCommits, {
          repository: args.repository,
          sha: args.ref,
          path: args.path,
          per_page: args.per_page,
          page: args.page,
          github_access_token: token,
        }),
      }),
    });
  },
});

export const ensureBlame = action({
  args: { repository: v.string(), ref: v.string(), path: v.string() },
  handler: async (ctx, args): Promise<{ cached: boolean }> => {
    return await ensureCached(ctx, args.repository, {
      kind: "blame",
      ref: args.ref,
      path: args.path,
      fetch: async (token) => ({
        payload: await ctx.runAction(internal.githubApi.getBlame, {
          repository: args.repository,
          ref: args.ref,
          path: args.path,
          github_access_token: token,
        }),
      }),
    });
  },
});

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

export const getBranches = query({
  args: { repository: v.string() },
  handler: async (ctx, args) => await readCache(ctx, args.repository, "branches", "-", ""),
});

export const getTree = query({
  args: { repository: v.string(), ref: v.string(), recursive: v.optional(v.boolean()) },
  handler: async (ctx, args) =>
    await readCache(ctx, args.repository, "tree", args.ref, args.recursive ? "**" : ""),
});

export const getBlob = query({
  args: { repository: v.string(), ref: v.string(), path: v.string() },
  handler: async (ctx, args) => await readCache(ctx, args.repository, "blob", args.ref, args.path),
});

export const getBlame = query({
  args: { repository: v.string(), ref: v.string(), path: v.string() },
  handler: async (ctx, args) => await readCache(ctx, args.repository, "blame", args.ref, args.path),
});

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
  },
  handler: async (ctx, args) => {
    const cached = await readCache(
      ctx,
      args.repository,
      "log",
      args.ref,
      `${args.path ?? ""}#${args.page ?? 1}`,
    );
    if (!cached) return null;

    const commits = [];
    for (const commit of cached.commits ?? []) {
      const row = await ctx.db
        .query("commits")
        .withIndex("by_sha", (q) => q.eq("sha", commit.sha))
        .first();

      const tasks = [];
      for (const taskId of row?.task_ids ?? []) {
        const task = await ctx.db.get(taskId);
        if (task) tasks.push({ _id: task._id, short_id: task.short_id, title: task.title });
      }

      let session = null;
      if (row?.conversation_id) {
        const conversation = await ctx.db.get(row.conversation_id);
        if (conversation) session = { _id: conversation._id, title: conversation.title };
      }

      commits.push({
        ...commit,
        conversation_id: row?.conversation_id ?? null,
        session,
        tasks,
        pr_number: row?.pr_number ?? null,
      });
    }

    return { ...cached, commits };
  },
});
