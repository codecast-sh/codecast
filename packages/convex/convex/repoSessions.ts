// The sessions behind a repository, and what each reader may learn about them.
//
// A repository page has two readers. A signed in teammate sees every session
// they may open, with its title and a link into the app. A stranger on the
// public /r page sees a session only as far as its owner chose to show it: a
// session pinned to its owner's public profile carries its title and a link to
// its share page, and any other session is reduced to "Ashot's session on
// Sep 20" — who and when, nothing else — so the blame gutter and the history
// still say a session was behind a line without opening it.
//
// Three readers share the one reduction: the Sessions tab, the session behind
// each commit in the history, and session blame in the source viewer. The
// reduction is a pure function of the conversation and its owner, kept here so
// no route can invent a looser one.
import { v } from "convex/values";
import { internalQuery, query } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./lib/auth";
import { canAccessConversation } from "./lib/access";
import { normalizeRepository } from "./lib/gitRefs";
import { repositoryFromRemote, SESSION_ACTIVITY_FRESH_MS } from "@codecast/shared/contracts";
import { profilePublicSessionVisible } from "./privacy";
import { blameSessionsFor, cacheKeyFor, cacheRowByKey, canBrowseRepository, localSourcesFor } from "./repos";
import { type BlameViewer, type ResolvedSession } from "./blame";

/** One session as a reader may see it, whichever surface names it. */
export type SessionRefForReader = {
  conversation_id: Id<"conversations">;
  /** The session's own title, or the anonymous label for a private session. */
  title: string;
  /** True when a stranger may open it; the share link is where. */
  public: boolean;
  share_token?: string;
  short_id?: string;
  author_name?: string;
  author_image?: string;
  message_id?: Id<"messages">;
  via?: ResolvedSession["via"];
};

type OwnerInfo = { name?: string; image?: string };
type OwnerCache = Map<string, OwnerInfo>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * What a stranger reads for a session its owner has not made public: the
 * owner's first name and the day it started. The year is spelled out only when
 * it is not this year, the way a person writes a date.
 */
export function anonymousSessionTitle(ownerName: string | undefined, startedAt: number, now = Date.now()): string {
  const first = ownerName?.trim().split(/\s+/)[0] || "A";
  const date = new Date(startedAt);
  const day = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  const when = date.getUTCFullYear() === new Date(now).getUTCFullYear() ? day : `${day}, ${date.getUTCFullYear()}`;
  const whose = first === "A" ? "A session" : `${first}'s session`;
  return `${whose} on ${when}`;
}

/** A session reduced to what a reader with no account may see. */
export function publicSessionRef(
  conv: Pick<Doc<"conversations">, "_id" | "title" | "short_id" | "share_token" | "profile_pinned_at" | "started_at">,
  owner: OwnerInfo,
  now = Date.now(),
): SessionRefForReader {
  if (profilePublicSessionVisible(conv)) {
    return {
      conversation_id: conv._id,
      title: conv.title || "Untitled",
      public: true,
      share_token: conv.share_token,
      short_id: conv.short_id ?? undefined,
      author_name: owner.name,
      author_image: owner.image,
    };
  }
  return {
    conversation_id: conv._id,
    title: anonymousSessionTitle(owner.name, conv.started_at, now),
    public: false,
    author_name: owner.name,
    author_image: owner.image,
  };
}

async function ownerOf(ctx: { db: any }, userId: Id<"users">, owners: OwnerCache): Promise<OwnerInfo> {
  const key = userId.toString();
  if (!owners.has(key)) {
    const user = await ctx.db.get(userId);
    owners.set(key, { name: user?.name ?? undefined, image: user?.image ?? user?.github_avatar_url ?? undefined });
  }
  return owners.get(key)!;
}

/**
 * Does a session belong to a repository? Its remote says so when it recorded
 * one. Many sessions never did, and for those the checkout decides: a root
 * that publishes this repository is a checkout of it.
 */
