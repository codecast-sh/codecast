// Team read keys: a team admin mints a named, expiring key in Team settings
// for a server, and the server reads the team's shared session metadata with
// it (lib/teamReadKeyHttp.ts). Minting, revoking and use are authority events,
// so they show in `cast audit` for every member of the team.
//
// A key reads the TEAM FLOOR (privacy.ts teamFloorScope), the rule the member
// feed reads through: what every member sees, before anything granted to one
// viewer. Rows are metadata only, even for a session shared in full: no
// message text, prompt or project path leaves this module. A title counts
// only once a title pass or a person set it, and not while it still echoes the
// opening prompt. Subagent and workflow child sessions are left out.
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { isNestedIdentity, repositoryFromRemote, type WorkState } from "@codecast/shared/contracts";
import { internalMutation, internalQuery, mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { requireTeamAdmin } from "./lib/access";
import { recordAuthorityEvent } from "./lib/authorityEvents";
import { sha256Hex } from "./lib/hash";
import { isVisibilityShareable, teamFloorScope } from "./privacy";
import { needsHostedTitle } from "./assistant/backfills";
import { isAfter, pageNewestFirst, type StreamPosition } from "./feedPagination";
import { windowSpent } from "./ipRateLimit";
import { cliSessionClassifier } from "./cliSessionClassifier";
import { isProgramLaunched } from "./lib/userSend";
import {
  MAX_LIVE_TEAM_READ_KEYS,
  TEAM_READ_KEY_EXPIRY_DAYS,
  TEAM_READ_KEY_PREFIX,
  newTeamReadKey,
} from "./lib/teamReadKey";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Characters of the secret shown in the key list (after the cc_trk_ prefix). */
const KEY_PREFIX_CHARS = 6;

/** Use is recorded once per key per window: one audit event and one write, whatever the request rate. */
export const USE_WINDOW_MS = 60 * 60 * 1000;
/** Rows one page may take, past the one it reads first for each member (feedPagination pageNewestFirst). */
const PAGE_READ_BUDGET = 200;

const isLive = (key: Doc<"team_read_keys">, now: number) => !key.revoked_at && key.expires_at > now;
const useDue = (key: Doc<"team_read_keys">, now: number) => now - (key.last_used_at ?? 0) >= USE_WINDOW_MS;

async function liveKey(ctx: any, key: Doc<"team_read_keys"> | null, now: number): Promise<Doc<"team_read_keys"> | null> {
  if (!key || !isLive(key, now)) return null;
  const team = await ctx.db.get(key.team_id);
  return team && !team.deleted_at ? key : null;
}

async function requireAdmin(ctx: any, teamId: Id<"teams">): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  await requireTeamAdmin(ctx, userId, teamId);
  return userId;
}

async function isAdmin(ctx: any, userId: Id<"users">, teamId: Id<"teams">): Promise<boolean> {
  const membership = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
    .first();
  return membership?.role === "admin";
}

function keysOf(ctx: any, teamId: Id<"teams">): Promise<Doc<"team_read_keys">[]> {
  return ctx.db.query("team_read_keys").withIndex("by_team", (q: any) => q.eq("team_id", teamId)).collect();
}

/** Admin-only: the team's keys, newest first, without their secrets. Null for anyone else. */
export const list = query({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    if (!(await isAdmin(ctx, userId, args.team_id))) return null;
    const keys = await keysOf(ctx, args.team_id);
    const creators = new Map<string, string | null>();
    for (const id of new Set(keys.map((k) => String(k.created_by)))) {
      creators.set(id, (await ctx.db.get(id as Id<"users">))?.name ?? null);
    }
    // A key outlives its minter's admin role, so the list says which live keys'
    // minters are no longer team admins. The live-key cap bounds these reads.
    const now = Date.now();
    const stillAdmin = new Map<string, boolean>();
    for (const id of new Set(keys.filter((k) => isLive(k, now)).map((k) => k.created_by))) {
      stillAdmin.set(String(id), await isAdmin(ctx, id, args.team_id));
    }
    return keys
      .sort((a, b) => b.created_at - a.created_at)
      .map((k) => ({
        _id: k._id,
        name: k.name,
        prefix: k.prefix,
        created_at: k.created_at,
        created_by_name: creators.get(String(k.created_by)) ?? null,
        /** Null for an ended key, whose minter is not looked up. */
        created_by_still_admin: stillAdmin.get(String(k.created_by)) ?? null,
        expires_at: k.expires_at,
        revoked_at: k.revoked_at ?? null,
        last_used_at: k.last_used_at ?? null,
      }));
  },
});

