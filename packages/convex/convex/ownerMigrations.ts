// The session-owner model's one-time backfills (docs/architecture/org-roles-run-work.md R1):
// role_started provenance, the person a task binding keeps driving, and the
// starter's owner row a move now writes. Each is dry by default and continues
// itself page by page on a real run.
//
// Run order for the ship checklist: backfillRoleStarted, then
// backfillBoundDriver, then backfillMovedStarterRows, each to the end before
// the next. Any order gives the same result: all three judge who started a
// session with the one roleStartJudge, so none reads what another writes.
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { backfillRoleStartedPage } from "./lib/roleStartedBackfill";
import { backfillBoundDriverPage } from "./lib/boundDriverBackfill";
import { backfillMovedStarterRowsPage } from "./lib/starterRowBackfill";

// One-time backfill: stamp `role_started` on sessions a role started before
// spawn.recordHandStart wrote it, so the membership rule (shared
// isHeldByRoleAlone) keeps them out of the runner's inbox. A session is the
// role's start when the session that started it acts for the role (shared
// actsForRole, the rule a new spawn reads): the role's standing session, or a
// session the role started and still drives. The starter is the row's
// `spawned_by_conversation_id`, or for a run's own session the run's spawner;
// a starter is judged by the same rule, up to 8 links (roleStartJudge). The
// hold says nothing about who started it: releaseFolderHeld stamped "bound"
// on a role's own hands bound to its task, and those are stamped here. A
// stamped session loses the owner row the old spawn rules gave the person
// whose account ran its starter (that person added themselves), since a run a
// role started takes no person owner; each row names what it drops. It
// misses a hand whose starter pointer is absent (rows from before
// spawned_by) or whose starter was deleted: those stay in their runner's
// inbox. Dry by default; one role's page per transaction, continued by the
// scheduler on a real run. `role` (a handle) narrows it.
//   packages/convex/run.sh ownerMigrations:backfillRoleStarted '{"dryRun":true}'
export const backfillRoleStarted = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    role: v.optional(v.string()),
    roleIndex: v.optional(v.number()),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const res = await backfillRoleStartedPage(ctx, args);
    if (!res.dryRun && res.next) {
      await ctx.scheduler.runAfter(0, internal.ownerMigrations.backfillRoleStarted, { dryRun: false, role: args.role, numItems: args.numItems, ...res.next });
    }
    return res;
  },
});

// One-time backfill, run once when driver_user_id ships: a person's session a
// task binding filed under a role before the field existed gets its person as
// driver, the rule applyHoldChange writes for a new binding (held as bound, not
// a role's start by roleStartJudge, its human starter still owns it). A move
// never picks a driver (sessionOwnership.rehomeSessions), so without this
// they stay the role's. A takeover by the rule held sessions as bound too; the
// org log tells it apart (its write sits in a scope, hire or retire row, a
// binding's in a session row of its own), and those stay the role's. A
// session whose driver changed since the field shipped (`driver_changed_at`,
// a Resume among them) is left alone, so a re-run changes nothing. Dry by
// default; one role's page per transaction, continued by the scheduler on a
// real run. `role` (a handle) narrows it.
//   packages/convex/run.sh ownerMigrations:backfillBoundDriver '{"dryRun":true}'
export const backfillBoundDriver = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    role: v.optional(v.string()),
    roleIndex: v.optional(v.number()),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const res = await backfillBoundDriverPage(ctx, args);
    if (!res.dryRun && res.next) {
      await ctx.scheduler.runAfter(0, internal.ownerMigrations.backfillBoundDriver, { dryRun: false, role: args.role, numItems: args.numItems, ...res.next });
    }
    return res;
  },
});

// One-time backfill: a person's session that moved to another account (a pull
// or a device claim) before those paths wrote the starter's row lists its
// author as owner while no row says so, so the inbox and byIds turn the
// author away. Each such session with no owner rows gets its starter's row,
// the row a move writes now. Role runs (roleStartJudge, stamped or not) and
// agent starts have no starter and are skipped. Dry by default; a real run continues itself page by page.
//   packages/convex/run.sh ownerMigrations:backfillMovedStarterRows '{"dryRun":true}'
export const backfillMovedStarterRows = internalMutation({
  args: { dryRun: v.optional(v.boolean()), cursor: v.optional(v.string()), numItems: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const res = await backfillMovedStarterRowsPage(ctx, args);
    if (!res.dryRun && res.next) {
      await ctx.scheduler.runAfter(0, internal.ownerMigrations.backfillMovedStarterRows, { dryRun: false, numItems: args.numItems, cursor: res.next });
    }
    return res;
  },
});