export function sessionInRepository(
  conv: { git_remote_url?: string; git_root?: string },
  repo: string,
  publishedRoots: ReadonlySet<string>,
): boolean {
  if (conv.git_remote_url) return repositoryFromRemote(conv.git_remote_url) === repo;
  return !!conv.git_root && publishedRoots.has(conv.git_root.replace(/\/+$/, ""));
}

/** A session's absolute file path as the repository spells it, when it lies inside the checkout. */
export function pathInRepository(filePath: string, root: string | undefined): string | null {
  if (!root) return null;
  const base = root.replace(/\/+$/, "") + "/";
  return filePath.startsWith(base) ? filePath.slice(base.length) : null;
}

export type RepoSessionRow = SessionRefForReader & {
  agent_type: string;
  message_count: number;
  started_at: number;
  updated_at: number;
  branch?: string;
  commits: { sha: string; subject: string; timestamp: number; insertions: number; deletions: number; files_changed: number }[];
  /** Repository paths the session edited or committed, newest first, capped. */
  files: string[];
  files_total: number;
};

const MAX_COMMITS_SCANNED = 400;
const MAX_SESSIONS_PER_CHECKOUT = 60;
const MAX_FILES_SHOWN = 12;
const MAX_ROWS = 80;

/**
 * The sessions that may have touched a repository, before any viewer rule.
 *
 * Two sources name a session: the commits it made (the commits table, by
 * repository), and the checkouts teammates publish (repo_sources), under which
 * each publisher's sessions in that root are listed. The session list and the
 * pulse both start from this set; what each may say about a session is
 * decided after.
 */
export async function repoSessionCandidates(ctx: { db: any }, repository: string): Promise<{
  repo: string;
  candidates: Map<string, Doc<"conversations">>;
  commitsBySession: Map<string, Doc<"commits">[]>;
}> {
  const repo = normalizeRepository(repository);
  const commits: Doc<"commits">[] = await ctx.db
    .query("commits")
    .withIndex("by_repository_timestamp", (q: any) => q.eq("repository", repo))
    .order("desc")
    .take(MAX_COMMITS_SCANNED);
  const commitsBySession = new Map<string, Doc<"commits">[]>();
  for (const commit of commits) {
    if (!commit.conversation_id) continue;
    const key = commit.conversation_id.toString();
    const list = commitsBySession.get(key);
    if (list) list.push(commit);
    else commitsBySession.set(key, [commit]);
  }

  const candidates = new Map<string, Doc<"conversations">>();
  const consider = (conv: Doc<"conversations"> | null) => {
    if (conv && !candidates.has(conv._id.toString())) candidates.set(conv._id.toString(), conv);
  };
  for (const key of commitsBySession.keys()) consider(await ctx.db.get(key as Id<"conversations">));

  const publishers = new Map<string, Set<string>>();
  for (const source of await localSourcesFor(ctx, repository)) {
    const roots = publishers.get(source.user_id.toString()) ?? new Set<string>();
    roots.add(String(source.root).replace(/\/+$/, ""));
    publishers.set(source.user_id.toString(), roots);
  }
  for (const [userId, roots] of publishers) {
    for (const root of roots) {
      const inRoot: Doc<"conversations">[] = await ctx.db
        .query("conversations")
        .withIndex("by_user_git_root", (q: any) => q.eq("user_id", userId).eq("git_root", root))
        .order("desc")
        .take(MAX_SESSIONS_PER_CHECKOUT);
      for (const conv of inRoot) if (sessionInRepository(conv, repo, roots)) consider(conv);
    }
    // A public session is the one thing a stranger can open, so every one the
    // publisher pinned is listed however old it is.
    const pinned: Doc<"conversations">[] = await ctx.db
      .query("conversations")
      .withIndex("by_user_profile_pinned", (q: any) => q.eq("user_id", userId).gt("profile_pinned_at", 0))
      .order("desc")
      .take(MAX_SESSIONS_PER_CHECKOUT);
    for (const conv of pinned) if (sessionInRepository(conv, repo, roots)) consider(conv);
  }

  return { repo, candidates, commitsBySession };
}

