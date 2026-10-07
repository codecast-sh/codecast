// One build's run as a Convex action: read the job, let Clay work on a draft
// of the base version (agent.ts) while its card narrates, then report the
// result to queue.finish, which commits it as the new live version.
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { byteLength } from "../lib/files";
import { BUILD_INLINE_FILES_BYTES } from "../lib/limits";
import { BUILDER_EFFORT, buildPrompt } from "../prompts";
import { runBuilder } from "./agent";
import { Draft } from "./draft";
import { Narration, Throttle, failureFor, openingLine } from "./rules";

/** How often the card's narration is written while Clay works. */
const NARRATE_EVERY_MS = 250;

type Report =
  | { ok: true; summary: string; name?: string; ideas?: string[]; spotlight?: string; try?: string; files: { path: string; text: string }[] }
  | { ok: false; error: string; detail: string };

export const build = internalAction({
  args: { build_id: v.id("builds") },
  handler: async (ctx, { build_id }): Promise<null> => {
    const narration = new Narration();
    let draft = new Draft([]);
    let cost = 0;
    // Where a build's time goes, logged once per build: reading the job, the
    // model's run (validation inside it), and the commit.
    const began = Date.now();
    const stages: Record<string, number> = {};
    const mark = (stage: string, since: number) => (stages[stage] = Date.now() - since);
    const report = async (result: Report) => {
      const committing = Date.now();
      await ctx.runMutation(internal.builder.queue.finish, {
        build_id,
        cost_usd: cost,
        narration: narration.view(),
        files_touched: draft.touched(),
        result,
      });
      mark("commit", committing);
      console.log(`build ${build_id} ${result.ok ? "live" : "failed"}: ${Object.entries(stages).map(([k, ms]) => `${k} ${ms}ms`).join(", ")}, total ${Date.now() - began}ms, $${cost.toFixed(3)}`);
    };

    try {
      const job = await ctx.runQuery(internal.builder.queue.job, { build_id });
      if (!job) return null;
      draft = new Draft(await ctx.runQuery(internal.versions.draft, { app_id: job.app_id, number: job.base }));
      narration.now(openingLine(job.request));
      mark("setup", began);

      const controller = new AbortController();
      const card = new Throttle(async () => {
        const live = await ctx.runMutation(internal.builder.queue.narrate, {
          build_id,
          narration: narration.view(),
          files_touched: draft.touched(),
        });
        if (!live) controller.abort();
      }, NARRATE_EVERY_MS);
      card.poke();

      const files = draft.snapshot();
      const inline = files.reduce((n, f) => n + byteLength(f.text), 0) <= BUILD_INLINE_FILES_BYTES;
      const modelStart = Date.now();
      const { outcome, costUsd, checkMs } = await runBuilder({
        draft,
        narration,
        prompt: buildPrompt({ ...job, app: job.app_name, files: inline ? files : null, listing: draft.list() }),
        effort: job.first ? BUILDER_EFFORT.first : BUILDER_EFFORT.change,
        onStep: () => card.poke(),
        controller,
        apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY },
        sessionId: `build:${job.app_id}`,
      });
      cost = costUsd;
      mark("model", modelStart);
      stages.validation = checkMs;
      await card.flush();

      if (outcome.kind === "finished") {
        // Only a new app's first build names it; a later change keeps the name.
        const { kind: _, name, ...said } = outcome;
        await report({ ok: true, ...said, ...(job.first && name ? { name } : {}), files: draft.snapshot() });
      }
      else await report({ ok: false, ...failureFor(outcome) });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      await report({ ok: false, ...failureFor({ kind: "stopped", reason: "error", error: detail }) });
    }
    return null;
  },
});
