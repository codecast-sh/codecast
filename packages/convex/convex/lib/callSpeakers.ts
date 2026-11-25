// Who said each line of a voice note, on the server side
// (docs/architecture/speaker-attribution.md). A leaf: validators and read
// helpers only, so the schema and every module that prints a line may import it.
import { v } from "convex/values";
import {
  resolveLineSpeaker,
  wireSpeakers,
  type CallSpeaker,
  type SpeakerRoster,
  type WireCallSpeaker,
} from "@codecast/shared/contracts";

/** One entry of `transcripts.speakers`: who voice cluster `key` is. */
export const callSpeakerValidator = v.object({
  key: v.string(),
  user_id: v.optional(v.id("users")),
  name: v.optional(v.string()),
  source: v.union(v.literal("voice"), v.literal("person")),
  score: v.optional(v.number()),
  by: v.optional(v.id("users")),
  at: v.optional(v.number()),
});

/** The display names of the teammates a recording's speakers name. */
export async function speakerRoster(ctx: any, speakers: ReadonlyArray<Pick<CallSpeaker, "user_id">> | undefined): Promise<SpeakerRoster> {
  const roster: Record<string, string> = {};
  for (const s of speakers ?? []) {
    if (!s.user_id || roster[s.user_id] !== undefined) continue;
    const u = await ctx.db.get(s.user_id);
    if (u?.name) roster[s.user_id] = u.name;
  }
  return roster;
}

/**
 * A reader for one transcript's line names: `name(segment)` is who said it,
 * through resolveLineSpeaker. Every server path that prints a line (the CLI,
 * excerpts, search, route delivery, the summary prompt) names it through this,
 * so an assignment shows everywhere at once. A call with no speakers (every
 * huddle, every recording not yet diarized) pays nothing.
 */
export async function lineSpeakerNames(
  ctx: any,
  t: { speakers?: ReadonlyArray<WireCallSpeaker & { user_id?: any }> },
): Promise<(s: { speaker_id: string; speaker_name: string }) => string> {
  const speakers = t.speakers;
  if (!speakers?.length) return (s) => s.speaker_name;
  const roster = await speakerRoster(ctx, speakers);
  return (s) => resolveLineSpeaker(s, speakers, roster).name;
}

/** `transcripts.speakers` as clients read it (wireSpeakers: no by/at, one key order). */
export function speakersForClient(t: { speakers?: ReadonlyArray<WireCallSpeaker> }): WireCallSpeaker[] {
  return wireSpeakers(t.speakers);
}
