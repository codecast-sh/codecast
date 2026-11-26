// The session owner model's one-time backfill (shared contracts/sessionOwners).
import { internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { backfillRoleStartedPage, releaseBindingHoldsPage } from "./lib/roleStartedBackfill";
import { ownPeerByItsSpawnersHuman, peerOwnerFromSpawner } from "./sessionOwners";

// Stamp `role_started` on sessions a role started before spawn.recordHandStart
// wrote it, so the owner rule gives them no implicit starter. A session is the
// role's start when the session that started it acts for the role (shared
// actsForRole, the rule a new spawn reads): the role's standing session, or a
// session the role started and still owns. The starter is the row's
// `spawned_by_conversation_id`, or for a run's own session the run's spawner,
// judged by the same rule up to 8 links (roleStartJudge). It only stamps: no
// owner row moves, and nothing reads the field on a team without the
// session_owners feature. It misses a hand whose starter pointer is absent or
// deleted. One team's roles (`team_id`, the team the flag is about to be
// turned on for). Dry by default; one role's page per transaction, continued
// by the scheduler on a real run; idempotent, so a rerun stamps 0.
//   packages/convex/run.sh ownerMigrations:backfillRoleStarted '{"team_id":"<id>","dryRun":true}'
export const backfillRoleStarted = internalMutation({
  args: {
    team_id: v.id("teams"),
    dryRun: v.optional(v.boolean()),
    roleIndex: v.optional(v.number()),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const res = await backfillRoleStartedPage(ctx, args);
    if (!res.dryRun && res.next) {
      await ctx.scheduler.runAfter(0, internal.ownerMigrations.backfillRoleStarted, { team_id: args.team_id, dryRun: false, numItems: args.numItems, ...res.next });
    }
    return res;
  },
});

// Take a task binding's hold off the team's live sessions no role started
// (lib/roleStartedBackfill releaseBindingHoldsPage says why). After
// backfillRoleStarted; dry by default, continued by the scheduler on a real
// run, idempotent.
//   packages/convex/run.sh ownerMigrations:releaseBindingHolds '{"team_id":"<id>","dryRun":true}'
export const releaseBindingHolds = internalMutation({
  args: {
    team_id: v.id("teams"),
    dryRun: v.optional(v.boolean()),
    roleIndex: v.optional(v.number()),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const res = await releaseBindingHoldsPage(ctx, args);
    if (!res.dryRun && res.next) {
      await ctx.scheduler.runAfter(0, internal.ownerMigrations.releaseBindingHolds, { team_id: args.team_id, dryRun: false, numItems: args.numItems, ...res.next });
    }
    return res;
  },
});

// Give the team's peers a bot-run session spawned before spawn and the
// agent-team link did it themselves (sessionOwners ownPeerByItsSpawnersHuman)
// their spawner's owner: such a peer has no human of its own and no parent,
// so it would be in nobody's inbox. Run once the flag is on (the owner rule
// reads it). A peer someone already owns is left alone. One page of the
// team's sessions per transaction; dry by default, naming each peer and the
// owner it would get; a real run schedules its own next page; a rerun writes 0.
//   packages/convex/run.sh ownerMigrations:backfillPeerOwners '{"team_id":"<id>","dryRun":true}'
export const backfillPeerOwners = internalMutation({
  args: { team_id: v.id("teams"), dryRun: v.optional(v.boolean()), cursor: v.optional(v.union(v.string(), v.null())), numItems: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const res = await backfillPeerOwnersPage(ctx, args);
    if (!res.dryRun && res.next) await ctx.scheduler.runAfter(0, internal.ownerMigrations.backfillPeerOwners, { team_id: args.team_id, dryRun: false, cursor: res.next, numItems: args.numItems });
    return res;
  },
});

export async function backfillPeerOwnersPage(ctx: { db: any }, args: { team_id: any; dryRun?: boolean; cursor?: string | null; numItems?: number }) {
  const dryRun = args.dryRun !== false;
  const page = await ctx.db.query("conversations").withIndex("by_team_id", (q: any) => q.eq("team_id", args.team_id))
    .paginate({ cursor: args.cursor ?? null, numItems: Math.min(args.numItems ?? 200, 500) });
  const owned: { session: string; owner: { people: string[] } | { role: string } }[] = [];
  for (const c of page.page as any[]) {
    if (!c.spawned_by_conversation_id || c.parent_conversation_id) continue;
    if (await ctx.db.query("session_owners").withIndex("by_conversation", (q: any) => q.eq("conversation_id", c._id)).first()) continue;
    const spawner = await ctx.db.get(c.spawned_by_conversation_id);
    const owner = await peerOwnerFromSpawner(ctx, c, spawner);
    if (!owner) continue;
    if (!dryRun) await ownPeerByItsSpawnersHuman(ctx, c, spawner);
    owned.push({ session: c.short_id ?? String(c._id), owner });
  }
  return { dryRun, scanned: page.page.length, owned, next: page.isDone ? null : page.continueCursor as string };
}

// Read-only, before turning session_owners on for a team: how many of the
// conversations the flag would cover name a primary owner (owner_user_id)
// with no session_owners row behind it. The flag covers the team's
// conversations and the personal ones of its members (ownersModelOn's scope).
// The inbox reads owner_user_id as "some person owns it" (lib/inboxOwners
// implicit_owner), while the push and the owners read go by the rows, so such
// a row would list for nobody and ring its starter. One page per call: the
// team's rows first, then each member's personal rows (`member` names whose).
// Pass back `continueCursor` and `member` until `isDone`, and add up `stale`
// across pages. `examples` names the first few for a look.
//   packages/convex/run.sh ownerMigrations:countOwnerCacheWithoutRows '{"team_id":"<id>"}'
export const countOwnerCacheWithoutRows = internalQuery({
  args: { team_id: v.id("teams"), member: v.optional(v.id("users")), cursor: v.optional(v.union(v.string(), v.null())), numItems: v.optional(v.number()) },
  handler: (ctx, args) => performCountOwnerCacheWithoutRows(ctx, args),
});

export async function performCountOwnerCacheWithoutRows(ctx: { db: any }, args: { team_id: any; member?: any; cursor?: string | null; numItems?: number }) {
  const page = await (args.member
    ? ctx.db.query("conversations").withIndex("by_team_user_updated", (q: any) => q.eq("team_id", undefined).eq("user_id", args.member))
    : ctx.db.query("conversations").withIndex("by_team_id", (q: any) => q.eq("team_id", args.team_id))
  ).paginate({ cursor: args.cursor ?? null, numItems: Math.min(args.numItems ?? 500, 1000) });
  let withCache = 0;
  const examples: string[] = [];
  let stale = 0;
  for (const c of page.page) {
    if (!c.owner_user_id) continue;
    withCache++;
    const row = await ctx.db.query("session_owners").withIndex("by_conversation", (q: any) => q.eq("conversation_id", c._id)).first();
    if (row) continue;
    stale++;
    if (examples.length < 10) examples.push(c.short_id ?? String(c._id));
  }
  if (!page.isDone) {
    return { scanned: page.page.length, with_owner_user_id: withCache, stale, examples, isDone: false, continueCursor: page.continueCursor, member: args.member ?? null };
  }
  // This range is done: the next member's personal rows, in id order.
  const members = [...new Set((await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", args.team_id)).collect())
    .map((m: any) => String(m.user_id)))].sort() as string[];
  const next = args.member ? members.find((id) => id > String(args.member)) : members[0];
  return { scanned: page.page.length, with_owner_user_id: withCache, stale, examples, isDone: !next, continueCursor: null, member: next ?? null };
}