/** Admin-only: mint a key. The plaintext comes back once and is never stored. */
export const create = mutation({
  args: {
    team_id: v.id("teams"),
    name: v.string(),
    expires_in_days: v.union(...TEAM_READ_KEY_EXPIRY_DAYS.map((d) => v.literal(d))),
  },
  handler: async (ctx, args) => {
    const userId = await requireAdmin(ctx, args.team_id);
    const team = await ctx.db.get(args.team_id);
    if (!team || team.deleted_at) throw new Error("No such team");
    const now = Date.now();
    if ((await keysOf(ctx, args.team_id)).filter((k) => isLive(k, now)).length >= MAX_LIVE_TEAM_READ_KEYS) {
      throw new ConvexError(`A team can have ${MAX_LIVE_TEAM_READ_KEYS} active read-only keys. Revoke one to create another.`);
    }
    const key = newTeamReadKey();
    const name = args.name.trim().slice(0, 80) || "Read-only key";
    const prefix = key.slice(0, TEAM_READ_KEY_PREFIX.length + KEY_PREFIX_CHARS);
    const expiresAt = now + args.expires_in_days * DAY_MS;
    const keyId = await ctx.db.insert("team_read_keys", {
      team_id: args.team_id,
      created_by: userId,
      name,
      key_hash: await sha256Hex(key),
      prefix,
      created_at: now,
      expires_at: expiresAt,
    });
    await recordAuthorityEvent(ctx, {
      kind: "team_read_key_minted",
      actor_user_id: userId,
      team_id: args.team_id,
      detail: { after: { key_id: keyId, name, prefix, expires_at: expiresAt } },
    });
    return { key_id: keyId, key, name, prefix, expires_at: expiresAt };
  },
});

/** Admin-only: the key stops working on its next request. */
export const revoke = mutation({
  args: { team_id: v.id("teams"), key_id: v.id("team_read_keys") },
  handler: async (ctx, args) => {
    const userId = await requireAdmin(ctx, args.team_id);
    const row = await ctx.db.get(args.key_id);
    if (!row || row.team_id !== args.team_id) throw new Error("No such key");
    if (row.revoked_at) return;
    await ctx.db.patch(row._id, { revoked_at: Date.now() });
    await recordAuthorityEvent(ctx, {
      kind: "team_read_key_revoked",
      actor_user_id: userId,
      team_id: row.team_id,
      detail: { after: { key_id: row._id, name: row.name, prefix: row.prefix } },
    });
  },
});

export type FoundKey = { key_id: Id<"team_read_keys">; use_due: boolean };

/**
 * The live key a presented secret hashes to, and whether this request opens a
 * new use window. An address over its unknown-key window is refused before the
 * lookup, as ingest's sourceForKey does.
 */
export const keyForHash = internalQuery({
  args: { key_hash: v.string(), guess_guard: v.object({ key: v.string(), max: v.number(), window_ms: v.number() }) },
  handler: async (ctx, args): Promise<FoundKey | { retry_after_ms: number } | null> => {
    const wait = await windowSpent(ctx.db, args.guess_guard.key, args.guess_guard.max, args.guess_guard.window_ms);
    if (wait !== null) return { retry_after_ms: wait };
    const now = Date.now();
    const row = await ctx.db.query("team_read_keys").withIndex("by_key_hash", (q) => q.eq("key_hash", args.key_hash)).first();
    const key = await liveKey(ctx, row, now);
    return key ? { key_id: key._id, use_due: useDue(key, now) } : null;
  },
});

/**
 * A key's use, recorded before the read it opens: last_used_at moves and a
 * team_read_key_used event names the key as its actor. Requests inside the
 * same window record nothing.
 */
