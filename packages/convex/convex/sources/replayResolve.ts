// A vendor's recording id as `cast replay show|snap|repro` takes it
// (/cli/replays/resolve): the PostHog session id or Sentry replay id an agent
// found through HogQL or an issue, named without --source. A recording the
// store holds answers its rp-N; one it does not is imported from the
// workspace's vendor sources that could hold it, PostHog then Sentry, the way
// a first read of a listed recording is (vendorReplay.ts).
import { v } from "convex/values";
import { action } from "../functions";
import { internal } from "../_generated/api";
import { notFound } from "../lib/auth";
import { scopeArgs } from "../lib/ingestScopeArgs";
import { importFor } from "./posthog";
import { importSentryReplay, SENTRY_REPLAY_ID } from "./sentry";

const POSTHOG_RECORDING_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const resolve = action({
  args: { ...scopeArgs, recording: v.string() },
  handler: async (ctx, args): Promise<{ short_id: string; imported: boolean; source: string | null }> => {
    const { recording, ...scope } = args;
    const id = recording.trim();
    const found: { short_id: string | null; sources: { source_id: any; name: string; provider: string }[] } = await ctx.runQuery(internal.replaysSearch.byExternalId, { ...scope, external_id: id });
    if (found.short_id) return { short_id: found.short_id, imported: false, source: null };
    const order = (p: string) => (p === "posthog" ? 0 : 1);
    const tried: string[] = [];
    for (const s of [...found.sources].sort((a, b) => order(a.provider) - order(b.provider))) {
      if (s.provider === "posthog" && !POSTHOG_RECORDING_ID.test(id)) continue;
      if (s.provider === "sentry" && !SENTRY_REPLAY_ID.test(id)) continue;
      try {
        const out =
          s.provider === "posthog"
            ? await importFor(ctx, await ctx.runQuery(internal.sources.posthog.sourceForPoll, { source_id: s.source_id }).then((i) => i!), id, { rest: true })
            : await importSentryReplay(ctx, s.source_id, id);
        return { short_id: out.short_id, imported: out.imported, source: s.name };
      } catch (err) {
        tried.push(`${s.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    notFound(
      tried.length
        ? `No stored replay has the id ${id}, and importing it failed (${tried.join("; ")})`
        : `No stored replay has the id ${id}, and no PostHog or Sentry source in this workspace takes an id of that form`,
    );
    throw new Error("unreachable");
  },
});
