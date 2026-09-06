// Browsing a repository from codecast.
//
// The source, history and blame pages read from one cache (repo_cache) that is
// filled from two directions. A team member's daemon fills it from their local
// checkout (ingestLocal): branches, tags, history, the root tree and the readme
// arrive whenever the refs move, in the same shapes GitHub answers with, and
// anything deeper is asked of the checkout on demand (requestLocalRead). GitHub,
// through the App installation the repository's team has, fills it too: on
// demand when nobody publishes a checkout, and as the fallback when every
// checkout declines a read or none answers in time. The checkout comes first
// because it is where the work is: a commit that is not pushed yet, a branch
// measured against its upstream, a file at a local ref exist there and nowhere
// else, and GitHub can only answer for what has already left the machine.
// Every page reads the same rows whichever side wrote them. Nothing here syncs
// to the client store — these pages are read per view, and a repository is far
// too large to mirror.
//
// Freshness is per kind, and the one rule worth stating: content addressed by a
// full commit sha never changes, so it is cached forever. Everything reached by
// a branch name is cached for minutes, because a branch moves.

import { v } from "convex/values";
import { action, mutation, query, internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { requireUser } from "./lib/auth";
import { canAccessCommit, canAccessConversation, canAccessPullRequest, canAccessTask, isTeamMember } from "./lib/access";
import { normalizeRepository, repositoryOwner } from "./lib/gitRefs";
import { installationCoversRepo } from "./githubApp";
import { getAuthenticatedUserId } from "./pendingMessages";
import { resolveCreationPrivacy } from "./privacy";
import { applyCommitFilesTo } from "./commits";
import { matchFileLines, newResolveCaches, resolveCommitSessions } from "./blame";
import { contentLinesToMatch } from "@codecast/shared/blame";

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
  for (const candidate of await installationsForOwner(ctx, repository)) {
    if (!installationCoversRepo(candidate, repository)) continue;
    if (!(await isTeamMember(ctx, userId, candidate.team_id))) continue;
    return { team_id: candidate.team_id, installation_id: candidate.installation_id };
  }
  return null;
}

/** The installations under a repository's owner, by the canonical owner spelling. */
async function installationsForOwner(ctx: { db: any }, repository: string) {
  return await ctx.db
    .query("github_app_installations")
    .withIndex("by_account_login", (q: any) => q.eq("account_login", repositoryOwner(repository)))
    .collect();
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
  for (const candidate of await installationsForOwner(ctx, repository)) {
    if (!installationCoversRepo(candidate, repository)) continue;
    return { team_id: candidate.team_id, installation_id: candidate.installation_id };
  }
  return null;
}

/** The checkouts publishing a repository (repos.ingestLocal), whichever team they belong to. */
async function localSourcesFor(ctx: { db: any }, repository: string) {
  const rows = await ctx.db
    .query("repo_sources")
    .withIndex("by_repository", (q: any) => q.eq("repository", normalizeRepository(repository)))
    .collect();
  return rows.filter((row: any) => row.enabled);
}

/**
 * How a viewer may browse a repository, or null.
 *
 * Two ways in, and a viewer may hold both: a teammate's local checkout that
 * publishes the repository (`local_team_id`, the team it publishes to), and
 * the GitHub App installation their team has (`installation_id`, which also
 * carries the credential that fetches from GitHub). Reads prefer the checkout
 * and fall back to the installation; `source` names which of the two admits
 * the viewer at all, and `team_id` stamps the rows GitHub writes.
 */
export type BrowseAccess = {
  team_id: Id<"teams">;
  installation_id?: number;
  source: "installation" | "local";
  local_team_id?: Id<"teams">;
};