export const recordUse = internalMutation({
  args: { key_id: v.id("team_read_keys") },
  handler: async (ctx, args) => {
    const now = Date.now();
    const key = await liveKey(ctx, await ctx.db.get(args.key_id), now);
    if (!key || !useDue(key, now)) return;
    await ctx.db.patch(key._id, { last_used_at: now });
    await recordAuthorityEvent(ctx, {
      kind: "team_read_key_used",
      actor_key_id: key._id,
      team_id: key.team_id,
      detail: { after: { key_id: key._id, name: key.name, prefix: key.prefix } },
    });
  },
});

export type TeamSessionRow = {
  id: string;
  /** The person the session is assigned to, else the member who runs it. */
  owner: { id: string; name: string | null; github_username: string | null; email: string | null };
  agent: string;
  branch: string | null;
  /** owner/name of a GitHub remote. */
  repo: string | null;
  /** Null until a title pass or a person names the session, and while it echoes the opening prompt. */
  title: string | null;
  /** The session summary teammates see. */
  summary: string | null;
  /** The level the owner shares this session with the team at. */
  sharing: "summary" | "full";
  /** Every message in the transcript: the person's, the agent's and tool results. */
  transcript_messages: number;
  started_by_agent: boolean;
  work_state: WorkState;
  started_at: string;
  updated_at: string;
};

/**
 * One page of the team floor for a live key, newest activity first, within
 * [since, until] and after `after`. Null when the key stopped being live
 * after keyForHash.
 */
export const sessionsForKey = internalQuery({
  args: {
    key_id: v.id("team_read_keys"),
    since: v.number(),
    until: v.number(),
    limit: v.number(),
    after: v.union(v.object({ t: v.number(), c: v.number() }), v.null()),
  },
  handler: async (ctx, args): Promise<{ sessions: TeamSessionRow[]; next: StreamPosition | null } | null> => {
    const now = Date.now();
    const key = await liveKey(ctx, await ctx.db.get(args.key_id), now);
    if (!key) return null;
    const floor = await teamFloorScope(ctx, key.team_id);
    // The members who can list a session, as cast feed reads them: sharing above
    // activity with the team, and not hidden for the whole account (the legacy setting).
    const sharing = floor.members.filter(
      (u) => u.activity_visibility !== "hidden" && isVisibilityShareable(floor.filter.getVisibility(String(u._id))),
    );
    const { after } = args;
    const team = key.team_id;
    async function* below(member: Id<"users">) {
      const scan = ctx.db
        .query("conversations")
        .withIndex("by_team_user_updated", (q) =>
          q.eq("team_id", team).eq("user_id", member).gte("updated_at", args.since).lte("updated_at", Math.min(after?.t ?? args.until, args.until)),
        )
        .order("desc");
      for await (const c of scan) if (!after || isAfter(c, after)) yield c;
    }
    const page = await pageNewestFirst({
      streams: sharing.map((u) => below(u._id)),
      limit: args.limit,
      budget: PAGE_READ_BUDGET,
      accept: (c) => floor.isVisible(c) && !isNestedIdentity(c),
    });

    const roster = new Map(floor.members.map((u) => [String(u._id), u]));
    const classifier = cliSessionClassifier(ctx, now);
    const sessions: TeamSessionRow[] = [];
    for (const c of page.rows) {
      const owner = roster.get(String(c.owner_user_id)) ?? roster.get(String(c.user_id))!;
      sessions.push({
        id: c.short_id ?? String(c._id),
        owner: {
          id: String(owner._id),
          name: owner.name ?? null,
          github_username: owner.github_username ?? null,
          // Only a member with neither a name nor a GitHub username
          email: owner.name || owner.github_username ? null : (owner.email ?? null),
        },
        agent: c.agent_type,
        branch: c.git_branch ?? null,
        repo: repositoryFromRemote(c.git_remote_url),
        title: (c.title_is_custom || c.subtitle !== undefined) && !needsHostedTitle(c) ? (c.title ?? null) : null,
        summary: c.subtitle ?? null,
        sharing: floor.contentVisible(c) ? "full" : "summary",
        transcript_messages: c.message_count,
        started_by_agent: isProgramLaunched(c),
        work_state: (await classifier.classify(c)).work_state,
        started_at: new Date(c.started_at).toISOString(),
        updated_at: new Date(c.updated_at).toISOString(),
      });
    }
    return { sessions, next: page.next };
  },
});
