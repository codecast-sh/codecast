// A project's short id (`pj-<base36>`), the address every link to it takes
// (cohesive build spec D17). Minted from a time, one millisecond later while
// another project already holds it, so two creates in the same moment and a
// backfill of old rows never share one.
type Reader = { db: { query: (table: "projects") => any } };

export async function mintProjectShortId(ctx: Reader, at: number): Promise<string> {
  for (let t = Math.floor(at), tries = 0; tries < 50; t++, tries++) {
    const id = `pj-${t.toString(36)}`;
    const taken = await ctx.db.query("projects").withIndex("by_short_id", (q: any) => q.eq("short_id", id)).first();
    if (!taken) return id;
  }
  throw new Error("Could not mint a project id");
}