/**
 * Every session that touched a repository, as the viewer may see it.
 *
 * A reader with no account gets only the sessions their owners made public;
 * everyone else gets the sessions they may open. Files come from what the
 * session denormalizes as it edits (recent_files) and from the commits it
 * made, never from the edit rows themselves, whose bodies are whole files.
 */
export async function gatherRepoSessions(ctx: { db: any }, viewer: BlameViewer, repository: string): Promise<RepoSessionRow[]> {
  const now = Date.now();
  const owners: OwnerCache = new Map();
  const { repo, candidates, commitsBySession } = await repoSessionCandidates(ctx, repository);

  const rows: RepoSessionRow[] = [];
  for (const conv of candidates.values()) {
    // A subagent's transcript belongs to the session that spawned it, which
    // is the row that names the work; listing both says one thing twice.
    if (conv.parent_conversation_id) continue;
    const visible = viewer === null ? profilePublicSessionVisible(conv) : await canAccessConversation(ctx, viewer, conv);
    if (!visible) continue;
    const owner = await ownerOf(ctx, conv.user_id, owners);
    const ref = viewer === null
      ? publicSessionRef(conv, owner, now)
      : {
          conversation_id: conv._id,
          title: conv.title || "Untitled",
          public: profilePublicSessionVisible(conv),
          short_id: conv.short_id ?? undefined,
          author_name: owner.name,
          author_image: owner.image,
        };
    const made = (commitsBySession.get(conv._id.toString()) ?? []).sort((a, b) => b.timestamp - a.timestamp);

    const files: string[] = [];
    const seen = new Set<string>();
    const add = (path: string | null) => {
      if (path && !seen.has(path)) { seen.add(path); files.push(path); }
    };
    for (const filePath of conv.recent_files ?? []) add(pathInRepository(filePath, conv.git_root));
    for (const commit of made) for (const file of commit.files ?? []) add(file.filename);

    rows.push({
      ...ref,
      agent_type: conv.agent_type,
      message_count: conv.message_count ?? 0,
      started_at: conv.started_at,
      updated_at: conv.updated_at ?? conv.started_at,
      branch: conv.git_branch ?? undefined,
      commits: made.map((c) => ({
        sha: c.sha,
        subject: c.message.split("\n")[0],
        timestamp: c.timestamp,
        insertions: c.insertions,
        deletions: c.deletions,
        files_changed: c.files_changed,
      })),
      files: files.slice(0, MAX_FILES_SHOWN),
      files_total: files.length,
    });
  }

  // Newest first, and the cap never drops a public session: those are the
  // curated few, and the signed in list is where their owner checks on them.
  rows.sort((a, b) => b.updated_at - a.updated_at);
  const kept: RepoSessionRow[] = [];
  let others = 0;
  for (const row of rows) {
    if (!row.public && others++ >= MAX_ROWS) continue;
    kept.push(row);
  }
  return kept;
}

/** The Sessions tab, signed in: every session the viewer may open. Null when they may not browse the repository at all. */
export const getSessions = query({
  args: { repository: v.string() },
  handler: async (ctx, args): Promise<RepoSessionRow[] | null> => {
    const userId = await requireUser(ctx);
    if (!(await canBrowseRepository(ctx, userId, args.repository))) return null;
    return await gatherRepoSessions(ctx, userId, args.repository);
  },
});

// ── The public route's reads (repoPublicHttp) ──
//
// Each of these runs only after the route has decided the repository is public.
// None of them checks a viewer, because there is none; all of them reduce every
// session through publicSessionRef before it leaves.

export const publicSessions = internalQuery({
  args: { repository: v.string() },
  handler: async (ctx, args): Promise<RepoSessionRow[]> => {
    return await gatherRepoSessions(ctx, null, args.repository);
  },
});

