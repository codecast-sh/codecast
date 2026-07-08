import { DatabaseWriter } from "./_generated/server";

// One counter row per prefix ("ct"/"pl"). Every allocation reads that row and
// patches value+1, so two task/plan creations for the same prefix that overlap
// read the same value and conflict — Convex OCC then retries one of them.
//
// We deliberately do NOT shard this counter. Sharding (N per-prefix buckets,
// pick one at random) only stays collision-free if each bucket is seeded above
// the current global max short_id (~38k today) before its first use — otherwise
// a fresh bucket emits ct-1, ct-2, … which duplicate ids that already exist.
// short_id is a durable product-wide lookup key (by_short_id resolves tasks,
// plans and conversations, and callers assume it is unique), so a seeding
// mistake corrupts those lookups. The contention is low: task/plan creation is
// a low-frequency path (not heartbeat-frequency), OCC retry preserves
// correctness, and the audit rated it low/medium — not worth a fragile,
// migration-dependent id generator. Revisit only if a real hot creation path
// (e.g. a workflow spawning many tasks at once) shows measurable OCC pain.
export async function nextShortId(db: DatabaseWriter, prefix: string): Promise<string> {
  const counter = await db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", prefix))
    .unique();

  if (counter) {
    const next = counter.value + 1;
    await db.patch(counter._id, { value: next });
    return `${prefix}-${next}`;
  } else {
    await db.insert("counters", { name: prefix, value: 1 });
    return `${prefix}-1`;
  }
}
