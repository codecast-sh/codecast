// One build's run as a Convex action: read the job, let Clay work on a draft
// of the base version (agent.ts) while its card narrates, then report the
// result to queue.finish, which commits it as the new live version.
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { byteLength } from "../lib/files";
import { BUILD_INLINE_FILES_BYTES } from "../lib/limits";
import { buildPrompt } from "../prompts";
import { runBuilder } from "./agent";
import { Draft } from "./draft";
import { Narration, Throttle, failureFor } from "./rules";

/** How often the card's narration is written while Clay works. */
const NARRATE_EVERY_MS = 250;

type Report =
  | { ok: true; summary: string; ideas?: string[]; files: { path: string; text: string }[] }
  | { ok: false; error: string; detail: string };

export const build = internalAction({
  args: { build_id: v.id("builds") },
  handler: async (ctx, { build_id }): Promise<null> => {
    const narration = new Narration();
    let draft = new Draft([]);
    let cost = 0;
    const report = (result: Report) =>
      ctx.runMutation(internal.builder.queue.finish, {
        build_id,
        cost_usd: cost,
        narration: narration.view(),
        files_touched: draft.touched(),
        result,
      });

    try {
      const job = await ctx.runQuery(internal.builder.queue.job, { build_id });
      if (!job) return null;
      draft = new Draft(await ctx.runQuery(internal.versions.draft, { app_id: job.app_id, number: job.base }));
      narration.say(`Reading v${job.base}`);

      const controller = new AbortController();
      const card = new Throttle(async () => {
        const live = await ctx.runMutation(internal.builder.queue.progress, {
          build_id,
          narration: narration.view(),
          files_touched: draft.touched(),
        });
        if (!live) controller.abort();
      }, NARRATE_EVERY_MS);
      card.poke();

      const files = draft.snapshot();
      const inline = files.reduce((n, f) => n + byteLength(f.text), 0) <= BUILD_INLINE_FILES_BYTES;
      const { outcome, costUsd } = await runBuilder({
        draft,
        narration,
        prompt: buildPrompt({ ...job, app: job.app_name, files: inline ? files : null, listing: draft.list() }),
        onStep: () => card.poke(),
        controller,
        apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY },
        sessionId: `build:${job.app_id}`,
      });
      cost = costUsd;
      await card.flush();

      if (outcome.kind === "finished") await report({ ok: true, summary: outcome.summary, ...(outcome.ideas ? { ideas: outcome.ideas } : {}), files: draft.snapshot() });
      else await report({ ok: false, ...failureFor(outcome) });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      await report({ ok: false, ...failureFor({ kind: "stopped", reason: "error", error: detail }) });
    }
    return null;
  },
});
