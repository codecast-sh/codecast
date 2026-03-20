import { DatabaseWriter } from "./_generated/server";

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