/**
 * How many sessions are on the repository right now: a bare count for the
 * marketing site's GitHub chip. A count names no session, so it may include
 * the ones a stranger cannot open; the list above cannot. "Now" is the rule a
 * row uses to show what its agent is doing: a tool call stamped within the
 * last few minutes, on a session nobody tore down.
 */
export function isSessionOnRepoNow(
  conv: Pick<Doc<"conversations">, "activity" | "status" | "inbox_killed_at" | "parent_conversation_id">,
  now: number,
): boolean {
  if (conv.parent_conversation_id || conv.inbox_killed_at || conv.status !== "active") return false;
  return !!conv.activity && now - conv.activity.at <= SESSION_ACTIVITY_FRESH_MS;
}

export const publicPulse = internalQuery({
  args: { repository: v.string() },
  handler: async (ctx, args): Promise<{ live: number }> => {
    const now = Date.now();
    const { candidates } = await repoSessionCandidates(ctx, args.repository);
    let live = 0;
    for (const conv of candidates.values()) if (isSessionOnRepoNow(conv, now)) live++;
    return { live };
  },
});

/** The session behind each of a page of commits, from the commits table alone, the way getLog joins them. */
export const publicCommitSessions = internalQuery({
  args: { repository: v.string(), shas: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ by_sha: Record<string, SessionRefForReader> }> => {
    const repo = normalizeRepository(args.repository);
    const owners: OwnerCache = new Map();
    const conversations = new Map<string, Doc<"conversations"> | null>();
    const now = Date.now();
    const by_sha: Record<string, SessionRefForReader> = {};
    for (const sha of args.shas.slice(0, 100)) {
      const rows: Doc<"commits">[] = await ctx.db
        .query("commits")
        .withIndex("by_sha", (q: any) => q.eq("sha", sha))
        .collect();
      const row = rows.find((r) => r.conversation_id && normalizeRepository(r.repository) === repo);
      if (!row?.conversation_id) continue;
      const key = row.conversation_id.toString();
      if (!conversations.has(key)) conversations.set(key, await ctx.db.get(row.conversation_id));
      const conv = conversations.get(key);
      if (!conv) continue;
      by_sha[sha] = publicSessionRef(conv, await ownerOf(ctx, conv.user_id, owners), now);
    }
    return { by_sha };
  },
});

/** Session blame for a public file: the signed in join, then every session reduced. */
export const publicBlameSessions = internalQuery({
  args: { repository: v.string(), ref: v.string(), path: v.string() },
  handler: async (ctx, args): Promise<{ by_sha: Record<string, SessionRefForReader>; line_matches: (SessionRefForReader & { line: string })[] } | null> => {
    const { ref, path } = cacheKeyFor("blame", args);
    const row = await cacheRowByKey(ctx, args.repository, "blame", ref, path);
    if (!row) return null;
    const joined = await blameSessionsFor(ctx, null, args.repository, ref, path, JSON.parse(row.content));
    const owners: OwnerCache = new Map();
    const now = Date.now();
    const reduce = async (session: ResolvedSession): Promise<SessionRefForReader> => {
      const conv = joined.conversations.get(session.conversation_id.toString())!;
      const ref = publicSessionRef(conv, await ownerOf(ctx, conv.user_id, owners), now);
      // Where the line was written stays: it is the message inside a public
      // session's share page, and means nothing for a private one.
      return ref.public ? { ...ref, message_id: session.message_id, via: session.via } : { ...ref, via: session.via };
    };
    const by_sha: Record<string, SessionRefForReader> = {};
    for (const [sha, session] of Object.entries(joined.by_sha)) by_sha[sha] = await reduce(session);
    const line_matches = [];
    for (const match of joined.line_matches) line_matches.push({ ...(await reduce(match)), line: match.line });
    return { by_sha, line_matches };
  },
});