async function browseAccessForUser(
  ctx: { db: any },
  userId: Id<"users">,
  repository: string,
): Promise<BrowseAccess | null> {
  let local_team_id: Id<"teams"> | undefined;
  for (const source of await localSourcesFor(ctx, repository)) {
    if (await isTeamMember(ctx, userId, source.team_id)) { local_team_id = source.team_id; break; }
  }
  const installation = await installationForUser(ctx, userId, repository);
  if (installation) return { ...installation, source: "installation", local_team_id };
  if (local_team_id) return { team_id: local_team_id, source: "local", local_team_id };
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
      // Keyed by the canonical spelling so a display-case entry and the rows
      // activity wrote are one repository; the display name is what is shown.
      for (const repo of installation.repositories ?? []) {
        found.set(normalizeRepository(repo.full_name), { repository: repo.full_name, team_id: membership.team_id, installed: true });
      }
    }

    // Repositories teammates publish from their own checkouts need no
    // installation at all; they are browsable from the cache the daemon fills.
    const sources = await ctx.db
      .query("repo_sources")
      .withIndex("by_team_id", (q: any) => q.eq("team_id", membership.team_id))
      .collect();
    for (const source of sources) {
      if (!source.enabled || found.has(source.repository)) continue;
      found.set(source.repository, { repository: source.repository, team_id: membership.team_id, installed: false });
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
      const key = normalizeRepository(row.repository);
      if (!key || found.has(key)) continue;
      found.set(key, { repository: row.repository, team_id: membership.team_id, installed: false });
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
  handler: async (ctx, args): Promise<BrowseAccess | null> => {
    return await browseAccessForUser(ctx, args.user_id, args.repository);
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
    return !!(await browseAccessForUser(ctx, userId, args.repository));
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
    return await cacheRowByKey(ctx, args.repository, args.kind, args.ref, args.path);
  },
});

/** The one cache lookup: the key's repository is the canonical spelling. */
async function cacheRowByKey(ctx: { db: any }, repository: string, kind: string, ref: string, path: string) {
  return await ctx.db
    .query("repo_cache")
    .withIndex("by_key", (q: any) =>
      q.eq("repository", normalizeRepository(repository)).eq("kind", kind).eq("ref", ref).eq("path", path))
    .first();
}

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
    return await writeCacheRow(ctx, args);
  },
});

/** The one cache write: a row is replaced whole under its key, stamped now. */
async function writeCacheRow(
  ctx: { db: any },
  args: { team_id: Id<"teams">; repository: string; kind: string; ref: string; path: string; sha?: string; content: string; size?: number; truncated?: boolean },
) {
  const existing = await cacheRowByKey(ctx, args.repository, args.kind, args.ref, args.path);

  const row = {
    team_id: args.team_id,
    repository: normalizeRepository(args.repository),
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
}

/** One row as the daemon pushes it: the same key and payload a GitHub refresh would write. */
const localRow = v.object({
  kind: v.string(),
  ref: v.string(),
  path: v.string(),
  sha: v.optional(v.string()),
  content: v.string(),
  size: v.optional(v.number()),
  truncated: v.optional(v.boolean()),
});

/** The kinds a checkout can answer; code search is the one read that needs GitHub. */
const LOCAL_KINDS = new Set(["meta", "branches", "branchdetails", "tags", "readme", "tree", "log", "lastcommits", "blob", "blame", "compare"]);

/** How long a failed answer stands before a page asking again re-opens the request. */
const LOCAL_READ_RETRY_MS = 60 * 1000;

const commitFiles = v.object({
  files: v.array(v.object({
    filename: v.string(),
    status: v.string(),
    additions: v.number(),
    deletions: v.number(),
    changes: v.number(),
    patch: v.optional(v.string()),
  })),
  additions: v.number(),
  deletions: v.number(),
});

/** How long the checkouts get before GitHub is asked instead, when it can be. */
export const LOCAL_READ_GRACE_MS = 10 * 1000;

async function readRequestByKey(ctx: { db: any }, args: { repository: string; kind: string; ref: string; path: string }) {
  const repository = normalizeRepository(args.repository);
  return await ctx.db
    .query("repo_read_requests")
    .withIndex("by_key", (q: any) => q.eq("repository", repository).eq("kind", args.kind).eq("ref", args.ref).eq("path", args.path))
    .first();
}

/**
 * Open (or re-open) the request for one read a checkout must answer. One row
 * per cache key however many pages ask. A recent failure is reported back so
 * the page can say why instead of waiting; an old one is asked again. The
 * fallback installation, when the caller has one, rides on the row so the
 * answer can come from GitHub once the checkouts have had their turn.
 */
export const requestLocalRead = internalMutation({
  args: {
    team_id: v.id("teams"),
    repository: v.string(),
    kind: v.string(),
    ref: v.string(),
    path: v.string(),
    params: v.optional(v.any()),
    requested_by: v.id("users"),
    fallback_installation_id: v.optional(v.number()),
    fallback_team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args): Promise<{ failed: boolean; error?: string; request_id?: Id<"repo_read_requests"> }> => {
    const repository = normalizeRepository(args.repository);
    const now = Date.now();
    const existing = await readRequestByKey(ctx, args);
    if (existing?.status === "failed" && now - existing.updated_at < LOCAL_READ_RETRY_MS) {
      return { failed: true, error: existing.error ?? "No checkout could answer this read" };
    }
    const fallback = { fallback_installation_id: args.fallback_installation_id, fallback_team_id: args.fallback_team_id };
    if (existing) {
      await ctx.db.patch(existing._id, { status: "pending", error: undefined, declined_by: undefined, params: args.params, requested_by: args.requested_by, ...fallback, updated_at: now });
      return { failed: false, request_id: existing._id };
    }
    const request_id = await ctx.db.insert("repo_read_requests", { ...args, repository, status: "pending", created_at: now, updated_at: now });
    return { failed: false, request_id };
  },
});

export const getReadRequest = internalQuery({
  args: { request_id: v.id("repo_read_requests") },
  handler: async (ctx, args) => await ctx.db.get(args.request_id),
});

/** Close a request GitHub answered, or record that GitHub could not either. */
export const settleReadRequest = internalMutation({
  args: { request_id: v.id("repo_read_requests"), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.request_id);
    if (!request) return;
    if (args.error === undefined) await ctx.db.delete(request._id);
    else await ctx.db.patch(request._id, { status: "failed", error: args.error.slice(0, 500), updated_at: Date.now() });
  },
});

