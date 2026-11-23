// One page of ownerMigrations:backfillMovedStarterRows (the comment there says
// what it writes and why).
import { addSessionOwnerRow, rowlessStarterOf, syncPrimaryOwnerCache } from "../sessionOwners";

export async function backfillMovedStarterRowsPage(
  ctx: { db: any },
  args: { dryRun?: boolean; cursor?: string; numItems?: number },
) {
  const dryRun = args.dryRun ?? true;
  const page = await ctx.db.query("conversations").paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? 200 });
  const rows: Array<{ session: string; starter: string }> = [];
  for (const c of page.page as any[]) {
    if (!c.author_user_id || String(c.author_user_id) === String(c.user_id)) continue;
    // A person's start only: starterOf names nobody for a role's run and never an agent.
    const starter = await rowlessStarterOf(ctx, c);
    if (!starter || starter === String(c.user_id)) continue;
    rows.push({ session: c.short_id ?? String(c._id).slice(0, 7), starter });
    if (dryRun) continue;
    await addSessionOwnerRow(ctx, c._id, starter as any, starter as any);
    await syncPrimaryOwnerCache(ctx, c._id);
  }
  return { dryRun, written: rows.length, rows, next: page.isDone ? null : (page.continueCursor as string) };
}
