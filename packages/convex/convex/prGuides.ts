// Change guides a model writes for pull requests whose author wrote none (the
// PR page's Guide tab). A person presses Write, `write` reserves a row under
// the team's daily cap, asks the strong model with the PR's title, description
// and numbered patches (lib/prGuidePrompt), and stores the parsed guide with
// what it cost. The page reads the newest row through `forPr`.

import { v, ConvexError } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalMutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { canAccessPullRequest } from "./lib/access";
import { changeGuideStepValidator } from "./lib/changeGuideValidator";
import { callModelMetered, modelCost } from "./lib/anthropic";
import { PR_GUIDE_MODEL, PR_GUIDE_PROMPT_VERSION, parsePrGuideReply, prGuideRequest, type PrGuideInput } from "./lib/prGuidePrompt";

/** A team's spend on guides over any 24 hours; past it, Write refuses until older guides age out. */
export const PR_GUIDE_DAILY_CAP_USD = 5;
/** A row still "writing" after this long belongs to a call that died; a new write may start. */
export const PR_GUIDE_WRITING_STALE_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const TIMEOUT_MS = 240_000;
/** Attempts read back to find the last finished guide; failures past this many hide it. */
const GUIDE_LOOKBACK = 20;

/**
 * A pull request's guide as the Guide tab shows it: the newest finished guide,
 * and the latest attempt (which may be writing, or have failed, after it), so
 * a rewrite in flight or a failed one never hides the guide already written.
 */
export const forPr = query({
  args: { pr_id: v.id("pull_requests") },
  handler: async (ctx, args): Promise<{ pr_id: Id<"pull_requests">; guide: Doc<"pr_guides"> | null; latest: Doc<"pr_guides"> } | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const pr = await ctx.db.get(args.pr_id);
    if (!pr || !(await canAccessPullRequest(ctx, userId, pr))) return null;
    const rows = ctx.db
      .query("pr_guides")
      .withIndex("by_pr_created", (q) => q.eq("pr_id", args.pr_id))
      .order("desc")
      .take(GUIDE_LOOKBACK);
    let latest: Doc<"pr_guides"> | null = null;
    let guide: Doc<"pr_guides"> | null = null;
    for (const row of await rows) {
      latest ??= row;
      if (row.status === "ready") {
        guide = row;
        break;
      }
    }
    return latest ? { pr_id: args.pr_id, guide, latest } : null;
  },
});

export const begin = internalMutation({
  args: { pr_id: v.id("pull_requests"), user_id: v.id("users") },
  handler: async (ctx, args): Promise<{ guide_id: Id<"pr_guides">; team_id: Id<"teams">; input: PrGuideInput }> => {
    const pr = await ctx.db.get(args.pr_id);
    if (!pr || !(await canAccessPullRequest(ctx, args.user_id, pr))) throw new ConvexError("Pull request not found or access denied.");
    const files = pr.files ?? [];
    if (!files.length) throw new ConvexError("No file changes have been synced for this pull request yet.");
    const now = Date.now();
    const latest = await ctx.db
      .query("pr_guides")
      .withIndex("by_pr_created", (q) => q.eq("pr_id", args.pr_id))
      .order("desc")
      .first();
    if (latest?.status === "writing" && now - latest.created_at < PR_GUIDE_WRITING_STALE_MS) {
      throw new ConvexError("A guide for this pull request is already being written.");
    }
    const recent = await ctx.db
      .query("pr_guides")
      .withIndex("by_team_created", (q) => q.eq("team_id", pr.team_id).gte("created_at", now - DAY_MS))
      .collect();
    const spent = recent.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0);
    if (spent >= PR_GUIDE_DAILY_CAP_USD) {
      throw new ConvexError(`Your team has spent its $${PR_GUIDE_DAILY_CAP_USD} for guides in the last 24 hours.`);
    }
    const guide_id = await ctx.db.insert("pr_guides", {
      pr_id: args.pr_id,
      team_id: pr.team_id,
      ...(pr.head_sha ? { head_sha: pr.head_sha } : {}),
      status: "writing",
      model: PR_GUIDE_MODEL,
      prompt_version: PR_GUIDE_PROMPT_VERSION,
      requested_by: args.user_id,
      created_at: now,
    });
    return {
      guide_id,
      team_id: pr.team_id,
      input: { repository: pr.repository, number: pr.number, title: pr.title, body: pr.body, files },
    };
  },
});

export const finish = internalMutation({
  args: {
    guide_id: v.id("pr_guides"),
    summary: v.optional(v.string()),
    steps: v.optional(v.array(changeGuideStepValidator)),
    error: v.optional(v.string()),
    input_tokens: v.optional(v.number()),
    output_tokens: v.optional(v.number()),
    cost_usd: v.optional(v.number()),
  },
  handler: async (ctx, { guide_id, steps, error, ...rest }): Promise<void> => {
    await ctx.db.patch(guide_id, {
      ...rest,
      ...(steps ? { steps } : {}),
      ...(error ? { error } : {}),
      status: steps && !error ? "ready" : "failed",
      finished_at: Date.now(),
    });
  },
});

/** Write a guide for the pull request now. Resolves once the row is ready or failed; the page reads it through forPr. */
export const write = action({
  args: { pr_id: v.id("pull_requests") },
  handler: async (ctx, args): Promise<void> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Sign in to write a guide.");
    const { guide_id, team_id, input } = await ctx.runMutation(internal.prGuides.begin, { pr_id: args.pr_id, user_id: userId });
    const req = prGuideRequest(input);
    let call;
    try {
      call = await callModelMetered({ ...req, label: "PR guide", timeout_ms: TIMEOUT_MS, gate: { ctx, scope: { workspace: `team:${team_id}` } } });
    } catch (e) {
      await ctx.runMutation(internal.prGuides.finish, { guide_id, error: e instanceof Error ? e.message : String(e) });
      throw new ConvexError("The model call failed. Try again.");
    }
    const usage = call.usage;
    const spend = usage ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cost_usd: modelCost(req.model, usage) } : {};
    if (!call.reply) {
      const error = call.error ?? "the model gave no answer";
      await ctx.runMutation(internal.prGuides.finish, { guide_id, error, ...spend });
      throw new ConvexError(`The guide could not be written: ${error}.`);
    }
    try {
      const guide = parsePrGuideReply(call.reply.text, input.files);
      await ctx.runMutation(internal.prGuides.finish, { guide_id, ...(guide.summary ? { summary: guide.summary } : {}), steps: guide.steps, ...spend });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.prGuides.finish, { guide_id, error, ...spend });
      throw new ConvexError(`The guide could not be written: ${error}.`);
    }
  },
});