/**
 * The reads waiting on this daemon: every pending request for a repository
 * one of the caller's enabled checkouts publishes, with the checkout root to
 * answer it from. Several machines may hold the same repository; the first
 * answer wins and the rest find the request gone.
 */
export const pendingLocalReads = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return [];
    const sources = await ctx.db
      .query("repo_sources")
      .withIndex("by_user_root", (q: any) => q.eq("user_id", userId))
      .collect();
    const out: { _id: Id<"repo_read_requests">; repository: string; root: string; kind: string; ref: string; path: string; params: any; created_at: number }[] = [];
    for (const source of sources) {
      if (!source.enabled) continue;
      const requests = await ctx.db
        .query("repo_read_requests")
        .withIndex("by_repository", (q: any) => q.eq("repository", source.repository))
        .collect();
      for (const request of requests) {
        if (request.status !== "pending" || request.team_id !== source.team_id) continue;
        if (request.declined_by?.includes(userId)) continue;
        out.push({ _id: request._id, repository: request.repository, root: source.root, kind: request.kind, ref: request.ref, path: request.path, params: request.params ?? {}, created_at: request.created_at });
      }
    }
    return out;
  },
});

/**
 * A daemon's answer to one request: the cache row (written under the
 * request's own key, so a daemon cannot write anywhere it was not asked to),
 * a commit's diff onto the commit row, or the reason it could not answer.
 * Only a daemon that publishes the repository to the request's team may
 * answer, which is the same rule that let its rows in through ingestLocal.
 *
 * A checkout that cannot answer declines rather than fails the request:
 * another publisher may hold the ref. The request fails once every publisher
 * has declined, and then GitHub takes it when the request carries an
 * installation to fall back to.
 */
