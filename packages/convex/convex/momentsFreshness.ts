// How current a source's judge findings are (`cast line moments ls
// --freshness` and `--stale`), counted a page at a time.
import { v } from "convex/values";
import { query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { scopeArgs } from "./lib/ingestScopeArgs";
import { scopeOf, sourceByRef } from "./lib/ingestScope";
import { publishedOf } from "./moments";

/**
 * One page of a source's judge findings, counted for freshness (`cast line
 * moments ls --freshness` and `--stale` add the pages up): the projects its
 * judges file into hold tens of thousands of findings, more than one read can
 * hold (the listing that counted them all at once ran out of memory, Oct 26).
 * `next` names where the following page starts, null after the last.
 */
export const freshnessPage = query({
  args: { ...scopeArgs, source: v.string(), project: v.optional(v.number()), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const { userId, workspaceKey } = await scopeOf(ctx, args);
    const source = await sourceByRef(ctx, userId, workspaceKey, args.source);
    const { ex, live } = await publishedOf(ctx, source._id);
    const projects = [...new Set(live.flatMap((j) => j.project_ids.map(String)))] as Id<"projects">[];
    const at = args.project ?? 0;
    if (at >= projects.length) return { source: source.name, ...(await findingFreshness(ctx, source._id, ex, live, [])), next: null };
    const page = await ctx.db.query("signals").withIndex("by_project_created", (q: any) => q.eq("project_id", projects[at])).paginate({ cursor: args.cursor ?? null, numItems: 200 });
    const next = !page.isDone ? { project: at, cursor: page.continueCursor } : at + 1 < projects.length ? { project: at + 1, cursor: null } : null;
    return { source: source.name, ...(await findingFreshness(ctx, source._id, ex, live, page.page)), next };
  },
});

/**
 * How current a page of a source's findings is: each judge finding in `rows`
 * not retired, merged or a case against its judge, against the published versions. A
 * finding is stale when the judge version that filed (or last re-found) it is
 * not its judge's published one, or a moment standing behind it (the one it
 * came from, or another showing the same evidence whose newest run still files
 * it) was read by an extractor that is not its kind's published one. Stale findings make a
 * board that shows what an older extractor or judge believed; `stale_moments`
 * are the moments to read again (`cast line moments retry --again`).
 */
async function findingFreshness(ctx: any, sourceId: Id<"event_sources">, extractors: Doc<"moment_extractors">[], judges: Doc<"judges">[], rows: Doc<"signals">[]) {
  const judgeVersion = new Map(judges.map((j) => [j.name, j.version]));
  const extractorVersion = new Map(extractors.map((e) => [e.kind, e.version]));
  // A case against a judge (case_of, LL11) is the judge's defect, not a finding on the board.
  const judged = rows.filter((s) => s.judge && judgeVersion.has(s.judge) && s.moment && !s.retired && !s.merged_into && !s.case_of);
  const moments = new Map<string, Doc<"moments"> | null>();
  // The moments standing behind a finding: the one that filed it and every other whose newest run still files it (held_by).
  const behind = (s: Doc<"signals">) => [...new Set([s.moment!, ...(s.held_by ?? [])])];
  for (const ref of new Set(judged.flatMap(behind))) moments.set(ref, await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first());
  const live = judged.filter((s) => { const m = moments.get(s.moment!); return !m || String(m.source_id) === String(sourceId); });
  let staleJudge = 0;
  let staleExtractor = 0;
  let stale = 0;
  const staleMoments = new Set<string>();
  for (const s of live) {
    const oldJudge = s.judge_version !== judgeVersion.get(s.judge!);
    const readOld = behind(s).map((ref) => moments.get(ref)).filter((m): m is Doc<"moments"> => !!m && m.extractor_version !== extractorVersion.get(m.kind));
    if (oldJudge) staleJudge++;
    if (readOld.length) staleExtractor++;
    if (oldJudge || readOld.length) stale++;
    for (const m of readOld) staleMoments.add(m.short_id);
    const own = moments.get(s.moment!);
    if (oldJudge && own) staleMoments.add(own.short_id);
  }
  return { live: live.length, stale, stale_judge: staleJudge, stale_extractor: staleExtractor, stale_moments: [...staleMoments].sort() };
}
