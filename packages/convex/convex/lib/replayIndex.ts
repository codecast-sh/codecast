// The replay row's index fields (ingestSchema replays.person_key, rest_cut):
// copies of what the row already says, kept so the list can read one
// person's recordings, or every partly imported one, by index instead of
// scanning the newest REPLAY_BROWSE_SCAN rows. That is what makes the person
// card, the import line and the list print the same exact count.
//
// Every write that can move a recording's person, length or reach goes
// through patchReplay, which stamps both fields from the row as patched and
// moves the source's partly imported tally (event_sources.replay_rest.cut) by
// one when the recording crosses the line, so the import line is live between
// the tend cron's recounts (sources/replayRest.ts tally).
import { personKey } from "@codecast/shared/replay";
import { replayCutAt } from "@codecast/shared/contracts/replay";

type IndexInput = {
  user?: { id?: string; email?: string; name?: string } | null;
  captured_ms?: number | null;
  duration_ms?: number | null;
};

/** The stored index fields for a row: absent rather than false, so the cut index holds only cut rows. */
export function replayIndexFields(r: IndexInput): { person_key: string | undefined; rest_cut: true | undefined } {
  return {
    person_key: personKey(r.user ?? null) ?? undefined,
    rest_cut: replayCutAt(r.captured_ms, r.duration_ms) !== null ? true : undefined,
  };
}

/** Whether a row's stored index fields differ from what it says. */
export function replayIndexStale(r: IndexInput & { person_key?: string; rest_cut?: boolean }): boolean {
  const want = replayIndexFields(r);
  return want.person_key !== r.person_key || want.rest_cut !== (r.rest_cut || undefined);
}

/**
 * Patch a replay row with its index fields kept true. The tally moves on what
 * the row says before and after (replayCutAt), not on the stored flag, so a
 * row the backfill has not reached yet counts right too.
 */
export async function patchReplay(ctx: { db: any }, row: IndexInput & { _id: any; source_id: any; person_key?: string; rest_cut?: boolean }, patch: Record<string, unknown>): Promise<void> {
  const was = replayCutAt(row.captured_ms, row.duration_ms) !== null;
  const merged = { ...row, ...patch } as IndexInput;
  const want = replayIndexFields(merged);
  const out: Record<string, unknown> = { ...patch };
  if (want.person_key !== row.person_key) out.person_key = want.person_key;
  if (want.rest_cut !== (row.rest_cut || undefined)) out.rest_cut = want.rest_cut;
  await ctx.db.patch(row._id, out);
  const now = want.rest_cut === true;
  if (was === now) return;
  const source = await ctx.db.get(row.source_id);
  const tally = source?.replay_rest;
  if (!tally) return;
  await ctx.db.patch(row.source_id, { replay_rest: { ...tally, cut: Math.max(0, tally.cut + (now ? 1 : -1)) } });
}