export const answerLocalRead = mutation({
  args: {
    api_token: v.optional(v.string()),
    request_id: v.id("repo_read_requests"),
    row: v.optional(localRow),
    commit: v.optional(commitFiles),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const request = await ctx.db.get(args.request_id);
    if (!request) return { ok: false, reason: "gone" };

    const sources = await ctx.db
      .query("repo_sources")
      .withIndex("by_user_root", (q: any) => q.eq("user_id", userId))
      .collect();
    if (!sources.some((s: any) => s.enabled && s.repository === request.repository && s.team_id === request.team_id)) {
      throw new Error("Forbidden: this checkout does not publish that repository");
    }

    const now = Date.now();
    if (args.error !== undefined) {
      const declined_by = [...new Set([...(request.declined_by ?? []), userId])];
      const error = args.error.slice(0, 500);
      const publishers = (await localSourcesFor(ctx, request.repository))
        .filter((s: any) => s.team_id === request.team_id)
        .map((s: any) => s.user_id as Id<"users">);
      const everyone = publishers.every((u: Id<"users">) => declined_by.includes(u));
      if (!everyone) {
        await ctx.db.patch(request._id, { declined_by, error, updated_at: now });
        return { ok: true, reason: "declined" };
      }
      await ctx.db.patch(request._id, { status: "failed", declined_by, error, updated_at: now });
      if (request.fallback_installation_id) await ctx.scheduler.runAfter(0, internal.repos.fallbackToGitHub, { request_id: request._id });
      return { ok: true };
    }
    if (request.kind === "commit") {
      if (!args.commit) throw new Error("A commit request is answered with its files");
      const candidates = await ctx.db
        .query("commits")
        .withIndex("by_sha", (q: any) => q.eq("sha", request.ref))
        .collect();
      const commit = candidates.find((c: any) => !c.repository || c.repository === request.repository);
      if (commit) await applyCommitFilesTo(ctx, { commit_id: commit._id, ...args.commit, repository: request.repository });
      await ctx.db.delete(request._id);
      return { ok: !!commit, reason: commit ? undefined : "unknown_commit" };
    }
    if (!args.row) throw new Error("A read request is answered with a row");
    await writeCacheRow(ctx, {
      team_id: request.team_id,
      repository: request.repository,
      kind: request.kind,
      ref: request.ref,
      path: request.path,
      sha: args.row.sha,
      content: args.row.content,
      size: args.row.size,
      truncated: args.row.truncated,
    });
    await ctx.db.delete(request._id);
    return { ok: true };
  },
});

/**
 * A daemon publishing one checkout's git metadata.
 *
 * Who may read the result is decided here, once, by the rule that already
 * decides who sees this person's sessions from this path: the directory team
 * mapping. A path whose sessions are shared with a team publishes to that
 * team; a private path publishes nothing, and the daemon is told so. The
 * repo_sources row records the checkout so the person can turn it off later
 * and so the repository lists for the team.
 *
 * The first page of history also lands in the commits table, so a commit that
 * never passed through GitHub still resolves as a reference (owner/repo@sha)
 * and joins onto history the same way a webhook-recorded one does.
 */
export const ingestLocal = mutation({
  args: {
    api_token: v.optional(v.string()),
    root: v.string(),
    repository: v.string(),
    remote_url: v.optional(v.string()),
    device_label: v.optional(v.string()),
    default_branch: v.optional(v.string()),
    head_sha: v.optional(v.string()),
    rows: v.array(localRow),
    commits: v.optional(v.array(v.object({
      sha: v.string(),
      message: v.string(),
      author_name: v.string(),
      author_email: v.string(),
      timestamp: v.number(),
      files_changed: v.number(),
      insertions: v.number(),
      deletions: v.number(),
      branch: v.optional(v.string()),
      // The session that made the commit, when the daemon can say so (one live
      // session in that checkout, commit newer than its last publish). Checked
      // against the caller before it is written: a daemon names only its own.
      conversation_id: v.optional(v.string()),
    }))),
  },
  handler: async (ctx, args): Promise<{ published: boolean; reason?: "private" | "disabled"; rows?: number; commits_created?: number }> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");

    const privacy = await resolveCreationPrivacy(ctx, userId, args.root);
    if (!privacy.team_id || privacy.is_private) return { published: false, reason: "private" };
    const teamId = privacy.team_id;
    const repository = normalizeRepository(args.repository);

    const now = Date.now();
    const existing = await ctx.db
      .query("repo_sources")
      .withIndex("by_user_root", (q: any) => q.eq("user_id", userId).eq("root", args.root))
      .first();
    const source = {
      user_id: userId,
      team_id: teamId,
      repository,
      root: args.root,
      remote_url: args.remote_url,
      device_label: args.device_label,
      default_branch: args.default_branch,
      head_sha: args.head_sha,
      enabled: existing?.enabled ?? true,
      last_synced_at: now,
      updated_at: now,
    };
    if (existing) await ctx.db.patch(existing._id, source);
    else await ctx.db.insert("repo_sources", { ...source, created_at: now });
    if (!source.enabled) return { published: false, reason: "disabled" };

    for (const row of args.rows) {
      if (!LOCAL_KINDS.has(row.kind)) continue;
      await writeCacheRow(ctx, { team_id: teamId, repository, ...row });
    }

    let created = 0;
    const ownConversations = new Map<string, Id<"conversations"> | null>();
    for (const commit of args.commits ?? []) {
      const { conversation_id: claimed, ...fields } = commit;
      let conversationId: Id<"conversations"> | undefined;
      if (claimed) {
        if (!ownConversations.has(claimed)) {
          const id = ctx.db.normalizeId("conversations", claimed);
          const conv = id ? await ctx.db.get(id) : null;
          ownConversations.set(claimed, conv && conv.user_id === userId ? id : null);
        }
        conversationId = ownConversations.get(claimed) ?? undefined;
      }
      const dup = await ctx.db
        .query("commits")
        .withIndex("by_sha", (q: any) => q.eq("sha", commit.sha))
        .first();
      if (dup) {
        // A row that arrived first (a webhook, another machine) may still learn
        // which session made it; a session already named is never overwritten.
        if (conversationId && !dup.conversation_id) await ctx.db.patch(dup._id, { conversation_id: conversationId });
        continue;
      }
      await ctx.db.insert("commits", { ...fields, repository, team_id: teamId, ...(conversationId ? { conversation_id: conversationId } : {}) });
      created++;
    }
    return { published: true, rows: args.rows.length, commits_created: created };
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

/** The way the caller may browse a repository: an installation, or a teammate's published checkout. */
async function requireRepoAccess(ctx: any, repository: string): Promise<BrowseAccess> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Unauthorized");

  const access: BrowseAccess | null = await ctx.runQuery(internal.repos.repoAccess, { repository, user_id: userId });
  if (!access) throw new Error(`Nobody has connected ${repository}: no GitHub App installation covers it and no teammate publishes a checkout of it`);
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
 * Ask the checkouts publishing a repository for one read, on the viewer's
 * behalf. Returns `requested` when the request is open and a daemon will
 * answer, or `failed` with the reason when the checkouts declined it recently.
 * With an installation to fall back to, GitHub is scheduled to answer once
 * the grace window passes with the request still open.
 */
async function askCheckouts(
  ctx: any,
  access: { team_id: Id<"teams">; installation_id?: number; local_team_id?: Id<"teams"> },
  read: { repository: string; kind: string; ref: string; path: string; params?: SpecParams },
): Promise<{ requested: boolean; error?: string }> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Unauthorized");
  const request = await ctx.runMutation(internal.repos.requestLocalRead, {
    team_id: access.local_team_id ?? access.team_id,
    repository: read.repository, kind: read.kind, ref: read.ref, path: read.path, params: read.params ?? {},
    requested_by: userId,
    ...(access.installation_id ? { fallback_installation_id: access.installation_id, fallback_team_id: access.team_id } : {}),
  });
  if (request.failed) return { requested: false, error: request.error };
  if (access.installation_id && request.request_id) {
    await ctx.scheduler.runAfter(LOCAL_READ_GRACE_MS, internal.repos.fallbackToGitHub, { request_id: request.request_id });
  }
  return { requested: true };
}

/** Fetch one cache row from GitHub and write it, stamped with the installation's team. */
async function fillFromGitHub(
  ctx: any,
  repository: string,
  access: { team_id: Id<"teams">; installation_id?: number },
  spec: Refresh,
): Promise<void> {
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
}

/**
 * Refresh one cache row if it has gone stale, using already-resolved access.
 * The access decision happens above this, which is what lets the viewer path
 * and the public path share one body.
 *
 * A checkout that publishes the repository is asked first for every kind it
 * can answer; a stale row still paints while it works. GitHub answers when no
 * checkout publishes the repository, when the checkouts declined this read,
 * or — through the request's fallback — when they do not answer in time.
 */
async function fillCache(
  ctx: any,
  repository: string,
  access: { team_id: Id<"teams">; installation_id?: number; local_team_id?: Id<"teams"> },
  spec: Refresh,
  params: SpecParams = {},
): Promise<{ cached: boolean; requested?: boolean }> {
  const cached = await ctx.runQuery(internal.repos.getCacheRow, {
    repository,
    kind: spec.kind,
    ref: spec.ref,
    path: spec.path,
  });
  if (isFresh(cached, Date.now())) return { cached: true };

  const checkoutCanAnswer = !!access.local_team_id && LOCAL_KINDS.has(spec.kind);
  if (checkoutCanAnswer) {
    const asked = await askCheckouts(ctx, access, { repository, kind: spec.kind, ref: spec.ref, path: spec.path, params });
    if (asked.requested) return { cached: !!cached, requested: true };
    if (!access.installation_id) {
      if (cached) return { cached: true };
      throw new Error(asked.error);
    }
  }
  if (!access.installation_id) {
    if (cached) return { cached: true };
    throw new Error("This read needs the GitHub App; a checkout cannot answer it");
  }

  await fillFromGitHub(ctx, repository, access, spec);
  return { cached: false };
}

/**
 * GitHub answering a read the checkouts did not.
 *
 * Runs on the grace timer armed when the request was opened, and again the
 * moment the last publisher declines. Whichever fires first does the work;
 * the other finds the request gone. A request that was answered meanwhile is
 * left alone, and one already failed with no installation stays failed.
 */
export const fallbackToGitHub = internalAction({
  args: { request_id: v.id("repo_read_requests") },
  handler: async (ctx, args): Promise<void> => {
    const request = await ctx.runQuery(internal.repos.getReadRequest, { request_id: args.request_id });
    if (!request || !request.fallback_installation_id || !request.fallback_team_id) return;
    const access = { team_id: request.fallback_team_id, installation_id: request.fallback_installation_id };
    try {
      if (request.kind === "commit") {
        await fetchCommitFromGitHub(ctx, request.repository, request.ref, access);
      } else {
        await fillFromGitHub(ctx, request.repository, access, refreshSpec(ctx, request.repository, request.kind, request.params ?? {}));
      }
      await ctx.runMutation(internal.repos.settleReadRequest, { request_id: request._id });
    } catch (e) {
      const local = request.error ? `${request.error}; ` : "";
      await ctx.runMutation(internal.repos.settleReadRequest, { request_id: request._id, error: `${local}${(e as Error)?.message ?? String(e)}` });
    }
  },
});

async function ensureCached(ctx: any, repository: string, spec: Refresh, params: SpecParams): Promise<{ cached: boolean; requested?: boolean }> {
  return await fillCache(ctx, repository, await requireRepoAccess(ctx, repository), spec, params);
}

/** One ensure action per kind, so the client keeps naming what it wants. */
function ensureAction(kind: string) {
  return action({
    args: { repository: v.string(), ...specArgs },
    handler: async (ctx, args): Promise<{ cached: boolean; requested?: boolean }> => {
      const { repository, ...params } = args;
      return await ensureCached(ctx, repository, refreshSpec(ctx, repository, kind, params), params);
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
    const row = await cacheRowByKey(ctx, args.repository, "meta", "-", "");
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
    const row = await cacheRowByKey(ctx, args.repository, args.kind, args.ref, args.path);
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
  if (kind === "commit") return { ref: params.ref ?? "-", path: "" };
  const spec = refreshSpec(null as any, "", kind, params);
  return { ref: spec.ref, path: spec.path };
}

/**
 * What a page waiting on a checkout may learn: the read is still open, or it
 * failed and why. Named the way the page asked for it (the same args as its
 * ensure), keyed here the way the request was. Null once it is answered (the
 * row it asked for is the answer) or was never asked.
 */
export const readRequestStatus = query({
  args: { repository: v.string(), kind: v.string(), ...specArgs },
  handler: async (ctx, args): Promise<{ status: "pending" | "failed"; error?: string } | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const { repository, kind, ...params } = args;
    const request = await readRequestByKey(ctx, { repository, kind, ...cacheKeyFor(kind, params) });
    if (!request || !(await isTeamMember(ctx, userId, request.team_id))) return null;
    return { status: request.status, error: request.error };
  },
});

// ── The reads ──

async function readCache(ctx: any, repository: string, kind: string, ref: string, path: string) {
  const userId = await requireUser(ctx);
  if (!(await browseAccessForUser(ctx, userId, repository))) return null;

  const row = await cacheRowByKey(ctx, repository, kind, ref, path);
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
/** A commit's diff from GitHub, written onto its row. Throws when the row is gone or GitHub has no such commit. */
async function fetchCommitFromGitHub(
  ctx: any,
  repository: string,
  sha: string,
  access: { team_id: Id<"teams">; installation_id?: number },
): Promise<void> {
  const state = await ctx.runQuery(internal.commits.commitFilesState, { repository, sha });
  if (!state) throw new Error(`${sha.slice(0, 7)} is not a commit of ${repository} this workspace knows`);
  if (state.has_files) return;
  const data = await ctx.runAction(internal.githubApi.getCommit, {
    repository,
    sha,
    github_access_token: await installationToken(ctx, access),
  });
  await ctx.runMutation(internal.commits.applyCommitFiles, {
    commit_id: state.commit_id,
    files: data.files,
    additions: data.additions,
    deletions: data.deletions,
    author_login: data.author_login,
    author_avatar_url: data.author_avatar_url,
    repository: state.needs_repository ? repository : undefined,
  });
}

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
    // The checkout that made the commit has its diff whether or not the commit
    // was ever pushed, so it is asked first; the commit row updates itself when
    // the answer lands, and GitHub takes over if no checkout answers.
    if (access.local_team_id) {
      const asked = await askCheckouts(ctx, access, { repository: args.repository, kind: "commit", ref: args.sha, path: "" });
      if (asked.requested) return { fetched: false, reason: "requested" };
      if (!access.installation_id) throw new Error(asked.error);
    }
    if (!access.installation_id) throw new Error("This read needs the GitHub App; no checkout publishes this repository");

    await fetchCommitFromGitHub(ctx, args.repository, args.sha, access);
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

/**
 * The sessions behind a file's blame: session blame for the source viewer.
 *
 * Reads the cached git blame and the cached file, and joins each commit sha
 * to the session that made it (commits table, stored commit hashes, subject
 * and time). Lines from recent commits are also matched by text against the
 * edits sessions made to the file, which names the session that WROTE a line
 * even when another one committed it. Edits are stored under the absolute
 * path of the checkout they happened in, so the roots teammates publish for
 * this repository are the paths tried.
 */
export const getBlameSessions = query({
  args: { repository: v.string(), ref: v.string(), path: v.string() },
  handler: async (ctx, args) => {
    const { ref, path } = cacheKeyFor("blame", args);
    const blame = await readCache(ctx, args.repository, "blame", ref, path);
    if (!blame) return null;
    const userId = await requireUser(ctx);
    const caches = newResolveCaches();

    const ranges: { start_line: number; end_line: number; sha: string; message?: string; committed_at?: number }[] = blame.ranges ?? [];
    const bySha = new Map<string, { sha: string; summary?: string; author_time?: number }>();
    for (const r of ranges) {
      if (!bySha.has(r.sha)) bySha.set(r.sha, { sha: r.sha, summary: r.message?.split("\n")[0], author_time: r.committed_at || undefined });
    }
    const resolved = await resolveCommitSessions(ctx, userId, [...bySha.values()], caches);

    const blob = await readCache(ctx, args.repository, "blob", ref, path);
    const lines: string[] = typeof blob?.content === "string" && !blob.truncated ? blob.content.split("\n") : [];
    const blamed = ranges.flatMap((r) =>
      lines.slice(r.start_line - 1, r.end_line).map((text) => ({ text, authorMs: r.committed_at || undefined })),
    );
    const wanted = contentLinesToMatch(blamed, Date.now()).map((l) => ({ text: l.t, deadline: l.d }));

    const repository = normalizeRepository(args.repository);
    const sources = await ctx.db
      .query("repo_sources")
      .withIndex("by_repository", (q: any) => q.eq("repository", repository))
      .take(50);
    const roots = [...new Set(sources.map((s: any) => String(s.root).replace(/\/+$/, "")))];
    const filePaths = roots.map((root) => `${root}/${path}`);
    const lineMatches = wanted.length > 0 ? await matchFileLines(ctx, userId, filePaths, wanted, caches) : [];

    return { by_sha: resolved, line_matches: lineMatches };
  },
});
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

    const repository = normalizeRepository(args.repository);
    const commits = [];
    for (const commit of cached.commits ?? []) {
      const candidates = await ctx.db
        .query("commits")
        .withIndex("by_sha", (q) => q.eq("sha", commit.sha))
        .collect();
      let row = null;
      for (const candidate of candidates) {
        if (candidate.repository === repository && await canAccessCommit(ctx, userId, candidate)) {
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
          q.eq("repository", normalizeRepository(args.repository)).eq("number", pull.number))
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
